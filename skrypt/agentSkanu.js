/* eslint-disable no-console */
/**
 * Agent skanujący strony dla tabel:
 *   - monitory(id uuid, url text, interwal_sec int, aktywny bool, tryb_skanu text, css_selector text, ...)
 *   - zadania_skanu(id uuid, monitor_id uuid, zaplanowano_at timestamptz, rozpoczecie_at, zakonczenie_at,
 *                   status text, blad_opis text, tresc_hash char(64), snapshot_mongo_id text, analiza_mongo_id text, utworzono_at timestamptz)
 *
 * Tryby:
 *   - static  -> pobiera HTML (bez JS) i parsuje meta
 *   - browser -> renderuje stronę przez Puppeteer (dla SPA/JS-heavy)
 *
 * CLI:
 *   node agentSkanu.js                # uruchamia pętlę planowania i wykonania
 *   node agentSkanu.js --once         # pojedynczy cykl (planowanie + wykonanie)
 *   node agentSkanu.js --monitor-id <UUID> --once   # pojedynczy scan konkretnego monitora (pomija planowanie)
 *   node agentSkanu.js --reset        # TRUNCATE zadania_skanu + drop snapshotów w Mongo
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const path = require('path');
const crypto = require('crypto');
const PQueue = require('p-queue').default;
const { pool } = require('./polaczeniePG');
const { mongoClient } = require('./polaczenieMDB');

// Jeśli używasz Node 18+, globalny fetch istnieje. Dla zgodności możesz użyć node-fetch:
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  fetchFn = require('node-fetch'); // npm i node-fetch
}

const { JSDOM } = require('jsdom'); // npm i jsdom

// ---- Konfiguracja ----
const LOOP_MS = Number(process.env.AGENT_LOOP_MS || 5_000);       // okres głównej pętli
const SCHEDULE_BATCH_LIMIT = Number(process.env.SCHEDULE_BATCH_LIMIT || 200);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 5);
const USER_AGENT = process.env.AGENT_UA || 'SondaMonitor/1.1 (+Inzynierka2025)';
const STATIC_TIMEOUT_MS = Number(process.env.STATIC_TIMEOUT_MS || 20_000);
const BROWSER_TIMEOUT_MS = Number(process.env.BROWSER_TIMEOUT_MS || 45_000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 2);
const TEXT_TRUNCATE_AT = Number(process.env.TEXT_TRUNCATE_AT || 2_000_000);
const USE_STEALTH = process.env.PUP_STEALTH !== '0';
const BROWSER_MAX_PAGES = Math.max(Number(process.env.BROWSER_MAX_PAGES || MAX_CONCURRENCY), 1);
const BROWSER_DEFAULT_WAIT_UNTIL = process.env.BROWSER_DEFAULT_WAIT_UNTIL || 'networkidle2';
const BROWSER_EXTRA_WAIT_MS = Number(process.env.BROWSER_EXTRA_WAIT_MS || 800);
const DEFAULT_WAIT_FOR_SELECTOR_TIMEOUT = Number(process.env.DEFAULT_WAIT_FOR_SELECTOR_TIMEOUT || 5_000);
const DEFAULT_SCROLL_DELAY_MS = Number(process.env.DEFAULT_SCROLL_DELAY_MS || 250);
const BOT_BYPASS_WAIT_RANGE_MS = [400, 900];

const DESKTOP_PROFILES = [
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
      + 'AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    acceptLanguage: 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
    secChUa:
      '"Not.A/Brand";v="8", "Chromium";v="123", "Google Chrome";v="123"',
    secChUaPlatform: 'Windows',
    timezone: 'Europe/Warsaw',
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_3) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko) '
      + 'Version/17.4 Safari/605.1.15',
    viewport: { width: 1440, height: 900 },
    acceptLanguage: 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
    secChUa: '"Not A(Brand";v="99", "Safari";v="17"',
    secChUaPlatform: 'macOS',
    timezone: 'Europe/Warsaw',
  },
  {
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) '
      + 'AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1600, height: 900 },
    acceptLanguage: 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
    secChUa:
      '"Not A(Brand";v="24", "Chromium";v="122", "Google Chrome";v="122"',
    secChUaPlatform: 'Linux',
    timezone: 'Europe/Warsaw',
  },
];

// ---- Stan globalny Puppeteer ----

// ---- Mongo ----
let MONGO_READY = false;
async function ensureMongo() {
  if (MONGO_READY && mongoClient?.topology?.isConnected?.()) {
    return mongoClient.db(process.env.MONGO_DB || 'monitor');
  }
  if (!mongoClient?.topology?.isConnected?.()) {
    await mongoClient.connect();
  }
  MONGO_READY = true;
  return mongoClient.db(process.env.MONGO_DB || 'monitor');
}

async function saveSnapshotToMongo(doc) {
  const db = await ensureMongo();
  const col = db.collection('snapshots');
  const res = await col.insertOne(doc);
  return res.insertedId?.toString();
}

async function clearMongoSnapshots() {
  const db = await ensureMongo();
  const col = db.collection('snapshots');
  const r = await col.deleteMany({});
  return r.deletedCount || 0;
}

// ---- Utils ----


// Natywny timeout dla fetch (bez p-timeout)
async function fetchWithTimeout(url, options = {}, timeoutMs = 20_000, message = 'Timeout') {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...options, signal: controller.signal });
    return res;
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
      throw new Error(message);
    }
    throw e;
  } finally {
    clearTimeout(id);
  }
}




function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex'); // 64-znakowy hex
}
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
function normalizeUrl(u) {
  try {
    return new URL(u).toString();
  } catch {
    return u;
  }
}

function ensureObject(val) {
  if (!val || typeof val !== 'object') return {};
  return val;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandomProfile() {
  return { ...DESKTOP_PROFILES[randomInt(0, DESKTOP_PROFILES.length - 1)] };
}

// css_selector może być zwykłym selektorem lub JSON-em np.:
// { "selector": "#app", "browserOptions": { "waitForSelector": "#loaded", "scrollToBottom": true } }
function parseMonitorBehavior(rawSelector) {
  const config = {
    selector: rawSelector || null,
    staticOptions: {},
    browserOptions: {},
  };

  if (!rawSelector) {
    return config;
  }

  const trimmed = String(rawSelector).trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        config.selector = parsed;
        return config;
      }
      const browser = ensureObject(parsed.browser || parsed.browserOptions);
      const statik = ensureObject(parsed.static || parsed.staticOptions);
      config.selector = parsed.selector ?? parsed.css_selector ?? null;
      config.staticOptions = { ...statik };
      config.browserOptions = { ...browser };
      if (!config.selector && typeof parsed.cssSelector === 'string') {
        config.selector = parsed.cssSelector;
      }
      if (!config.selector && typeof parsed.selector === 'string') {
        config.selector = parsed.selector;
      }
    } catch (_) {
      config.selector = trimmed;
    }
  }

  return config;
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

// ---- Stan globalny Puppeteer ----
let puppeteer = null;
let isStealth = false;
let browserPromise = null;
const pagePool = [];
const waitingResolvers = [];
let allocatedPages = 0;

async function setPageProfile(page, profile) {
  if (!profile) return null;
  try {
    if (profile.timezone) {
      await page.emulateTimezone(profile.timezone).catch(() => {});
    }
    if (profile.viewport) {
      await page.setViewport({ ...profile.viewport }).catch(() => {});
    }
    if (profile.userAgent) {
      await page.setUserAgent(profile.userAgent).catch(() => {});
    }
    const headers = {
      'accept-language': profile.acceptLanguage || 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
      'upgrade-insecure-requests': '1',
      'sec-ch-ua-mobile': '?0',
    };
    if (profile.secChUa) headers['sec-ch-ua'] = profile.secChUa;
    if (profile.secChUaPlatform) headers['sec-ch-ua-platform'] = `"${profile.secChUaPlatform}"`;
    if (profile.extraHeaders) Object.assign(headers, profile.extraHeaders);
    await page.setExtraHTTPHeaders(headers).catch(() => {});
    page.__profileHeaders = headers;
  } catch (_) {}
  page.__profile = profile;
  return profile;
}

async function ensurePageProfile(page) {
  if (!page.__profile) {
    return setPageProfile(page, pickRandomProfile());
  }
  return setPageProfile(page, page.__profile);
}

async function rotatePageProfile(page) {
  return setPageProfile(page, pickRandomProfile());
}

async function applyNavigationHeaders(page, extraHeaders = {}) {
  const base = page.__profileHeaders || {};
  const merged = { ...base, ...extraHeaders };
  try {
    await page.setExtraHTTPHeaders(merged);
  } catch (_) {}
  return merged;
}

async function humanizePageInteractions(page, viewport = {}) {
  const width = viewport.width || 1366;
  const height = viewport.height || 900;
  const steps = randomInt(12, 24);
  try {
    await page.mouse.move(randomInt(50, width - 50), randomInt(50, height - 50), { steps }).catch(() => {});
  } catch (_) {}
  await sleep(randomInt(120, 280));
  try {
    await page.mouse.move(randomInt(30, width - 30), randomInt(30, height - 30), { steps: randomInt(10, 20) }).catch(() => {});
  } catch (_) {}
  await sleep(randomInt(140, 320));
  try {
    await page.keyboard.press('Tab', { delay: randomInt(35, 120) });
  } catch (_) {}
  await sleep(randomInt(120, 260));
}

async function warmUpOrigin(page, url, gotoOptions) {
  try {
    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.host}/`;
    if (!origin || origin === url) return false;
    await page.goto(origin, {
      ...gotoOptions,
      waitUntil: 'domcontentloaded',
      timeout: Math.min(gotoOptions?.timeout ?? BROWSER_TIMEOUT_MS, 15_000),
    });
    await sleep(randomInt(200, 350));
    await humanizePageInteractions(page, page.__profile?.viewport);
    return true;
  } catch (_) {
    return false;
  }
}

async function ensurePuppeteer() {
  if (puppeteer) return { puppeteer, isStealth };
  if (USE_STEALTH) {
    const puppeteerExtra = require('puppeteer-extra');
    const stealth = require('puppeteer-extra-plugin-stealth')();
    puppeteerExtra.use(stealth);
    puppeteer = puppeteerExtra;
    isStealth = true;
    return { puppeteer, isStealth };
  }
  puppeteer = require('puppeteer');
  isStealth = false;
  return { puppeteer, isStealth };
}

function buildLaunchOptions() {
  const extraArgs = [];
  if (process.env.PUPPETEER_PROXY) {
    extraArgs.push(`--proxy-server=${process.env.PUPPETEER_PROXY}`);
  }

  return {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--lang=pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
      ...extraArgs,
    ],
    defaultViewport: { width: 1366, height: 900 },
  };
}

async function getBrowser() {
  if (!browserPromise) {
    const { puppeteer: pptr } = await ensurePuppeteer();
    browserPromise = pptr
      .launch(buildLaunchOptions())
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

async function configurePage(page) {
  try {
    await page.setJavaScriptEnabled(true);
  } catch (_) {}
  try {
    await page.setBypassCSP(true);
  } catch (_) {}
  page.setDefaultNavigationTimeout(BROWSER_TIMEOUT_MS);
  page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
}

async function createPage() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await configurePage(page);
  await rotatePageProfile(page);
  allocatedPages += 1;
  return page;
}

async function acquirePage() {
  if (pagePool.length) {
    return pagePool.pop();
  }

  if (allocatedPages < BROWSER_MAX_PAGES) {
    return createPage();
  }

  return new Promise((resolve) => {
    waitingResolvers.push(resolve);
  });
}

function cleanupPageListeners(page) {
  if (!page || typeof page.removeAllListeners !== 'function') return;
  page.removeAllListeners('response');
  page.removeAllListeners('console');
  page.removeAllListeners('requestfailed');
}

async function resetPage(page) {
  if (!page || page.isClosed()) return;
  try {
    await page.goto('about:blank', { waitUntil: 'load', timeout: 10_000 });
  } catch (_) {}
}

async function releasePage(page) {
  if (!page) return;
  if (page.isClosed?.()) {
    allocatedPages = Math.max(allocatedPages - 1, 0);
    return;
  }

  cleanupPageListeners(page);

  await resetPage(page);

  if (waitingResolvers.length) {
    const resolve = waitingResolvers.shift();
    resolve(page);
    return;
  }

  pagePool.push(page);
}

async function closeBrowser() {
  if (!browserPromise) return;
  let browser = null;
  try {
    browser = await browserPromise;
  } catch (_) {}

  browserPromise = null;

  await Promise.allSettled(pagePool.splice(0).map((p) => p.close().catch(() => {})));
  allocatedPages = 0;

  if (browser) {
    try {
      await browser.close();
    } catch (_) {}
  }
}

['SIGINT', 'SIGTERM', 'beforeExit', 'exit'].forEach((eventName) => {
  process.once(eventName, () => {
    closeBrowser().catch(() => {});
  });
});

async function autoScroll(page, {
  stepPx = 400,
  delayMs = DEFAULT_SCROLL_DELAY_MS,
  maxScrolls = 15,
} = {}) {
  let previousHeight = -1;
  for (let i = 0; i < maxScrolls; i++) {
    const currentHeight = await page.evaluate(() => document.body?.scrollHeight || 0).catch(() => 0);
    if (currentHeight === previousHeight) break;
    previousHeight = currentHeight;
    await page.evaluate((step) => {
      window.scrollBy(0, step);
    }, stepPx).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

async function waitForPageReadiness(page, options = {}) {
  const {
    waitForSelector,
    waitForSelectors,
    waitForSelectorTimeoutMs = DEFAULT_WAIT_FOR_SELECTOR_TIMEOUT,
    waitForSelectorVisible = true,
    waitForFunction,
    waitForFunctionTimeoutMs = BROWSER_TIMEOUT_MS,
    waitForResponseIncludes,
    waitForResponseTimeoutMs = BROWSER_TIMEOUT_MS,
    waitAfterMs = 0,
    scrollToBottom: shouldScroll = false,
    scrollConfig = {},
    evaluateAfterNavigationScripts,
  } = options;

  const selectors = [];
  if (typeof waitForSelector === 'string' && waitForSelector.trim()) {
    selectors.push(waitForSelector.trim());
  }
  if (Array.isArray(waitForSelectors)) {
    selectors.push(...waitForSelectors.filter((s) => typeof s === 'string' && s.trim()));
  }

  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, {
        timeout: waitForSelectorTimeoutMs,
        visible: waitForSelectorVisible,
      });
    } catch (_) {}
  }

  const functions = [];
  if (typeof waitForFunction === 'string' && waitForFunction.trim()) {
    functions.push(waitForFunction.trim());
  }
  if (Array.isArray(waitForFunction)) {
    functions.push(
      ...waitForFunction.filter((fn) => typeof fn === 'string' && fn.trim())
    );
  }

  for (const fnSource of functions) {
    try {
      await page.waitForFunction(fnSource, { timeout: waitForFunctionTimeoutMs });
    } catch (_) {}
  }

  const responseIncludes = [];
  if (typeof waitForResponseIncludes === 'string' && waitForResponseIncludes.trim()) {
    responseIncludes.push(waitForResponseIncludes.trim());
  }
  if (Array.isArray(waitForResponseIncludes)) {
    responseIncludes.push(
      ...waitForResponseIncludes.filter((v) => typeof v === 'string' && v.trim())
    );
  }

  for (const fragment of responseIncludes) {
    try {
      await page.waitForResponse((resp) => {
        try {
          return resp.url().includes(fragment);
        } catch (_) {
          return false;
        }
      }, { timeout: waitForResponseTimeoutMs });
    } catch (_) {}
  }

  if (Array.isArray(evaluateAfterNavigationScripts)) {
    for (const script of evaluateAfterNavigationScripts) {
      if (typeof script !== 'string' || !script.trim()) continue;
      try {
        await page.evaluate((source) => {
          try {
            return window.eval(source);
          } catch (_) {
            return null;
          }
        }, script);
      } catch (_) {}
    }
  }

  if (shouldScroll) {
    await autoScroll(page, scrollConfig);
  }

  if (waitAfterMs > 0) {
    await sleep(waitAfterMs);
  }
}


// ---- Tryb STATIC ----
async function fetchStatic(url, { selector, headers = {}, fetchOptions = {} } = {}) {
  const startedAt = Date.now();
  const res = await fetchWithTimeout(
    url,
    {
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
      ...fetchOptions,
    },
    STATIC_TIMEOUT_MS,
    'Static timeout'
  );

  const finalUrl = res.url || url;
  const status = res.status;

  const buffer = await res.arrayBuffer();
  let html = Buffer.from(buffer).toString('utf8');
  if (html.length > TEXT_TRUNCATE_AT) html = html.slice(0, TEXT_TRUNCATE_AT);

  const dom = new JSDOM(html);
  const { document } = dom.window;

  let fragmentHtml = null;
  if (selector) {
    const node = document.querySelector(selector);
    fragmentHtml = node ? node.outerHTML : null;
  }

  const meta = pickMetaFromDocument(document);
  const content = fragmentHtml || html;
  const hash = sha256(content);

  return {
    mode: 'static',
    startedAt,
    finishedAt: Date.now(),
    final_url: finalUrl,
    http_status: status,
    html: content,
    meta,
    hash,
  };
}

// ---- Tryb BROWSER (Puppeteer + stealth + heurystyka bot-wall + screenshot) ----
async function detectBotWall(page) {
  try {
    return await page.evaluate(() => {
      const txt = (document.body?.innerText || '').toLowerCase();
      const title = (document.title || '').toLowerCase();
      const hasCMsg = !!document.querySelector('#cmsg');
      const hasCaptchaDelivery = !!document.querySelector(
        'script[src*="captcha-delivery.com"],script[src*="ct.captcha-delivery.com"]'
      );
      const hasAllegroShield = !!document.querySelector('div[data-box-name="allegro.guard"]');
      return (
        hasCMsg ||
        hasCaptchaDelivery ||
        hasAllegroShield ||
        title.includes('enable js') ||
        txt.includes('enable js') ||
        txt.includes('captcha') ||
        txt.includes('bot protection') ||
        txt.includes('access denied') ||
        txt.includes('protect our site')
      );
    });
  } catch (_) {
    return false;
  }
}

async function extractHtml(page, selector) {
  if (selector) {
    const fragment = await page.$eval(selector, (el) => el.outerHTML).catch(() => null);
    if (fragment) {
      return fragment.length > TEXT_TRUNCATE_AT ? fragment.slice(0, TEXT_TRUNCATE_AT) : fragment;
    }
  }
  let html = await page.content();
  if (html.length > TEXT_TRUNCATE_AT) html = html.slice(0, TEXT_TRUNCATE_AT);
  return html;
}

async function collectBrowserSnapshot(page, {
  url,
  gotoOptions,
  selector,
  waitAfterMs,
  browserOptions,
  includeScreenshot = true,
}) {
  const opts = browserOptions || {};
  let navStatus = null;
  const onResponse = (resp) => {
    try {
      if (resp.request().resourceType() === 'document' && navStatus === null) {
        navStatus = resp.status();
      }
    } catch (_) {}
  };
  page.on('response', onResponse);
  try {
    await page.goto(url, gotoOptions);

    await waitForPageReadiness(page, {
      ...opts,
      waitAfterMs,
    });

    if (selector) {
      try {
        await page.waitForSelector(selector, { timeout: opts.fragmentTimeoutMs || 3_000 });
      } catch (_) {}
    }

    const blocked = await detectBotWall(page);
    const finalUrl = page.url();
    const html = await extractHtml(page, selector);
    const meta = await page.evaluate(() => {
      const byName = (n) => document.querySelector(`meta[name="${n}"]`)?.getAttribute('content')?.trim() || null;
      const byProp = (p) => document.querySelector(`meta[property="${p}"]`)?.getAttribute('content')?.trim() || null;
      const title = document.querySelector('title')?.textContent?.trim() || null;
      const desc = byName('description') || byProp('og:description') || null;
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || null;
      const h1 = document.querySelector('h1')?.textContent?.trim() || null;
      const linksCount = document.querySelectorAll('a[href]').length;
      const textLen = document.body?.innerText?.length || 0;
      return { title, desc, canonical, h1, linksCount, textLen };
    });

    let screenshot_b64 = null;
    if (includeScreenshot) {
      try {
        const png = await page.screenshot({ fullPage: true });
        screenshot_b64 = png.toString('base64');
      } catch (_) {}
    }

    return {
      navStatus,
      finalUrl,
      blocked,
      html,
      meta,
      screenshot_b64,
      hash: sha256(html || ''),
    };
  } finally {
    page.off('response', onResponse);
  }
}

async function prepareForBotBypass(page) {
  try {
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies').catch(() => {});
    await client.send('Network.clearBrowserCache').catch(() => {});
  } catch (_) {}
  await rotatePageProfile(page);
  await sleep(randomInt(...BOT_BYPASS_WAIT_RANGE_MS));
}

async function attemptBotBypass(page, {
  url,
  gotoOptions,
  selector,
  waitAfterMs,
  browserOptions,
  includeScreenshot,
}) {
  const opts = browserOptions || {};
  await prepareForBotBypass(page);
  await applyNavigationHeaders(page, opts.headers || {});
  await warmUpOrigin(page, url, gotoOptions);
  await sleep(randomInt(...BOT_BYPASS_WAIT_RANGE_MS));

  const relaxedGoto = {
    ...gotoOptions,
    waitUntil: opts.retryWaitUntil || gotoOptions.waitUntil || 'domcontentloaded',
  };

  await humanizePageInteractions(page, page.__profile?.viewport);

  return collectBrowserSnapshot(page, {
    url,
    gotoOptions: relaxedGoto,
    selector,
    waitAfterMs,
    browserOptions: opts,
    includeScreenshot,
  });
}

async function fetchBrowser(url, { selector, browserOptions = {} } = {}) {
  const startedAt = Date.now();

  await ensurePuppeteer();

  let page = null;
  const navigationTimeout = browserOptions.navigationTimeoutMs || browserOptions.timeoutMs || BROWSER_TIMEOUT_MS;
  let waitUntil = browserOptions.waitUntil || browserOptions.navigationWaitUntil || BROWSER_DEFAULT_WAIT_UNTIL;
  const opts = browserOptions || {};

  if (Array.isArray(waitUntil) && waitUntil.length === 0) {
    waitUntil = BROWSER_DEFAULT_WAIT_UNTIL;
  }

  const gotoOptions = {
    timeout: navigationTimeout,
  };
  if (Array.isArray(waitUntil)) {
    gotoOptions.waitUntil = waitUntil;
  } else if (typeof waitUntil === 'string') {
    const trimmed = waitUntil.trim();
    if (trimmed && trimmed !== 'manual' && trimmed !== 'none') {
      gotoOptions.waitUntil = trimmed;
    }
  } else {
    gotoOptions.waitUntil = BROWSER_DEFAULT_WAIT_UNTIL;
  }

  const waitAfterMs =
    typeof browserOptions.waitAfterMs === 'number'
      ? browserOptions.waitAfterMs
      : typeof browserOptions.extraWaitMs === 'number'
        ? browserOptions.extraWaitMs
        : BROWSER_EXTRA_WAIT_MS;

  try {
    page = await acquirePage();
    await ensurePageProfile(page);
    await applyNavigationHeaders(page, opts.headers || {});

    const includeScreenshot = opts.captureScreenshot !== false;

    let snapshot = await collectBrowserSnapshot(page, {
      url,
      gotoOptions,
      selector,
      waitAfterMs,
      browserOptions: opts,
      includeScreenshot,
    });

    const needsBypass =
      snapshot.blocked ||
      (snapshot.navStatus && [401, 403, 429].includes(snapshot.navStatus)) ||
      (opts.forceBotBypass === true && snapshot.navStatus && snapshot.navStatus >= 300);

    if (needsBypass && opts.disableBotBypass !== true) {
      try {
        snapshot = await attemptBotBypass(page, {
          url,
          gotoOptions,
          selector,
          waitAfterMs,
          browserOptions: opts,
          includeScreenshot,
        });
      } catch (err) {
        if (!snapshot.blocked) {
          throw err;
        }
      }
    }

    const http_status = snapshot.navStatus || 200;

    return {
      mode: 'browser',
      startedAt,
      finishedAt: Date.now(),
      final_url: snapshot.finalUrl || url,
      http_status,
      html: snapshot.html,
      meta: snapshot.meta,
      hash: snapshot.hash,
      blocked: !!snapshot.blocked,
      block_reason: snapshot.blocked ? 'BOT_PROTECTION' : null,
      screenshot_b64: snapshot.screenshot_b64,
    };
  } finally {
    if (page) {
      await releasePage(page);
    }
  }
}

// ---- Warstwa retry ----
async function scanUrl({ url, tryb, selector, browserOptions = {}, staticOptions = {} }) {
  const normUrl = normalizeUrl(url);
  let lastErr = null;

  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      if (tryb === 'browser') {
        return await fetchBrowser(normUrl, { selector, browserOptions });
      }
      return await fetchStatic(normUrl, { selector, ...staticOptions });
    } catch (e) {
      lastErr = e;
      if (i < MAX_RETRIES) await sleep(500 + i * 300);
    }
  }
  throw lastErr;
}

// ---- PG helpers ----
async function withPg(tx) {
  const client = await pool.connect();
  try {
    return await tx(client);
  } finally {
    client.release();
  }
}

// Planowanie: tworzymy zadania dla monitorów, którym minął interwał
async function scheduleDue({ onlyMonitorId = null } = {}) {
  return withPg(async (pg) => {
    try {
      await pg.query('BEGIN');

      if (onlyMonitorId) {
        const r = await pg.query(
          `INSERT INTO zadania_skanu (id, monitor_id, zaplanowano_at, status)
           VALUES (gen_random_uuid(), $1, NOW(), 'oczekuje')
           RETURNING id`,
          [onlyMonitorId]
        );
        await pg.query('COMMIT');
        return r.rowCount || 0;
      }

      const dueSQL = `
        WITH ostatnie AS (
          SELECT m.id AS monitor_id,
                 m.interwal_sec,
                 MAX(z.zaplanowano_at) AS last_plan
          FROM monitory m
          LEFT JOIN zadania_skanu z ON z.monitor_id = m.id
          WHERE m.aktywny = true
          GROUP BY m.id, m.interwal_sec
        ),
        due AS (
          SELECT o.monitor_id
          FROM ostatnie o
          WHERE o.last_plan IS NULL
             OR EXTRACT(EPOCH FROM (NOW() - o.last_plan)) >= o.interwal_sec
        )
        INSERT INTO zadania_skanu (id, monitor_id, zaplanowano_at, status)
        SELECT gen_random_uuid(), monitor_id, NOW(), 'oczekuje'
        FROM due
        LIMIT $1
        RETURNING id
      `;
      const r = await pg.query(dueSQL, [SCHEDULE_BATCH_LIMIT]);
      await pg.query('COMMIT');
      return r.rowCount || 0;
    } catch (e) {
      try { await pg.query('ROLLBACK'); } catch {}
      throw e;
    }
  });
}


// Pobierz paczkę do realizacji i zarezerwuj
async function claimBatch(limit) {
  return withPg(async (pg) => {
    try {
      await pg.query('BEGIN');
      const res = await pg.query(
        `
        UPDATE zadania_skanu
           SET status = 'przetwarzanie',
               rozpoczecie_at = NOW()
         WHERE id IN (
           SELECT id
             FROM zadania_skanu
            WHERE status = 'oczekuje'
            ORDER BY zaplanowano_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         RETURNING id, monitor_id
        `,
        [limit]
      );
      await pg.query('COMMIT');
      return res.rows;
    } catch (e) {
      try { await pg.query('ROLLBACK'); } catch {}
      throw e;
    }
  });
}


// Wczytaj konfigurację monitora
async function loadMonitor(pg, monitor_id) {
  const { rows } = await pg.query(
    `SELECT id, url, tryb_skanu, css_selector
       FROM monitory
      WHERE id = $1`,
    [monitor_id]
  );
  return rows[0];
}

// Finalizacja zadania dopasowana do Twojej tabeli
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
      [taskId, status, blad_opis || null, tresc_hash || null, snapshot_mongo_id || null]
    );
  });
}

// ---- Worker ----
const queue = new PQueue({ concurrency: MAX_CONCURRENCY });

async function processTask(task) {
  const { id: taskId, monitor_id } = task;

  const monitor = await withPg((pg) => loadMonitor(pg, monitor_id));
  if (!monitor) {
    await finishTask(taskId, {
      status: 'blad',
      blad_opis: 'MONITOR_NOT_FOUND',
      tresc_hash: null,
      snapshot_mongo_id: null,
    });
    return;
  }

  const url = monitor.url;
  const tryb = (monitor.tryb_skanu || 'static').toLowerCase() === 'browser' ? 'browser' : 'static';
  const { selector, staticOptions, browserOptions } = parseMonitorBehavior(monitor.css_selector || null);

  try {
    const result = await scanUrl({ url, tryb, selector, browserOptions, staticOptions });

    const snapshotId = await saveSnapshotToMongo({
      monitor_id,
      url,
      ts: new Date(),
      mode: result.mode,
      final_url: result.final_url,
      html: result.html,
      meta: result.meta,
      hash: result.hash,
      blocked: !!result.blocked,
      block_reason: result.block_reason || null,
      screenshot_b64: result.screenshot_b64 || null,
    });

    if (result.blocked) {
      await finishTask(taskId, {
        status: 'blad',
        blad_opis: 'BOT_PROTECTION',
        tresc_hash: null,
        snapshot_mongo_id: snapshotId,
      });
      return;
    }

    await finishTask(taskId, {
      status: 'ok',
      blad_opis: null,
      tresc_hash: result.hash,
      snapshot_mongo_id: snapshotId,
    });
  } catch (e) {
    console.error(`[task:${taskId}] error:`, e?.message || e);
    await finishTask(taskId, {
      status: 'blad',
      blad_opis: (e && e.message) ? e.message.slice(0, 500) : 'Unknown error',
      tresc_hash: null,
      snapshot_mongo_id: null,
    });
  }
}



async function runExecutionCycle() {
  // 1) planowanie
  try {
    const planned = await scheduleDue();
    if (planned) console.log(`[plan] dodano zadań: ${planned}`);
  } catch (e) {
    console.error('[plan] błąd planowania:', e.message);
  }

  // 2) pobranie paczki
  let tasks = [];
  try {
    tasks = await claimBatch(MAX_CONCURRENCY);
  } catch (e) {
    console.error('[claim] błąd rezerwacji:', e.message);
  }

  // 3) wykonanie
  for (const t of tasks) {
    queue.add(() => processTask(t)).catch((e) =>
      console.error('[task] błąd krytyczny:', e)
    );
  }

  // 4) poczekaj na zakończenie kolejki przed wyjściem w trybie --once
  await queue.onIdle();
}

// ---- RESET ----
async function resetData() {
  // Postgres: TRUNCATE zadania_skanu
  await withPg(async (pg) => {
    await pg.query('TRUNCATE TABLE zadania_skanu;');
  });
  console.log('[reset] TRUNCATE zadania_skanu OK');

  // Mongo: wyczyść snapshots
  const deleted = await clearMongoSnapshots();
  console.log(`[reset] Mongo snapshots usuniętych: ${deleted}`);
}

// ---- Bootstrap ----
async function sanityChecks() {
  const { rows } = await pool.query('SELECT current_database() AS db, current_user AS usr');
  console.log('PG OK:', rows[0]);
  const db = await ensureMongo();
  await db.command({ ping: 1 });
  console.log('Mongo OK');
}

async function main() {
  // parse CLI
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

  if (once && monitorId) {
    // Jednorazowy scan konkretnego monitora (bez globalnego planowania)
    console.log(`[once] uruchamiam jednorazowy scan monitora ${monitorId}`);
    // zaplanuj pojedyncze zadanie dla tego monitora
    await scheduleDue({ onlyMonitorId: monitorId });
    await runExecutionCycle();
    return;
  }

  if (once) {
    console.log('[once] pojedynczy cykl: planowanie + wykonanie');
    await runExecutionCycle();
    return;
  }

  console.log(`[loop] start pętli co ${LOOP_MS} ms`);
  // pierwsze odpalenie od razu
  await runExecutionCycle();

  // cyklicznie
  setInterval(async () => {
    try {
      await runExecutionCycle();
    } catch (e) {
      console.error('[loop] cykl błąd:', e?.message || e);
    }
  }, LOOP_MS);
}

// Start
main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});

