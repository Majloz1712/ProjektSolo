/* eslint-disable no-console */
import { setDefaultResultOrder } from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import PQueue from 'p-queue';
import { JSDOM } from 'jsdom';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import AnonymizeUAPlugin from 'puppeteer-extra-plugin-anonymize-ua';

import { pool } from './polaczeniePG.js';
import { mongoClient } from './polaczenieMDB.js';
import { fetchAndExtract } from '../orchestrator/extractOrchestrator.js';
import { handleNewSnapshot } from './llm/pipelineZmian.js';

setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env') });
console.log('AGENT VERSION: 2.1 clean snapshot');

puppeteer.use(StealthPlugin());
puppeteer.use(AnonymizeUAPlugin({ makeWindows: true }));
// puppeteer.use(StealthPlugin());

const fetchFn = globalThis.fetch ?? (await import('node-fetch')).default;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ===== POLICY (global config) =====
export const POLICY = {
  defaultMode: 'browser',
  staticAllowlist: [
    /(^|\.)amazon\.pl$/i,
    /(^|\.)wikipedia\.org$/i,
  ],
  locale: {
    timezone: 'Europe/Warsaw',
    locale: 'pl-PL',
    geolocation: { lat: 52.2297, lon: 21.0122, accuracy: 50 },
  },
  chrome: {
    // executablePath: '/usr/bin/google-chrome',
    headless: true,
    viewport: { width: 1366, height: 768 },
  },
  session: {
    rootDir: '/var/tmp/agents',
    persistToMongo: true,
  },
  proxy: {
    use: false,
    stickyByMonitor: true,
    pool: [
      '79.110.198.37:8080',
      '45.14.224.247:80',
      '133.232.93.66:80',
      '185.84.162.116:3128',
    ],
  },

  cookieScreenshotOnBlock: true,
};


// ===== browser fingerprint (nagłówki jak zwykły Chrome na Windows) =====
const BROWSER_FINGERPRINT = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',

  platform: 'Win32',
  acceptLanguage: 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',

  secChUa: '"Chromium";v="124", "Not:A-Brand";v="99"',
  secChUaPlatform: '"Windows"',
  secChUaMobile: '?0',
};



// ===== determine-mode (policy-driven) =====
export function determineModeByPolicy(url) {
  const host = new URL(url).hostname;
  if (POLICY.staticAllowlist.some((rx) => rx.test(host))) return 'static';
  return POLICY.defaultMode;
}

// ===== profile path (persistent Chrome profile) =====
export function profilePath({ monitorId, url, rootDir = POLICY.session.rootDir }) {
  const host = new URL(url).hostname.replace(/[:/\\]/g, '_');
  const dir = path.join(rootDir, monitorId, host);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ===== browser launcher =====
function randomViewport() {
  const baseW = 1366;
  const baseH = 768;
  const jitterW = Math.floor(Math.random() * 120) - 60; // +/- 60px
  const jitterH = Math.floor(Math.random() * 120) - 60;
  return {
    width: baseW + jitterW,
    height: baseH + jitterH,
  };
}


export async function launchWithPolicy({ userDataDir, proxyUrl } = {}) {
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--lang=pl-PL',
    '--window-size=1366,768',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
  ];

  if (proxyUrl) {
    args.push(`--proxy-server=${proxyUrl}`);
  }

  return puppeteer.launch({
    headless: POLICY.chrome.headless,
    userDataDir,
    args,
    defaultViewport: randomViewport(),   // <---
    protocolTimeout: 120_000,
  });
}


// ===== page hardening (stealth tweaks) =====
// ===== page hardening (stealth tweaks) =====
export async function hardenPage(page) {
  const client = await page.target().createCDPSession();

  // timezone / locale / geolokacja
  await client.send('Emulation.setTimezoneOverride', { timezoneId: POLICY.locale.timezone });
  await client.send('Emulation.setLocaleOverride', { locale: POLICY.locale.locale });
  await client.send('Emulation.setGeolocationOverride', {
    latitude: POLICY.locale.geolocation.lat,
    longitude: POLICY.locale.geolocation.lon,
    accuracy: POLICY.locale.geolocation.accuracy,
  });

  // user-agent + nagłówki jak przeglądarka
  await page.setUserAgent(BROWSER_FINGERPRINT.userAgent);
  await page.setExtraHTTPHeaders({
    'Accept-Language': BROWSER_FINGERPRINT.acceptLanguage,
    'Upgrade-Insecure-Requests': '1',
    'Sec-CH-UA': BROWSER_FINGERPRINT.secChUa,
    'Sec-CH-UA-Platform': BROWSER_FINGERPRINT.secChUaPlatform,
    'Sec-CH-UA-Mobile': BROWSER_FINGERPRINT.secChUaMobile,
  });

  // drobne poprawki navigatora (na wierzchu stealth pluginu)
  await page.evaluateOnNewDocument((fp) => {
    const override = (obj, prop, value) => {
      try {
        Object.defineProperty(obj, prop, {
          get: () => value,
          configurable: true,
        });
      } catch (_) {}
    };

    override(navigator, 'webdriver', false);
    override(navigator, 'languages', ['pl-PL', 'pl', 'en-US', 'en']);
    override(navigator, 'platform', fp.platform);
    override(navigator, 'userAgent', fp.userAgent);
    override(navigator, 'hardwareConcurrency', 8);
    override(navigator, 'deviceMemory', 8);

    // proste "plugins" żeby nie było pustej listy
    override(navigator, 'plugins', [1, 2, 3]);

    // lekki patch permissions, żeby nie sypało „denied” dla notifications
    const origQuery = window.navigator.permissions?.query;
    if (origQuery) {
      window.navigator.permissions.query = (parameters) => (
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: 'prompt' })
          : origQuery(parameters)
      );
    }
  }, BROWSER_FINGERPRINT);
}

