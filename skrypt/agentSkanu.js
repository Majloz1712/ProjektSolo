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

import { pool } from './polaczeniePG.js';
import { mongoClient } from './polaczenieMDB.js';
import { fetchAndExtract } from '../orchestrator/extractOrchestrator.js';

setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env') });

puppeteer.use(StealthPlugin());

const fetchFn = globalThis.fetch ?? (await import('node-fetch')).default;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ===== POLICY (global config) =====
export const POLICY = {
  defaultMode: 'browser',
  staticAllowlist: [
    /(^|\.)amazon\.pl$/i,
    /(^|\.)wikipedia\.org$/i,
  ],
  cookieScreenshotOnBlock: true,
  locale: {
    timezone: 'Europe/Warsaw',
    locale: 'pl-PL',
    geolocation: { lat: 52.2297, lon: 21.0122, accuracy: 50 },
  },
  chrome: {
    executablePath: '/usr/bin/google-chrome',
    headless: false,
    viewport: { width: 1366, height: 768 },
  },
  session: {
    rootDir: '/var/tmp/agents',
    persistToMongo: true,
  },
  proxy: {
    use: false,
    stickyByMonitor: true,
    pool: [],
  },
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
export async function launchWithPolicy({ userDataDir, proxyUrl } = {}) {
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--lang=pl-PL',
    '--window-size=1366,768',
    '--disable-blink-features=AutomationControlled',
  ];
  if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);

  return puppeteer.launch({
    headless: POLICY.chrome.headless,
    executablePath: POLICY.chrome.executablePath,
    userDataDir,
    args,
    defaultViewport: POLICY.chrome.viewport,
  });
}