export async function restoreSession(page, mongoDb, { monitorId, origin }) {
  if (!mongoDb || POLICY.session.persistToMongo === false) return;

  const session = await mongoDb.collection('sessions').findOne({ monitorId, origin });
  if (!session) return;

  const client = await page.target().createCDPSession();
  await client.send('Network.enable');

  for (const cookie of session.cookies || []) {
    try {
      // upewniamy się, że path istnieje
      await client.send('Network.setCookie', { ...cookie, path: cookie.path || '/' });
    } catch (_) {
      // ignoruj pojedyncze błędy ciasteczek
    }
  }

  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20_000 });

  if (session.localStorage && Object.keys(session.localStorage).length) {
    await page.evaluate((ls) => {
      Object.entries(ls).forEach(([k, v]) => {
        localStorage.setItem(k, v);
      });
    }, session.localStorage);
  }
}

export async function persistSession(page, mongoDb, { monitorId, origin }) {
  if (!mongoDb || POLICY.session.persistToMongo === false) return;
  const cdp = await page.target().createCDPSession();
  const { cookies } = await cdp.send('Network.getAllCookies');
  const localStorage = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      out[key] = localStorage.getItem(key);
    }
    return out;
  });
  await mongoDb.collection('sessions').updateOne(
    { monitorId, origin },
    { $set: { cookies, localStorage, updatedAt: new Date() } },
    { upsert: true },
  );
}