// ===== harden page =====
export async function hardenPage(page) {
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  );
  await page.setExtraHTTPHeaders({
    'accept-language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
    'sec-ch-ua': '"Chromium";v="127", "Google Chrome";v="127", "Not:A-Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  });

  const client = await page.target().createCDPSession();
  await client.send('Emulation.setTimezoneOverride', { timezoneId: POLICY.locale.timezone });
  await client.send('Emulation.setLocaleOverride', { locale: POLICY.locale.locale });
  await client.send('Emulation.setGeolocationOverride', {
    latitude: POLICY.locale.geolocation.lat,
    longitude: POLICY.locale.geolocation.lon,
    accuracy: POLICY.locale.geolocation.accuracy,
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['pl-PL', 'pl', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
  });
}

// ===== session persistence (Mongo) =====
export async function restoreSession(page, mongoDb, { monitorId, origin }) {
  if (!mongoDb || POLICY.session.persistToMongo === false) return;
  const session = await mongoDb.collection('sessions').findOne({ monitorId, origin });
  if (!session) return;

  const cdp = await page.target().createCDPSession();
  for (const cookie of session.cookies || []) {
    try {
      await cdp.send('Network.setCookie', { ...cookie, path: cookie.path || '/' });
    } catch (_) {}
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
    await page.waitForTimeout(400);
    return true;
  }

  for (const frame of page.frames()) {
    try {
      if (frame === page.mainFrame()) continue;
      if (await clickAny(frame)) {
        await page.waitForTimeout(400);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function clickCookieBannerIfPresent(page, logger) {
  const selectors = ['button', 'div[role="button"]', 'button[aria-label]'];
  const keywords = [
    'zgadzam się',
    'zgadzam',
    'akceptuję',
    'akceptuj',
    'akceptacja',
    'accept',
    'i agree',
    'agree',
  ];
  try {
    await sleep(1_000 + Math.random() * 1_000);
    const elements = await page.$$(selectors.join(','));
    for (const element of elements) {
      const label = await element.evaluate((el) => {
        const text = (el.innerText || el.textContent || '').trim();
        const aria = (el.getAttribute('aria-label') || '').trim();
        return text || aria;
      });
      if (!label) continue;
      const normalized = label.toLowerCase();
      if (!keywords.some((kw) => normalized.includes(kw))) continue;
      await element.click({ delay: 120 + Math.floor(Math.random() * 120) }).catch(() => {});
      await sleep(1_000 + Math.random() * 1_000);
      logger?.info?.('cookie_click', { clicked: true, label });
      console.log('[cookie] clicked consent button');
      return true;
    }
  } catch (err) {
    logger?.warn?.('cookie_click_failed', { error: err?.message || String(err) });
  }
  return false;
}

async function humanize(page) {
  const steps = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < steps; i += 1) {
    await page.waitForTimeout(300 + Math.random() * 400);
    await page.mouse.wheel({ deltaY: 250 + Math.random() * 300 });
  }
}

async function waitForAny(page, selectors, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const selector of selectors) {
      if (await page.$(selector)) return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

export async function runBrowserFlow({ browser, url, mongoDb, monitorId }) {
  const page = await browser.newPage();
  await hardenPage(page);

  const origin = new URL(url).origin;

  await restoreSession(page, mongoDb, { monitorId, origin });

  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await handleCookieConsent(page);
  await humanize(page);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await handleCookieConsent(page);

  const ok = await waitForAny(
    page,
    [
      'meta[property="og:type"]',
      '[itemtype*="schema.org/Product"]',
      '[data-testid*="price"], [data-role*="price"]',
      'h1',
    ],
    9_000,
  );

  const html = await page.content();
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
  const finalUrl = page.url();

  await persistSession(page, mongoDb, { monitorId, origin });
  await page.close();

  return { ok, html, screenshot, finalUrl };
}

async function runCookieScreenshotFlow({ monitorId, targetUrl, logger, proxyUrl }) {
  let browser;
  try {
    const userDataDir = profilePath({ monitorId: monitorId || 'unknown', url: targetUrl });
    browser = await launchWithPolicy({ userDataDir, proxyUrl });
    const page = await browser.newPage();
    await hardenPage(page);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45_000 });
    await clickCookieBannerIfPresent(page, logger);
    await sleep(1_500);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeMonitorId = monitorId || 'unknown';
    const screenshotPath = path.join('logs', 'screenshots', `${safeMonitorId}-${ts}.png`);
    await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    logger?.info?.('cookie_screenshot_done', { screenshotPath, url: targetUrl });
    console.log(`[cookie] screenshot saved ${screenshotPath}`);
    return screenshotPath;
  } catch (err) {
    logger?.warn?.('cookie_screenshot_failed', { error: err?.message || String(err) });
    console.warn('[cookie] screenshot flow failed', err?.message || err);
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
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

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    if (!url.pathname) url.pathname = '/';
    return url.toString();
  } catch {
    return raw;
  }
}

async function ensureMongo() {
  if (mongoClient.topology?.isConnected?.()) {
    return mongoClient.db(process.env.MONGO_DB || 'monitor');
  }
  await mongoClient.connect();
  return mongoClient.db(process.env.MONGO_DB || 'monitor');
}

async function saveSnapshotToMongo(doc) {
  const db = await ensureMongo();
  const collection = db.collection('snapshots');
  const { insertedId } = await collection.insertOne(doc);
  return insertedId?.toString() ?? null;
}

async function clearMongoSnapshots() {
  const db = await ensureMongo();
  const collection = db.collection('snapshots');
  const { deletedCount } = await collection.deleteMany({});
  return deletedCount || 0;
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
  const response = await fetchWithTimeout(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
    },
  });

  const status = response.status;
  const finalUrl = response.url || url;
  const buffer = await response.arrayBuffer();
  let html = Buffer.from(buffer).toString('utf8');
  if (html.length > TEXT_TRUNCATE_AT) html = html.slice(0, TEXT_TRUNCATE_AT);

  const dom = new JSDOM(html);
  const document = dom.window.document;
  let content = html;
  if (selector) {
    const node = document.querySelector(selector);
    if (node) {
      content = node.outerHTML;
    }
  }

  const meta = pickMetaFromDocument(document);

  return {
    ok: status >= 200 && status < 400,
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
  return { title, desc, canonical, h1, linksCount, textLen };
}

async function withPg(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
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

async function claimMonitorBatch(monitorId, limit) {
  if (!isUuid(monitorId)) throw new Error('INVALID_MONITOR_ID');
  return withPg(async (pg) => {
    await pg.query('BEGIN');
    try {
      const { rows } = await pg.query(
        `WITH picked AS (
           SELECT z.id, m.url
             FROM zadania_skanu z
             JOIN monitory m ON m.id = z.monitor_id
            WHERE z.status = 'oczekuje'
              AND z.monitor_id = $1::uuid
            ORDER BY z.zaplanowano_at ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         )
         UPDATE zadania_skanu z
            SET status = 'przetwarzanie',
                rozpoczecie_at = NOW()
           FROM picked p
          WHERE z.id = p.id
          RETURNING z.id, z.monitor_id, p.url AS url`,
        [monitorId, limit],
      );
      await pg.query('COMMIT');
      return rows;
    } catch (err) {
      await pg.query('ROLLBACK');
      throw err;
    }
  });
}

async function loadMonitor(pg, monitorId) {
  const { rows } = await pg.query(
    `SELECT id, url, tryb_skanu, css_selector
       FROM monitory
      WHERE id = $1`,
    [monitorId],
  );
  return rows[0];
}

async function finishTask(taskId, { status, blad_opis, tresc_hash, snapshot_mongo_id }) {
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
      await pg.query(
        `UPDATE monitory
            SET status = 'wymaga_interwencji',
                aktywny = false
          WHERE id = $1`,
        [monitorId],
      );
      const message = snapshotId
        ? `Monitor wymaga interwencji: ${reason || 'BOT_PROTECTION'} (snapshot: ${snapshotId})`
        : `Monitor wymaga interwencji: ${reason || 'BOT_PROTECTION'}`;
      await pg.query(
        `INSERT INTO powiadomienia (monitor_id, typ, tresc, utworzono_at)
         VALUES ($1, 'monitor_blocked', $2, NOW())`,
        [monitorId, message],
      );
    });
  } catch (err) {
    console.warn('[intervention] failed to persist status', err?.message || err);
  }
}

const queue = new PQueue({ concurrency: MAX_CONCURRENCY });

async function processTask(task) {
  const { id: taskId, monitor_id: monitorId } = task;
  console.log(`[task] start monitor=${monitorId} task=${taskId}`);

  if (!isUuid(taskId) || !isUuid(monitorId)) {
    await finishTask(taskId, {
      status: 'blad',
      blad_opis: 'INVALID_UUID',
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
  const mode = determineModeByPolicy(targetUrl);
  const mongoDb = await ensureMongo();

  let snapshot = null;
  let blocked = false;
  let finalUrl = targetUrl;
  let html = '';
  let meta = null;
  let status = null;
  let screenshotB64 = null;
  let staticBlockReason = null;

  try {
    if (mode === 'static') {
      const staticResult = await scanStatic({ url: targetUrl, selector });
      status = staticResult.status;
      finalUrl = staticResult.finalUrl;
      html = staticResult.html;
      meta = staticResult.meta;
      blocked = !staticResult.ok;
      const htmlLower = (staticResult.html || '').toLowerCase();
      if (status === 403) {
        staticBlockReason = 'HTTP_403';
      } else if (status === 429) {
        staticBlockReason = 'HTTP_429';
      } else if (/captcha|verify|robot|enable javascript|access denied/.test(htmlLower)) {
        staticBlockReason = 'HTML_BLOCK_DETECTED';
      }
      if (staticBlockReason) {
        blocked = true;
      }
    } else {
      const userDataDir = profilePath({ monitorId, url: targetUrl });
      const proxyUrl = pickProxy(monitorId);
      const browser = await launchWithPolicy({ userDataDir, proxyUrl });
      try {
        const { ok, html: browserHtml, screenshot, finalUrl: browserFinalUrl } = await runBrowserFlow({
          browser,
          url: targetUrl,
          mongoDb,
          monitorId,
        });
        blocked = !ok;
        html = browserHtml;
        finalUrl = browserFinalUrl;
        status = ok ? 200 : 403;
        screenshotB64 = screenshot ? Buffer.from(screenshot).toString('base64') : null;
      } finally {
        await browser.close();
      }
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

  if (!html) {
    blocked = true;
  }

  let extracted = null;
  try {
    // CHANGED: integrated extractOrchestrator — non breaking change
    extracted = await fetchAndExtract(finalUrl, {
      render: false,
      correlationId: `task-${taskId}`,
    });
  } catch (err) {
    console.warn('[task] extract orchestrator failed', err);
  }

  const hash = html ? sha256(html) : null;

  const snapshotDoc = {
    monitor_id: monitorId,
    url: targetUrl,
    ts: new Date(),
    mode,
    final_url: finalUrl,
    html,
    meta,
    hash,
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

  const shouldRunCookieScreenshot =
    POLICY.cookieScreenshotOnBlock && mode === 'static' && Boolean(staticBlockReason);

  if (shouldRunCookieScreenshot) {
    await runCookieScreenshotFlow({
      monitorId,
      targetUrl: finalUrl || targetUrl,
      logger: null,
      proxyUrl: pickProxy(monitorId),
    });
  }

  if (blocked) {
    await markMonitorRequiresIntervention(monitorId, { reason: 'BOT_PROTECTION', snapshotId: snapshot });
    await finishTask(taskId, {
      status: 'blad',
      blad_opis: 'BOT_PROTECTION',
      tresc_hash: null,
      snapshot_mongo_id: snapshot,
    });
    return;
  }

  await finishTask(taskId, {
    status: 'ok',
    blad_opis: null,
    tresc_hash: hash,
    snapshot_mongo_id: snapshot,
  });

  console.log(`[task] done monitor=${monitorId} status=${status}`);
}

function parseSelector(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed.selector === 'string') return parsed.selector;
    if (typeof parsed.css_selector === 'string') return parsed.css_selector;
    if (typeof parsed.cssSelector === 'string') return parsed.cssSelector;
  } catch (_) {}
  return trimmed;
}

async function runExecutionCycle(monitorId) {
  if (!isUuid(monitorId)) throw new Error('INVALID_MONITOR_ID');
  try {
    const scheduled = await scheduleMonitorDue(monitorId);
    if (scheduled) {
      console.log(`[plan] scheduled ${scheduled} tasks`);
    }
  } catch (err) {
    console.error('[plan] schedule error', err);
  }

  let tasks = [];
  try {
    tasks = await claimMonitorBatch(monitorId, SCHEDULE_BATCH_LIMIT);
  } catch (err) {
    console.error('[plan] claim error', err);
    return;
  }

  for (const task of tasks) {
    queue.add(() => processTask(task)).catch((err) => {
      console.error('[task] fatal error', err);
    });
  }

  await queue.onIdle();
}

async function resetData() {
  await withPg(async (pg) => {
    await pg.query('TRUNCATE TABLE zadania_skanu;');
  });
  const deleted = await clearMongoSnapshots();
  console.log(`[reset] Mongo snapshots deleted: ${deleted}`);
}

async function sanityChecks() {
  const { rows } = await pool.query('SELECT current_database() AS db, current_user AS usr');
  console.log('PG OK:', rows[0]);
  const mongoDb = await ensureMongo();
  await mongoDb.command({ ping: 1 });
  console.log('Mongo OK');
}

async function main() {
  const args = process.argv.slice(2);
  const has = (flag) => args.includes(flag);
  const getArg = (name) => {
    const idx = args.indexOf(name);
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
    return null;
  };

  if (has('--reset')) {
    await sanityChecks();
    await resetData();
    return;
  }

  await sanityChecks();

  const once = has('--once');
  const monitorId = getArg('--monitor-id');
  if (!monitorId || !isUuid(monitorId)) {
    console.error('[cli] valid --monitor-id is required');
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