// ===== cookie consent (main frame + iframes) =====
export async function handleCookieConsent(page) {
  const labels = ['ok, zgadzam się', 'zgadzam', 'akceptuj'];
  const clickAny = async (ctx) => ctx.evaluate((texts) => {
    const lower = (s) => (s || '').toLowerCase();
    const elements = Array.from(document.querySelectorAll('button,[role="button"],a'));
    // eslint-disable-next-line no-restricted-syntax
    for (const el of elements) {
      const text = lower(el.innerText || el.textContent || '');
      if (texts.some((needle) => text.includes(needle))) {
        el.click();
        return true;
      }
    }
    return false;
  }, labels);

  if (await clickAny(page)) {
    await sleep(400);
    return true;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const frame of page.frames()) {
    try {
      if (frame === page.mainFrame()) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await clickAny(frame)) {
        await sleep(400);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function humanize(page) {
  const steps = 2 + Math.floor(Math.random() * 2);

  // losowe pozycje myszy
  await page.mouse.move(
    200 + Math.random() * 400,
    150 + Math.random() * 300,
    { steps: 5 },
  );

  for (let i = 0; i < steps; i += 1) {
    await sleep(300 + Math.random() * 400);
    await page.mouse.wheel({ deltaY: 250 + Math.random() * 300 });
  }
}


async function waitForAny(page, selectors, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-restricted-syntax
    for (const selector of selectors) {
      // eslint-disable-next-line no-await-in-loop
      if (await page.$(selector)) return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }
  return false;
}

function detectBotProtection(html) {
  if (!html) return false;

  const patterns = [
    // klasyczne WAF / bot protection
    /JavaScript is disabled/i,
    /verify that you'?re not a robot/i,
    /AwsWafIntegration/i,
    /__challenge_/i,
    /window\.awsWafCookieDomainList/i,

    // strony wymagające włączenia JavaScript (również PL)
    /enable javascript/i,
    /please enable javascript/i,
    /this (site|page) requires javascript/i,
    /to use this (site|page),? (you )?must enable javascript/i,

    /włącz javascript/i,
    /wlacz javascript/i,
    /aktywuj javascript/i,
    /ta strona wymaga javascript/i,
    /strona wymaga włączenia javascript/i,
  ];

  return patterns.some((re) => re.test(html));
}



export async function runBrowserFlow({ browser, url, mongoDb, monitorId, takeScreenshot = false }) {
  const page = await browser.newPage();
  await hardenPage(page);

  const origin = new URL(url).origin;

  await restoreSession(page, mongoDb, { monitorId, origin });

  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await handleCookieConsent(page);
  await humanize(page);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await handleCookieConsent(page);

  const ok = await waitForAny(
    page,
    [
      'meta[property="og:type"]',
      '[itemtype*="schema.org/Product"]',
      '[data-testid*="price"], [data-role*="price"]',
      'h1',
    ],
    9000,
  );

  const html = await page.content();

  // dodatkowa detekcja WAF/challenge
  const wafBlocked = detectBotProtection(html);
  const effectiveOk = ok && !wafBlocked;

  const screenshot = takeScreenshot
    ? await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false })
    : null;

  // 🔎 HEURYSTYKA CENY Z DOM (POPRAWIONA)
  const domPriceText = await page.evaluate(() => {
    const currencyRe = /(zł|pln|eur|€|usd|\$|£)/i;
    const priceWithCurrRe = /(\d[\d\s.,]*\d?)\s*(zł|pln|eur|€|usd|\$|£)/i;
    const numberRe = /(\d[\d\s.,]*\d?)/;

    // 0) NAJPIERW: szukamy "1234 zł" w CAŁYM tekście strony
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const globalMatch = bodyText.match(priceWithCurrRe);
    if (globalMatch) {
      // np. "968 zł"
      return globalMatch[0];
    }

    const candidates = [];

    const addCandidate = (el, reason, opts = {}) => {
      const { requireCurrency = true } = opts;
      if (!el) return;
      const raw = el.textContent || '';
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!text) return;

      if (requireCurrency && !currencyRe.test(text)) return;
      if (!priceWithCurrRe.test(text) && !numberRe.test(text)) return;

      let score = 0;
      const t = text.toLowerCase();
      const cls = (el.className || '').toLowerCase();
      const id = (el.id || '').toLowerCase();

      if (cls.includes('price') || id.includes('price')) score += 3;
      if (cls.includes('amount') || cls.includes('total')) score += 1;
      if (t.includes('noc') || t.includes('night') || t.includes('pobyt')) score += 1;

      const len = text.length;
      if (len < 8) score += 1;
      if (len > 120) score -= 1;

      // Jeżeli nie ma waluty, ale wygląda jak "cena" – trochę podbijamy
      if (!currencyRe.test(text) && (cls.includes('price') || id.includes('price'))) {
        score += 1;
      }

      // ⚠️ Karzemy rzeczy typu "Personel 9,0", "Czystość 9,0" (to nie ceny)
      if (/personel|czystość|komfort|lokalizacja|wifi|udogodnienia/i.test(t)) {
        score -= 3;
      }

      candidates.push({ text, score, reason });
    };

    // 1) „mocne” selektory – waluta NIE jest wymagana
    const strongSelectors = [
      '[itemprop="price"]',
      '[data-testid*="price"]',
      '[class*="price"]',
      '[id*="price"]',
      '[aria-label*="price"]',
      '[aria-label*="cena"]',
      '[class*="prco-"]',               // Booking
      '[class*="bui-price-display"]',   // Booking – box z ceną
      '[class*="hprt-price"]',          // Booking – tabela pokoi
    ];
    strongSelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => addCandidate(el, `selector:${sel}`, { requireCurrency: false }));
    });

    // 2) fallback po elementach – wymagamy waluty
    if (!candidates.length) {
      const all = Array.from(document.querySelectorAll('span,div,strong,b,p'));
      for (const el of all) {
        const raw = el.textContent || '';
        const text = raw.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (text.length < 4 || text.length > 120) continue;
        if (!currencyRe.test(text)) continue;
        addCandidate(el, 'fallback_generic', { requireCurrency: true });
      }
    }

    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0].text;
    }

    // nic nie znaleziono
    return null;
  });

  const finalUrl = page.url();

  await persistSession(page, mongoDb, { monitorId, origin });
  await page.close();

  return { ok: effectiveOk, html, screenshot, finalUrl, domPriceText };
}





async function runCookieScreenshotFlow({ monitorId, url, mongoDb }) {
  let db = mongoDb;
  if (!db) {
    db = await ensureMongo();
  }
  const userDataDir = profilePath({ monitorId, url });
  const proxyUrl = pickProxy(monitorId);
  let browser;
  try {
    browser = await launchWithPolicy({ userDataDir, proxyUrl });
const { screenshot } = await runBrowserFlow({
  browser,
  url,
  mongoDb: db,
  monitorId,
  takeScreenshot: true,
});
    if (screenshot) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safeMonitorId = monitorId || 'unknown';
      const screenshotsDir = path.join(__dirname, 'logs', 'screenshots');
      await fs.promises.mkdir(screenshotsDir, { recursive: true });
      const filePath = path.join(screenshotsDir, `${safeMonitorId}-${ts}.jpeg`);
      await fs.promises.writeFile(filePath, screenshot);
      console.log('[cookie-shot] screenshot saved', filePath);
    }
  } catch (err) {
    console.warn('[cookie-shot] failed', err?.message || err);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ===== proxy picker (sticky by monitor) =====
export function pickProxy(monitorId) {
  if (!POLICY.proxy.use || !POLICY.proxy.pool?.length) return null;
  if (!POLICY.proxy.stickyByMonitor) {
    return POLICY.proxy.pool[Math.floor(Math.random() * POLICY.proxy.pool.length)];
  }
  const idx = Math.abs(hashString(monitorId)) % POLICY.proxy.pool.length;
  return POLICY.proxy.pool[idx];
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

const LOOP_MS = Number(process.env.AGENT_LOOP_MS || 5_000);
const SCHEDULE_BATCH_LIMIT = Number(process.env.SCHEDULE_BATCH_LIMIT || 200);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 3);
const STATIC_TIMEOUT_MS = Number(process.env.STATIC_TIMEOUT_MS || 20_000);
const TEXT_TRUNCATE_AT = Number(process.env.TEXT_TRUNCATE_AT || 2_000_000);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

async function ensureMongo() {
  const dbName = process.env.MONGO_DB || 'inzynierka';
  if (mongoClient.topology?.isConnected?.()) {
    return mongoClient.db(dbName);
  }
  await mongoClient.connect();
  return mongoClient.db(dbName);
}


async function saveSnapshotToMongo(doc) {
  const db = await ensureMongo();
  const collection = db.collection('snapshots');
  const { insertedId } = await collection.insertOne(doc);
  return insertedId?.toString() ?? null;
}



async function clearMongoSnapshots() {
  const db = await ensureMongo();
  await db.collection('snapshots').deleteMany({});
  console.log('[mongo] snapshots cleared');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = STATIC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function scanStatic({ url, selector }) {
  // prosty timeout na wypadek wiszącego requestu
  const controller = new AbortController();
  const timeoutMs = 15000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchFn(url, {
      redirect: 'follow',
      signal: controller.signal,
          headers: {
      'user-agent': BROWSER_FINGERPRINT.userAgent,
      'accept-language': BROWSER_FINGERPRINT.acceptLanguage,
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,' +
        'image/avif,image/webp,image/apng,*/*;q=0.8,' +
        'application/signed-exchange;v=b3;q=0.7',
      'upgrade-insecure-requests': '1',
      'sec-ch-ua': BROWSER_FINGERPRINT.secChUa,
      'sec-ch-ua-platform': BROWSER_FINGERPRINT.secChUaPlatform,
      'sec-ch-ua-mobile': BROWSER_FINGERPRINT.secChUaMobile,
    },

    });
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  const finalUrl = response.url || url;

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('text/html')) {
    return {
      ok: false,
      status,
      html: null,
      finalUrl,
      meta: null,
    };
  }

const buffer = await response.arrayBuffer();
const content = Buffer.from(buffer).toString('utf8');

// używamy tej samej logiki co w trybie browser
const isChallenge = detectBotProtection(content);

const ok = status >= 200 && status < 400 && !isChallenge;

if (isChallenge) {
  console.log('[static] detected WAF/challenge or JS-required page, static ok=false');
}


  let meta = null;
  try {
    const dom = new JSDOM(content, { url: finalUrl });
    meta = pickMetaFromDocument(dom.window.document);
  } catch {
    meta = null;
  }

  return {
    ok,
    status,
    html: content,
    finalUrl,
    meta,
  };
}




function pickMetaFromDocument(document) {
  const byName = (n) => document.querySelector(`meta[name="${n}"]`)?.getAttribute('content')?.trim() || null;
  const byProp = (p) => document.querySelector(`meta[property="${p}"]`)?.getAttribute('content')?.trim() || null;
  const title = document.querySelector('title')?.textContent?.trim() || null;
  const desc = byName('description') || byProp('og:description') || null;
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || null;
  const h1 = document.querySelector('h1')?.textContent?.trim() || null;
  const linksCount = document.querySelectorAll('a[href]').length;
  const textLen = document.body?.innerText?.length || 0;
  return {
    title, desc, canonical, h1, linksCount, textLen,
  };
}

async function withPg(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// ===== plugin tasks helper (3-ci tryb) =====

// Dodawanie zadania dla pluginu (fallback / price_only)
async function createPluginTask({
  monitorId,
  taskId,
  url,
  mode = 'fallback', // 'fallback' | 'price_only'
}) {
  if (!monitorId || !taskId || !url) return;

  await withPg(async (pg) => {
    await pg.query(
      `INSERT INTO plugin_tasks (monitor_id, zadanie_id, url, status, mode)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [monitorId, taskId, url, mode],
    );
  });

  console.log(
    `[plugin-task] created mode=${mode} monitor=${monitorId} zadanie=${taskId} url=${url}`,
  );
}



async function updateMonitorScanMode(monitorId, mode) {
  if (!monitorId) return;
  if (!['static', 'browser', 'plugin'].includes(mode)) return;

  try {
    await withPg(async (pg) => {
      await pg.query(
        'UPDATE monitory SET tryb_skanu = $2 WHERE id = $1',
        [monitorId, mode],
      );
    });
  } catch (err) {
    console.warn('[monitor] update tryb_skanu failed', err?.message || err);
  }
}


async function scheduleMonitorDue(monitorId) {
  if (!isUuid(monitorId)) throw new Error('INVALID_MONITOR_ID');
  return withPg(async (pg) => {
    await pg.query('BEGIN');
    try {
      const { rowCount } = await pg.query(
        `INSERT INTO zadania_skanu (id, monitor_id, zaplanowano_at, status)
         VALUES (gen_random_uuid(), $1::uuid, NOW(), 'oczekuje')`,
        [monitorId],
      );
      await pg.query('COMMIT');
      return rowCount || 0;
    } catch (err) {
      await pg.query('ROLLBACK');
      throw err;
    }
  });
}

async function scheduleBatch() {
  return withPg(async (pg) => {
    const { rows } = await pg.query(
      `INSERT INTO zadania_skanu (id, monitor_id, zaplanowano_at, status)
         SELECT gen_random_uuid(), m.id, NOW(), 'oczekuje'
         FROM monitory m
         WHERE m.aktywny = true
           AND NOT EXISTS (
             SELECT 1
             FROM zadania_skanu z
             WHERE z.monitor_id = m.id
               AND z.status IN ('oczekuje', 'w_trakcie')
           )
           AND (
             SELECT COALESCE(MAX(z.zaplanowano_at), m.utworzono_at)
             FROM zadania_skanu z
             WHERE z.monitor_id = m.id
           ) + make_interval(secs => m.interwal_sec) <= NOW()
         ORDER BY m.utworzono_at ASC
         LIMIT $1
         RETURNING id`,
      [SCHEDULE_BATCH_LIMIT],
    );
    return rows.length;
  });
}

async function loadPendingTasks(limit = MAX_CONCURRENCY) {
  return withPg(async (pg) => {
    const { rows } = await pg.query(
      `UPDATE zadania_skanu
          SET status = 'w_trakcie',
              rozpoczecie_at = NOW()
        WHERE id IN (
          SELECT id
          FROM zadania_skanu
          WHERE status = 'oczekuje'
          ORDER BY zaplanowano_at ASC
          LIMIT $1
        )
        RETURNING *`,
      [limit],
    );
    return rows;
  });
}

async function loadPendingTasksForMonitor(monitorId, limit = MAX_CONCURRENCY) {
  return withPg(async (pg) => {
    const { rows } = await pg.query(
      `UPDATE zadania_skanu
          SET status = 'w_trakcie',
              rozpoczecie_at = NOW()
        WHERE id IN (
          SELECT id
          FROM zadania_skanu
          WHERE status = 'oczekuje'
            AND monitor_id = $1
          ORDER BY zaplanowano_at ASC
          LIMIT $2
        )
        RETURNING *`,
      [monitorId, limit],
    );
    return rows;
  });
}

async function loadMonitor(pg, monitorId) {
  const { rows } = await pg.query(
    `SELECT id, uzytkownik_id, nazwa, url, llm_prompt, interwal_sec, aktywny, utworzono_at, tryb_skanu, css_selector
       FROM monitory
       WHERE id = $1`,
    [monitorId],
  );
  if (!rows.length) return null;
  return rows[0];
}

function isPriceMissing(extracted) {
  if (!extracted) return true;
  if (extracted.price === undefined || extracted.price === null || extracted.price === '') {
    return true;
  }
  // w przyszłości możesz tu dodać np. extracted.attributes.price itp.
  return false;
}

// Na podstawie llm_prompt monitora sprawdzamy,
// czy użytkownik oczekuje monitorowania CENY.
function wantsPricePlugin(monitor) {
  const prompt = (monitor.llm_prompt || '').toString();

  // szukamy słowa "cena" lub "price" jako osobnego słowa (case-insensitive)
  if (/\bcena\b/i.test(prompt)) return true;
  if (/\bprice\b/i.test(prompt)) return true;

  return false;
}


async function finishTask(taskId, {
  status, blad_opis, tresc_hash, snapshot_mongo_id,
}) {
  await withPg(async (pg) => {
    await pg.query(
      `UPDATE zadania_skanu
          SET status = $2,
              zakonczenie_at = NOW(),
              blad_opis = $3,
              tresc_hash = $4,
              snapshot_mongo_id = $5
        WHERE id = $1`,
      [taskId, status, blad_opis || null, tresc_hash || null, snapshot_mongo_id || null],
    );
  });
}


async function markMonitorRequiresIntervention(monitorId, { reason, snapshotId } = {}) {
  if (!monitorId) return;

  try {
    await withPg(async (pg) => {
      // ustaw status monitora
      await pg.query(
        `UPDATE monitory
           SET status = 'wymaga_interwencji',
               aktywny = false
         WHERE id = $1`,
        [monitorId],
      );

      // treść powiadomienia
      const message = snapshotId
        ? `Monitor wymaga interwencji: ${reason || 'BOT_PROTECTION'} (snapshot: ${snapshotId})`
        : `Monitor wymaga interwencji: ${reason || 'BOT_PROTECTION'}`;

      // zapis powiadomienia
      await pg.query(
        `INSERT INTO powiadomienia (id, monitor_id, tresc, utworzone_at)
           VALUES (gen_random_uuid(), $1, $2, NOW())`,
        [monitorId, message],
      );
    });
  } catch (err) {
    console.warn('[intervention] failed to persist status', err?.message || err);
  }
}


const browserPool = new Map(); // key: userDataDir / monitorId / proxy

async function getBrowser({ userDataDir, proxyUrl }) {
  const key = `${userDataDir || 'default'}|${proxyUrl || 'none'}`;
  const existing = browserPool.get(key);
  if (existing && existing.isConnected()) return existing;

  const browser = await launchWithPolicy({ userDataDir, proxyUrl });
  browserPool.set(key, browser);
  return browser;
}

async function closeAllBrowsers() {
  for (const br of browserPool.values()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await br.close();
    } catch (_) {}
  }
  browserPool.clear();
}


const queue = new PQueue({ concurrency: MAX_CONCURRENCY });

async function processTask(task) {
  const { id: taskId, monitor_id: monitorId } = task;
  console.log(`[task] start monitor=${monitorId} task=${taskId}`);

  if (!isUuid(taskId) || !isUuid(monitorId)) {
    await finishTask(taskId, {
      status: 'blad',
      blad_opis: 'INVALID_IDS',
      tresc_hash: null,
      snapshot_mongo_id: null,
    });
    return;
  }

  let monitor;
  try {
    monitor = await withPg((pg) => loadMonitor(pg, monitorId));
  } catch (err) {
    console.error('[task] load monitor failed', err);
  }

  if (!monitor) {
    await finishTask(taskId, {
      status: 'blad',
      blad_opis: 'MONITOR_NOT_FOUND',
      tresc_hash: null,
      snapshot_mongo_id: null,
    });
    return;
  }

  const targetUrl = normalizeUrl(monitor.url);
  const selector = parseSelector(monitor.css_selector);
  const mongoDb = await ensureMongo();

  // Czy użytkownik ewidentnie oczekuje ceny? (llm_prompt zawiera "cena"/"price")
  const monitorWantsPrice = wantsPricePlugin(monitor);

  let snapshot = null;
  let blocked = false;
  let finalUrl = targetUrl;
  let html = '';
  let meta = null;
  let status = null;
  let screenshotB64 = null;

  // tryb, który faktycznie użyliśmy
  let mode = 'static';

  try {
    // ===== 1) PROBA STATYCZNA =====
    let staticResult = null;

    try {
  staticResult = await scanStatic({ url: targetUrl, selector });
  status = staticResult.status;
  finalUrl = staticResult.finalUrl;
  html = staticResult.html;
  meta = staticResult.meta;

      // ⛔ NIE ustawiamy blocked na podstawie staticResult.ok
      // staticResult.ok == false oznacza tylko: "static się nie udał"
      // blocked === true oznacza: "browser też nie dał rady"
      // blocked ustawiamy dopiero PO browserze
    } catch (err) {
      console.warn('[task] static scan failed (exception)', err?.message || err);
      // Static całkowicie padł → nie ma co przedłużać, browser i tak będzie konieczny
    }


    const needBrowserFallback =
      !staticResult
      || !staticResult.ok
      || !html
      || (typeof status === 'number' && status >= 400);

    // ===== 2) FALLBACK DO BROWSER (PUPPETEER) =====
    if (needBrowserFallback) {
      blocked = false; // reset – dajemy szansę trybowi browser
      mode = 'browser';

      const userDataDir = profilePath({ monitorId, url: targetUrl });
    const proxyUrl = pickProxy(monitorId);
    const browser = await getBrowser({ userDataDir, proxyUrl });

    const {
      ok,
      html: browserHtml,
      screenshot,
      finalUrl: browserFinalUrl,
    } = await runBrowserFlow({
      browser,
      url: targetUrl,
      mongoDb,
      monitorId,
    });

    blocked = !ok;
    html = browserHtml;
    finalUrl = browserFinalUrl;
    status = ok ? (status || 200) : (status || 403);
    screenshotB64 = screenshot ? Buffer.from(screenshot).toString('base64') : null;

    } else {
      // statyczny scan był OK
      mode = 'static';
    }
  } catch (err) {
    console.error('[task] scan failed', err);
    await finishTask(taskId, {
      status: 'blad',
      blad_opis: (err?.message || String(err)).slice(0, 500),
      tresc_hash: null,
      snapshot_mongo_id: null,
    });
    return;
  }

  // ===== 2.5) TOTALNA PORAŻKA HTML/BLOKADA → tryb plugin Fallback =====
  // Uwaga:
  //  - dla monitorów nastawionych na CENĘ (llm_prompt zawiera "cena"/"price")
  //    nie używamy trybu "fallback" – zamiast tego później tworzymy zadanie
  //    pluginu w trybie "price_only", które dorzuci ceny do najnowszego snapshota.
  //  - tryb "fallback" zostaje tylko dla monitorów, które NIE są cenowe.
  if (!monitorWantsPrice && (!html || blocked)) {
    // utwórz zadanie dla pluginu w trybie "fallback" (screenshot, pełna strona)
    await createPluginTask({
      monitorId,
      taskId,
      // używamy zawsze oryginalnego URL-a monitora (pełny link z parametrami)
      url: targetUrl,
      mode: 'fallback',
    });

    await markMonitorRequiresIntervention(monitorId, {
      reason: 'PLUGIN_SCREENSHOT_REQUIRED',
      snapshotId: snapshot || null,
    });

    await finishTask(taskId, {
      status: 'blad',
      blad_opis: 'WAITING_FOR_PLUGIN_SCREENSHOT',
      tresc_hash: null,
      snapshot_mongo_id: snapshot || null,
    });

    console.log(`[task] monitor=${monitorId} -> przekazany do pluginu (fallback)`);
    return;
  }


  // ===== 3) EKSTRAKCJA LLM =====
  let extracted = null;
  try {
 extracted = await fetchAndExtract(finalUrl, {
  render: false,
  correlationId: `task-${taskId}`,
  html, // <--- KLUCZOWE: dajemy mu HTML z browsera
});

  } catch (err) {
    console.warn('[task] extract orchestrator failed', err);
  }

  const hash = html ? sha256(html) : null;

const snapshotDoc = {
  monitor_id: monitorId,
  zadanie_id: taskId,       // <<< TO MUSI BYĆ
  url: targetUrl,
  ts: new Date(),
  mode,
  final_url: finalUrl,
  blocked,
  block_reason: blocked ? 'BOT_PROTECTION' : null,
  screenshot_b64: screenshotB64,
  extracted_v2: extracted || null,
};



  try {
    snapshot = await saveSnapshotToMongo(snapshotDoc);
    console.log(`[task] snapshot stored id=${snapshot}`);
  } catch (err) {
    console.error('[task] snapshot save failed', err);
  }

  // ===== 3.5) BOT PROTECTION mimo wszystko (np. challenge HTML) =====
  // ===== 3.5) BOT PROTECTION mimo wszystko (np. challenge HTML) =====
if (blocked && !monitorWantsPrice) {
  if (
    POLICY.cookieScreenshotOnBlock
    && mode === 'static'
    && typeof status === 'number'
    && (status === 403 || status === 429)
  ) {
    try {
      await runCookieScreenshotFlow({
        monitorId,
        url: finalUrl || targetUrl,
        mongoDb,
      });
    } catch (err) {
      console.warn('[task] cookie screenshot flow failed', err?.message || err);
    }
  }

  await markMonitorRequiresIntervention(monitorId, { reason: 'BOT_PROTECTION', snapshotId: snapshot });
  await finishTask(taskId, {
    status: 'blad',
    blad_opis: 'BOT_PROTECTION',
    tresc_hash: null,
    snapshot_mongo_id: snapshot,
  });
  return;
}


// ===== 4) PRICE-ONLY: brak ceny, ale user w promptcie zaznaczył "CENA" =====
  // Dla monitorów, które w promptcie mają słowo "cena" lub "price",
  // jeśli po całym flow (static + browser + extract) dalej NIE mamy ceny,
  // tworzymy zadanie pluginu w trybie "price_only". Plugin dorzuci wtedy
  // tablicę wszystkich znalezionych cen do najnowszego snapshota.
  const shouldCreatePriceOnlyTask =
    monitorWantsPrice
    && isPriceMissing(extracted);

  if (shouldCreatePriceOnlyTask) {
    try {
      await createPluginTask({
        monitorId,
        taskId,
        // zawsze podajemy pełny URL z monitora
        url: targetUrl,
        mode: 'price_only',
      });
      console.log(
        `[task] monitor=${monitorId} task=${taskId} -> plugin_task(mode=price_only) created (missing price, llm_prompt wants price)`,
      );
    } catch (err) {
      console.warn('[task] failed to create price_only plugin task', err?.message || err);
    }
  }
    if (!shouldCreatePriceOnlyTask && snapshot) {
    handleNewSnapshot(snapshot).catch((err) => {
      console.error('[task] Błąd pipelineZmian dla snapshotu:', snapshot, err);
    });
  }


  // ===== 5) SKAN UDANY – ZAPISZ UŻYTY TRYB W "monitory.tryb_skanu" =====
  await updateMonitorScanMode(monitorId, mode);

  await finishTask(taskId, {
    status: 'ok',
    blad_opis: null,
    tresc_hash: hash,
    snapshot_mongo_id: snapshot,
  });

  console.log(`[task] done monitor=${monitorId} status=${status} mode=${mode}`);
}


function buildCleanSnapshot({
  extracted,
  monitorId,
  targetUrl,
  finalUrl,
  mode,
  blocked,
  screenshotB64,
  hash,
  domPriceText,
}) {
  // 1) baza z extractora
  let price = extracted?.price || null;
  let currency = extracted?.currency || null;

  // 2) fallback: jeśli extractor nie znalazł ceny, spróbujmy z domPriceText
  if (!price && domPriceText) {
    const text = domPriceText.trim();

    const currencyRe = /(zł|pln|eur|€|usd|\$|£)/i;
    const priceWithCurrRe = /(\d[\d\s.,]*\d?)\s*(zł|pln|eur|€|usd|\$|£)/i;
    const numberRe = /(\d[\d\s.,]*\d?)/;

    const withCurr = text.match(priceWithCurrRe);
    if (withCurr) {
      const valuePart = withCurr[1].trim();
      const currPart = withCurr[2].trim().toLowerCase();

      price = `${valuePart} ${withCurr[2].trim()}`;

      if (currPart.includes('zł') || currPart === 'pln') currency = 'PLN';
      else if (currPart.includes('eur') || currPart === '€') currency = 'EUR';
      else if (currPart.includes('usd') || currPart === '$') currency = 'USD';
      else if (currPart.includes('£')) currency = 'GBP';
    } else {
      // brak waluty – weźmy samą liczbę (np. "9 876" z widgetu Booking)
      const num = text.match(numberRe);
      if (num) {
        price = num[1].trim();
        // currency zostaje null – LLM sobie poradzi, że to "cena bez waluty"
      }
    }
  }

  const clean = {
    monitor_id: monitorId,
    url: targetUrl,
    final_url: finalUrl,
    ts: new Date(),
    mode,
    blocked: !!blocked,
    block_reason: blocked ? (extracted?.block_reason || 'BOT_PROTECTION') : null,
    screenshot_b64: blocked ? screenshotB64 || null : null,
    hash,

    title: extracted?.title || null,
    description: extracted?.description || null,
    text: extracted?.text || null,
    content_type: extracted?.contentType || null,

    price: price || null,
    currency: currency || null,

    images: Array.isArray(extracted?.images) ? extracted.images.slice(0, 10) : [],
    attributes: extracted?.attributes || {},

    extractor: extracted?.extractor || null,
    confidence: extracted?.confidence || null,

    html_truncated: null,

    // do debugowania – surowy tekst ceny z DOM
    price_dom_text: domPriceText || null,
  };

  return clean;
}





function parseSelector(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  return trimmed;
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch (_) {
    return raw;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}


function extractPlainTextFromHtml(html) {
  if (!html) return null;
  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    if (!doc || !doc.body) return null;

    // bierzemy tekst z body
    let text = doc.body.textContent || '';

    // normalizacja białych znaków
    text = text.replace(/\s+/g, ' ').trim();

    // globalne przycięcie, żeby nie mieć kilkuset KB
    const MAX_LEN = 20000; // ~20k znaków wystarczy pod LLM-a
    if (text.length > MAX_LEN) {
      text = text.slice(0, MAX_LEN);
    }

    return text || null;
  } catch {
    return null;
  }
}




async function runExecutionCycle(singleMonitorId) {
  let tasks = [];

  if (singleMonitorId) {
    const inserted = await scheduleMonitorDue(singleMonitorId);
    console.log(`[plan] scheduled ${inserted} tasks (single monitor)`);

    tasks = await loadPendingTasksForMonitor(singleMonitorId, MAX_CONCURRENCY);
  } else {
    const scheduled = await scheduleBatch();
    console.log(`[plan] scheduled ${scheduled} tasks`);

    tasks = await loadPendingTasks(MAX_CONCURRENCY);
  }

  console.log(`[plan] picked ${tasks.length} tasks`);

  tasks.forEach((t) => {
    queue.add(() => processTask(t));
  });

  await queue.onIdle();
}

async function main() {
  const monitorId = process.argv.includes('--monitor-id')
    ? process.argv[process.argv.indexOf('--monitor-id') + 1]
    : null;
  const once = process.argv.includes('--once');
  const clearSnapshots = process.argv.includes('--clear-snapshots');

  if (clearSnapshots) {
    await clearMongoSnapshots();
    return;
  }

  if (monitorId && !isUuid(monitorId)) {
    console.error('Invalid monitor id');
    process.exit(1);
  }

  if (once) {
    await runExecutionCycle(monitorId);
    return;
  }

  console.log(`[loop] running every ${LOOP_MS} ms`);
  await runExecutionCycle(monitorId);
  setInterval(() => {
    runExecutionCycle(monitorId).catch((err) => {
      console.error('[loop] cycle error', err);
    });
  }, LOOP_MS);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

