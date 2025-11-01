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

const TRACKER_PARAMS = new Set(['fbclid', 'gclid', 'yclid', 'mc_cid', 'mc_eid', 'igshid']); // ADD
const TRACKER_PREFIXES = ['utm_', 'pk_', 'ga_']; // ADD

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

const COOKIE_CONSENT_KEYWORDS = [
  'zgadzam',
  'akceptuj',
  'akceptuję',
  'ok',
  'accept',
  'i agree',
  'consent',
];

const ERROR_CONFIRM_KEYWORDS = ['confirm', 'potwierdź', 'potwierdzam', 'continue']; // ADD

const DOMAIN_MIN_DELAY_MS = 60_000; // ADD
const DOMAIN_MAX_DELAY_MS = 180_000; // ADD
const DOMAIN_BACKOFF_MAX_MS = 30 * 60_000; // ADD
const DOMAIN_BLOCK_PAUSE_MS = 4 * 60 * 60_000; // ADD

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
function normalizeUrl(u) { // FIX
  try { // FIX
    const urlObj = new URL(u); // FIX
    urlObj.hash = ''; // FIX
    const params = urlObj.searchParams; // FIX
    for (const key of Array.from(params.keys())) { // FIX
      const lower = key.toLowerCase(); // FIX
      if (TRACKER_PARAMS.has(lower) || TRACKER_PREFIXES.some((prefix) => lower.startsWith(prefix))) { // FIX
        params.delete(key); // FIX
      }
    }
    if ([...params.keys()].length === 0) { // FIX
      urlObj.search = ''; // FIX
    }
    if (!urlObj.pathname) { // FIX
      urlObj.pathname = '/'; // FIX
    }
    const normalized = urlObj.toString(); // FIX
    return normalized.endsWith('/') ? normalized.slice(0, -1) || normalized : normalized; // FIX
  } catch { // FIX
    return u; // FIX
  }
} // FIX

function appendCacheBuster(url) { // ADD
  const stamp = Date.now().toString(); // ADD
  try { // ADD
    const parsed = new URL(url); // ADD
    parsed.searchParams.set('_t', stamp); // ADD
    return parsed.toString(); // ADD
  } catch (_) { // ADD
    const joiner = url.includes('?') ? '&' : '?'; // ADD
    return `${url}${joiner}_t=${stamp}`; // ADD
  } // ADD
} // ADD

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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function createRunId(taskId, monitorId) {
  const base = taskId ? taskId.slice(0, 8) : 'manual';
  const rand = Math.random().toString(36).slice(2, 8);
  return `${base}-${rand}-${monitorId ? monitorId.slice(0, 4) : 'ctx'}`;
}

function createRunLogger({ taskId, monitorId }) {
  const runId = createRunId(taskId, monitorId);
  const base = `[scan:${runId}]`;
  const timestamp = () => new Date().toISOString();
  const formatExtra = (extra) => {
    if (!extra || (typeof extra === 'object' && Object.keys(extra).length === 0)) {
      return '';
    }
    try {
      return ` | data=${JSON.stringify(extra)}`;
    } catch (_) {
      return '';
    }
  };
  const emit = (level, stage, message, extra, channel = 'log') => {
    const stagePart = stage ? ` | stage=${stage}` : '';
    const extraPart = formatExtra(extra);
    const line = `${timestamp()} ${base} | level=${level}${stagePart} | ${message}${extraPart}`;
    if (channel === 'warn') {
      console.warn(line);
    } else if (channel === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  };
  return {
    runId,
    headerStart(meta) {
      emit('HEADER', 'run', 'START', meta);
    },
    headerEnd(meta) {
      emit('HEADER', 'run', 'END', meta);
    },
    stageStart(stage, meta) {
      emit('STAGE', stage, 'START', meta);
    },
    stageEnd(stage, meta) {
      emit('STAGE', stage, 'END', meta);
    },
    info(stage, message, meta) {
      emit('INFO', stage, message, meta);
    },
    warn(stage, message, meta) {
      emit('WARN', stage, message, meta, 'warn');
    },
    error(stage, message, meta) {
      emit('ERROR', stage, message, meta, 'error');
    },
  };
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
const monitorSessions = new Map(); // ADD
const monitorsRequiringIntervention = new Set(); // ADD

const domainStates = new Map(); // ADD

function getDomainFromUrl(url) { // ADD
  try { // ADD
    return new URL(url).hostname; // ADD
  } catch { // ADD
    return null; // ADD
  }
} // ADD

function ensureDomainState(host) { // ADD
  let state = domainStates.get(host); // ADD
  if (!state) { // ADD
    state = { // ADD
      lock: Promise.resolve(), // ADD
      nextAllowedAt: 0, // ADD
      backoffMs: DOMAIN_MIN_DELAY_MS, // ADD
      blockedUntil: 0, // ADD
    }; // ADD
    domainStates.set(host, state); // ADD
  } // ADD
  return state; // ADD
} // ADD

async function acquireDomainSlot(url, { logger, monitorId } = {}) { // ADD
  const host = getDomainFromUrl(url); // ADD
  if (!host) { // ADD
    return { // ADD
      domain: null, // ADD
      release: () => {}, // ADD
    }; // ADD
  } // ADD
  const state = ensureDomainState(host); // ADD
  const now = Date.now(); // ADD
  if (state.blockedUntil && now < state.blockedUntil) { // ADD
    const waitMs = state.blockedUntil - now; // ADD
    logger?.warn('throttle', 'Domain blocked window active', { domain: host, waitMs, monitorId }); // ADD
    const error = new Error('DOMAIN_BLOCKED'); // ADD
    error.code = 'DOMAIN_BLOCKED'; // ADD
    error.waitMs = waitMs; // ADD
    throw error; // ADD
  } // ADD

  let releaseResolve; // ADD
  const ticket = state.lock.then(async () => { // ADD
    const delay = Math.max(state.nextAllowedAt - Date.now(), 0); // ADD
    const jitter = randomInt(0, 3_000); // ADD
    if (delay + jitter > 0) { // ADD
      logger?.info('throttle', 'Domain delay before scan', { domain: host, waitMs: delay + jitter, monitorId }); // ADD
      await sleep(delay + jitter); // ADD
    } // ADD
  }); // ADD

  state.lock = ticket.then(() => new Promise((resolve) => { releaseResolve = resolve; })); // ADD
  await ticket; // ADD

  let released = false; // ADD
  return { // ADD
    domain: host, // ADD
    release: ({ blocked = false, error = false } = {}) => { // ADD
      if (released) return; // ADD
      released = true; // ADD
      const finishNow = Date.now(); // ADD
      if (blocked) { // ADD
        state.blockedUntil = finishNow + DOMAIN_BLOCK_PAUSE_MS; // ADD
        state.backoffMs = Math.min(state.backoffMs * 2, DOMAIN_BACKOFF_MAX_MS); // ADD
        state.nextAllowedAt = state.blockedUntil + randomInt(DOMAIN_MIN_DELAY_MS, DOMAIN_MAX_DELAY_MS); // ADD
        logger?.warn('throttle', 'Domain blocked - pausing', { domain: host, blockedUntil: state.blockedUntil }); // ADD
      } else if (error) { // ADD
        state.backoffMs = Math.min(state.backoffMs * 2, DOMAIN_BACKOFF_MAX_MS); // ADD
        state.nextAllowedAt = finishNow + state.backoffMs; // ADD
        logger?.warn('throttle', 'Domain error backoff', { domain: host, backoffMs: state.backoffMs }); // ADD
      } else { // ADD
        state.backoffMs = DOMAIN_MIN_DELAY_MS; // ADD
        state.nextAllowedAt = finishNow + randomInt(DOMAIN_MIN_DELAY_MS, DOMAIN_MAX_DELAY_MS); // ADD
      } // ADD
      releaseResolve?.(); // ADD
    }, // ADD
  }; // ADD
} // ADD

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
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': profile.acceptLanguage || 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
      'cache-control': 'max-age=0',
      'pragma': 'no-cache',
      'upgrade-insecure-requests': '1',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
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

function getMonitorSession(monitorId) { // ADD
  if (!monitorId) return null; // ADD
  return monitorSessions.get(monitorId) || null; // ADD
} // ADD

function storeMonitorSession(monitorId, session) { // ADD
  if (!monitorId) return; // ADD
  if (!session) { // ADD
    monitorSessions.delete(monitorId); // ADD
    return; // ADD
  } // ADD
  monitorSessions.set(monitorId, session); // ADD
} // ADD

async function restoreSessionForPage(page, monitorId, targetUrl, logger) { // ADD
  const session = getMonitorSession(monitorId); // ADD
  if (!session) return false; // ADD
  logger?.stageStart('browser:session-restore', { monitorId, origin: session.origin }); // ADD
  try { // ADD
    if (Array.isArray(session.cookies) && session.cookies.length) { // ADD
      const cookieOrigin = session.origin || targetUrl; // ADD
      const cookies = session.cookies.map((cookie) => ({ // ADD
        ...cookie, // ADD
        url: cookie.url || cookieOrigin, // ADD
      })); // ADD
      await page.setCookie(...cookies).catch(() => {}); // ADD
    } // ADD
    if (Array.isArray(session.localStorage) && session.localStorage.length) { // ADD
      const originToVisit = session.origin || targetUrl; // ADD
      try { // ADD
        await page.goto(originToVisit, { // ADD
          waitUntil: 'domcontentloaded', // ADD
          timeout: Math.min(BROWSER_TIMEOUT_MS, 12_000), // ADD
        }); // ADD
      } catch (_) {} // ADD
      try { // ADD
        await page.evaluate((entries) => { // ADD
          try { // ADD
            entries.forEach(({ key, value }) => { // ADD
              if (key != null && value != null) { // ADD
                localStorage.setItem(key, value); // ADD
              } // ADD
            }); // ADD
          } catch (_) {} // ADD
        }, session.localStorage); // ADD
      } catch (_) {} // ADD
    } // ADD
    await humanizePageInteractions(page, page.__profile?.viewport); // ADD
    logger?.stageEnd('browser:session-restore', { // ADD
      cookies: session.cookies ? session.cookies.length : 0, // ADD
      localStorage: session.localStorage ? session.localStorage.length : 0, // ADD
    }); // ADD
    return true; // ADD
  } catch (err) { // ADD
    logger?.stageEnd('browser:session-restore', { // ADD
      error: err?.message || String(err), // ADD
    }); // ADD
    return false; // ADD
  } // ADD
} // ADD

async function persistSessionFromPage(page, monitorId, finalUrl, logger) { // ADD
  if (!monitorId) return; // ADD
  try { // ADD
    const origin = (() => { // ADD
      try { return new URL(finalUrl).origin; } catch { return null; } // ADD
    })(); // ADD
    const cookies = await page.cookies().catch(() => []); // ADD
    const localStorage = await page.evaluate(() => { // ADD
      const entries = []; // ADD
      try { // ADD
        for (let i = 0; i < localStorage.length; i += 1) { // ADD
          const key = localStorage.key(i); // ADD
          entries.push({ key, value: localStorage.getItem(key) }); // ADD
        } // ADD
      } catch (_) {} // ADD
      return entries; // ADD
    }).catch(() => []); // ADD
    storeMonitorSession(monitorId, { origin, cookies, localStorage }); // ADD
    logger?.info('browser:session-store', 'Session persisted', { monitorId, cookies: cookies.length, localStorage: localStorage.length }); // FIX
  } catch (err) { // ADD
    logger?.warn('browser:session-store', 'Failed to persist session', { monitorId, message: err?.message || String(err) }); // ADD
  } // ADD
} // ADD

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

async function warmUpOrigin(page, url, gotoOptions, logger, session) { // FIX
  let origin = null; // FIX
  try { // FIX
    const parsed = new URL(url); // FIX
    origin = `${parsed.protocol}//${parsed.host}/`; // FIX
    if (!origin || origin === url) return false; // FIX
    logger?.stageStart('browser:warmup', { origin }); // FIX
    if (session?.cookies?.length) { // ADD
      const cookies = session.cookies.map((cookie) => ({ ...cookie, url: session.origin || origin })); // ADD
      try { await page.setCookie(...cookies); } catch (_) {} // ADD
    } // ADD
    await page.goto(origin, { // FIX
      ...gotoOptions, // FIX
      waitUntil: 'domcontentloaded', // FIX
      timeout: Math.min(gotoOptions?.timeout ?? BROWSER_TIMEOUT_MS, 15_000), // FIX
    }); // FIX
    if (session?.localStorage?.length) { // ADD
      try { // ADD
        await page.evaluate((entries) => { // ADD
          try { // ADD
            entries.forEach(({ key, value }) => { // ADD
              if (key != null && value != null) { // ADD
                localStorage.setItem(key, value); // ADD
              } // ADD
            }); // ADD
          } catch (_) {} // ADD
        }, session.localStorage); // ADD
      } catch (_) {} // ADD
    } // ADD
    await handleCookieConsent(page, logger); // FIX
    await sleep(1_500); // FIX
    await humanizePageInteractions(page, page.__profile?.viewport); // FIX
    await sleep(randomInt(200, 350)); // FIX
    logger?.stageEnd('browser:warmup', { origin, outcome: 'ok' }); // FIX
    return true; // FIX
  } catch (err) { // FIX
    logger?.stageEnd('browser:warmup', { origin, outcome: 'error', message: err?.message || String(err) }); // FIX
    return false; // FIX
  } // FIX
} // FIX

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
  try { await page.setCacheEnabled(false); } catch (_) {} // FIX
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
async function fetchStatic(url, { selector, headers = {}, fetchOptions = {}, logger } = {}) { // FIX
  const startedAt = Date.now(); // FIX
  const requestUrl = appendCacheBuster(url); // FIX
  const staticHeaders = { // FIX
    'user-agent': USER_AGENT, // FIX
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', // FIX
    'accept-language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7', // FIX
    'cache-control': 'no-cache', // FIX
    'pragma': 'no-cache', // FIX
    ...headers, // FIX
  }; // FIX
  logger?.stageStart('static:request', { // FIX
    url: requestUrl, // FIX
    timeoutMs: STATIC_TIMEOUT_MS, // FIX
    headers: Object.keys(staticHeaders || {}), // FIX
  }); // FIX
  let res; // FIX
  try { // FIX
    res = await fetchWithTimeout( // FIX
      requestUrl, // FIX
      { // FIX
        redirect: 'follow', // FIX
        headers: staticHeaders, // FIX
        ...fetchOptions, // FIX
      }, // FIX
      STATIC_TIMEOUT_MS, // FIX
      'Static timeout' // FIX
    ); // FIX
  } catch (err) { // FIX
    logger?.stageEnd('static:request', { // FIX
      finalUrl: requestUrl, // FIX
      status: null, // FIX
      error: err?.message || String(err), // FIX
    }); // FIX
    throw err; // FIX
  } // FIX

  const finalUrl = res.url || requestUrl; // FIX
  const status = res.status; // FIX
  logger?.stageEnd('static:request', { finalUrl, status }); // FIX

  logger?.stageStart('static:read-body', {}); // FIX
  let buffer; // FIX
  try { // FIX
    buffer = await res.arrayBuffer(); // FIX
  } catch (err) { // FIX
    logger?.stageEnd('static:read-body', { error: err?.message || String(err) }); // FIX
    throw err; // FIX
  } // FIX
  let html = Buffer.from(buffer).toString('utf8'); // FIX
  if (html.length > TEXT_TRUNCATE_AT) html = html.slice(0, TEXT_TRUNCATE_AT); // FIX
  logger?.stageEnd('static:read-body', { length: html.length }); // FIX

  logger?.stageStart('static:parse', { selector: !!selector }); // FIX
  let fragmentHtml = null; // FIX
  let meta; // FIX
  let content; // FIX
  let hash; // FIX
  try { // FIX
    const dom = new JSDOM(html); // FIX
    const { document } = dom.window; // FIX

    if (selector) { // FIX
      const node = document.querySelector(selector); // FIX
      fragmentHtml = node ? node.outerHTML : null; // FIX
    } // FIX

    meta = pickMetaFromDocument(document); // FIX
    content = fragmentHtml || html; // FIX
    hash = sha256(content); // FIX
  } catch (err) { // FIX
    logger?.stageEnd('static:parse', { // FIX
      fragmentFound: !!fragmentHtml, // FIX
      error: err?.message || String(err), // FIX
    }); // FIX
    throw err; // FIX
  } // FIX
  logger?.stageEnd('static:parse', { // FIX
    fragmentFound: !!fragmentHtml, // FIX
    metaKeys: Object.keys(meta || {}), // FIX
    hash, // FIX
  }); // FIX

  const htmlLower = (content || '').toLowerCase(); // FIX
  let blocked = false; // FIX
  let block_reason = null; // FIX
  const checks = [ // FIX
    { match: () => status === 403, reason: 'HTTP_403' }, // FIX
    { match: () => htmlLower.includes('captcha') || finalUrl.toLowerCase().includes('captcha'), reason: 'CAPTCHA_DETECTED' }, // FIX
    { match: () => htmlLower.includes('please enable javascript') || htmlLower.includes('please enable js'), reason: 'JS_REQUIRED' }, // FIX
    { match: () => finalUrl.toLowerCase().includes('geo.captcha-delivery.com') || htmlLower.includes('geo.captcha-delivery.com'), reason: 'GEO_CAPTCHA' }, // FIX
  ]; // FIX
  for (const check of checks) { // FIX
    if (check.match()) { // FIX
      blocked = true; // FIX
      if (!block_reason) block_reason = check.reason; // FIX
    } // FIX
  } // FIX

  console.log(`FETCH static status=${status} blocked=${blocked} reason=${block_reason || 'none'} finalUrl=${finalUrl} length=${content.length}`); // LOG

  return { // FIX
    mode: 'static', // FIX
    startedAt, // FIX
    finishedAt: Date.now(), // FIX
    final_url: finalUrl, // FIX
    http_status: status, // FIX
    html: content, // FIX
    meta, // FIX
    hash, // FIX
    blocked, // FIX
    block_reason, // FIX
  }; // FIX
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
        txt.includes('potwierdź, że jesteś człowiekiem') || // ADD
        txt.includes('confirm you are human') || // ADD
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

async function handleCookieConsent(page, logger) {
  logger?.stageStart('browser:cookie-consent', {});
  try {
    const result = await page.evaluate((keywords) => {
      const normalize = (text) => {
        if (!text) return '';
        return text.toString().trim().toLocaleLowerCase('pl-PL');
      };
      const matches = (text) => {
        const normalized = normalize(text);
        if (!normalized) return false;
        return keywords.some((keyword) => normalized.includes(keyword));
      };
      const elements = Array.from(
        document.querySelectorAll('button, a, div, span, p, label, input')
      );
      for (const el of elements) {
        const label = el.innerText || el.textContent || el.value || '';
        if (!matches(label)) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const hidden =
          !rect ||
          rect.width === 0 ||
          rect.height === 0 ||
          style.visibility === 'hidden' ||
          style.display === 'none' ||
          style.opacity === '0';
        if (hidden) {
          continue;
        }
        if (typeof el.click === 'function') {
          el.click();
          return { clicked: true, label: label.trim() };
        }
      }
      return { clicked: false };
    }, COOKIE_CONSENT_KEYWORDS);

    if (result?.clicked) {
      const label = result.label || 'unknown';
      if (!logger) {
        console.log(`[cookie-consent] clicked: "${label}"`);
      }
      logger?.info('browser:cookie-consent', '[cookie-consent] clicked', { label });
      await sleep(1_500);
      logger?.stageEnd('browser:cookie-consent', { clicked: true, label });
    } else {
      if (!logger) {
        console.log('[cookie-consent] no consent buttons found');
      }
      logger?.info('browser:cookie-consent', '[cookie-consent] no consent buttons found');
      logger?.stageEnd('browser:cookie-consent', { clicked: false });
    }
  } catch (err) {
    if (!logger) {
      console.log(`[cookie-consent] handler error: ${err?.message || err}`);
    }
    logger?.warn('browser:cookie-consent', '[cookie-consent] handler error', {
      message: err?.message || String(err),
    });
    logger?.stageEnd('browser:cookie-consent', {
      clicked: false,
      error: err?.message || String(err),
    });
  }
}

async function handleErrorScreenConfirmation(page, logger) { // ADD
  logger?.stageStart('browser:error-screen', {}); // ADD
  try { // ADD
    const result = await page.evaluate((keywords) => { // ADD
      const bodyText = (document.body?.innerText || '').toLowerCase(); // ADD
      const urlPath = (location.pathname || '').toLowerCase(); // ADD
      const shouldCheck = bodyText.includes('potwierdź, że jesteś człowiekiem') // ADD
        || bodyText.includes('confirm you are human') // ADD
        || urlPath.includes('bledy') // ADD
        || urlPath.includes('error'); // ADD
      if (!shouldCheck) { // ADD
        return { triggered: false }; // ADD
      } // ADD
      const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"], span[role="button"], input[type="submit"]')); // ADD
      for (const el of candidates) { // ADD
        const label = (el.innerText || el.textContent || el.value || '').trim(); // ADD
        if (!label) continue; // ADD
        const lower = label.toLowerCase(); // ADD
        if (keywords.some((keyword) => lower.includes(keyword))) { // ADD
          const rect = el.getBoundingClientRect(); // ADD
          const style = window.getComputedStyle(el); // ADD
          const hidden = !rect || rect.width === 0 || rect.height === 0 // ADD
            || style.visibility === 'hidden' // ADD
            || style.display === 'none' // ADD
            || style.opacity === '0'; // ADD
          if (hidden) continue; // ADD
          if (typeof el.click === 'function') { // ADD
            el.click(); // ADD
            return { triggered: true, clicked: true, label }; // ADD
          } // ADD
        } // ADD
      } // ADD
      return { triggered: true, clicked: false }; // ADD
    }, ERROR_CONFIRM_KEYWORDS); // ADD

    if (!result.triggered) { // ADD
      logger?.stageEnd('browser:error-screen', { triggered: false }); // ADD
      return; // ADD
    } // ADD
    if (result.clicked) { // ADD
      logger?.info('browser:error-screen', 'Error screen confirmation clicked', { label: result.label }); // ADD
      await sleep(2_000); // ADD
      logger?.stageEnd('browser:error-screen', { triggered: true, clicked: true, label: result.label }); // ADD
    } else { // ADD
      logger?.stageEnd('browser:error-screen', { triggered: true, clicked: false }); // ADD
    } // ADD
  } catch (err) { // ADD
    logger?.stageEnd('browser:error-screen', { triggered: true, clicked: false, error: err?.message || String(err) }); // ADD
  } // ADD
} // ADD

async function collectBrowserSnapshot(page, {
  url,
  gotoOptions,
  selector,
  waitAfterMs,
  browserOptions,
  includeScreenshot = true,
},
logger) {
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
    logger?.stageStart('browser:navigate', {
      url,
      waitUntil: gotoOptions.waitUntil,
      timeout: gotoOptions.timeout,
    });
    try {
      await page.goto(url, gotoOptions);
      logger?.stageEnd('browser:navigate', { status: navStatus });
    } catch (err) {
      logger?.stageEnd('browser:navigate', {
        status: navStatus,
        error: err?.message || String(err),
      });
      throw err;
    }

    await handleCookieConsent(page, logger); // FIX
    await handleErrorScreenConfirmation(page, logger); // ADD

    logger?.stageStart('browser:wait-readiness', {
      waitAfterMs,
      waitUntil: gotoOptions.waitUntil,
    });
    try {
      await waitForPageReadiness(page, {
        ...opts,
        waitAfterMs,
      });
      logger?.stageEnd('browser:wait-readiness', {});
    } catch (err) {
      logger?.stageEnd('browser:wait-readiness', {
        error: err?.message || String(err),
      });
      throw err;
    }

    if (selector) {
      logger?.stageStart('browser:wait-selector', {
        selector,
        timeout: opts.fragmentTimeoutMs || 3_000,
      });
      try {
        await page.waitForSelector(selector, { timeout: opts.fragmentTimeoutMs || 3_000 });
        logger?.stageEnd('browser:wait-selector', { found: true });
      } catch (err) {
        logger?.stageEnd('browser:wait-selector', {
          found: false,
          message: err?.message || String(err),
        });
      }
    }

    logger?.stageStart('browser:detect-botwall', {});
    const blocked = await detectBotWall(page);
    logger?.stageEnd('browser:detect-botwall', { blocked });
    const finalUrl = page.url();
    logger?.stageStart('browser:extract-html', { selector: !!selector });
    let html;
    try {
      html = await extractHtml(page, selector);
      logger?.stageEnd('browser:extract-html', { length: html?.length || 0 });
    } catch (err) {
      logger?.stageEnd('browser:extract-html', {
        length: 0,
        error: err?.message || String(err),
      });
      throw err;
    }
    const meta = await page.evaluate(() => { // FIX
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
      logger?.stageStart('browser:screenshot', {});
      try {
        const png = await page.screenshot({ fullPage: true });
        screenshot_b64 = png.toString('base64');
        logger?.stageEnd('browser:screenshot', { captured: true, length: screenshot_b64.length });
      } catch (err) {
        logger?.stageEnd('browser:screenshot', {
          captured: false,
          message: err?.message || String(err),
        });
      }
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
  } catch (err) {
    throw err;
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
  logger,
  monitorId,
}) {
  const opts = browserOptions || {};
  logger?.stageStart('browser:bot-bypass', { url });
  try {
    await prepareForBotBypass(page);
    await applyNavigationHeaders(page, opts.headers || {});
    const session = getMonitorSession(monitorId); // ADD
    await warmUpOrigin(page, url, gotoOptions, logger, session); // FIX
    await sleep(randomInt(...BOT_BYPASS_WAIT_RANGE_MS));

    const relaxedGoto = {
      ...gotoOptions,
      waitUntil: opts.retryWaitUntil || gotoOptions.waitUntil || 'domcontentloaded',
    };

    await humanizePageInteractions(page, page.__profile?.viewport);

    const snapshot = await collectBrowserSnapshot(page, {
      url,
      gotoOptions: relaxedGoto,
      selector,
      waitAfterMs,
      browserOptions: opts,
      includeScreenshot,
    }, logger);
    logger?.stageEnd('browser:bot-bypass', { blocked: snapshot.blocked, status: snapshot.navStatus });
    return snapshot;
  } catch (err) {
    logger?.stageEnd('browser:bot-bypass', {
      blocked: null,
      status: null,
      error: err?.message || String(err),
    });
    throw err;
  }
}

async function fetchBrowser(url, { selector, browserOptions = {}, logger, monitorId } = {}) {
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
    logger?.stageStart('browser:acquire-page', {});
    try {
      page = await acquirePage();
      logger?.stageEnd('browser:acquire-page', { acquired: true });
    } catch (err) {
      logger?.stageEnd('browser:acquire-page', {
        acquired: false,
        error: err?.message || String(err),
      });
      throw err;
    }

    logger?.stageStart('browser:configure-page', {
      headers: Object.keys(opts.headers || {}),
    });
    try {
      await ensurePageProfile(page);
      await applyNavigationHeaders(page, opts.headers || {});
      logger?.stageEnd('browser:configure-page', {
        viewport: page.__profile?.viewport || null,
      });
    } catch (err) {
      logger?.stageEnd('browser:configure-page', {
        viewport: page.__profile?.viewport || null,
        error: err?.message || String(err),
      });
      throw err;
    }

    const session = getMonitorSession(monitorId); // ADD
    let restoredSession = false; // ADD
    if (session) { // ADD
      restoredSession = await restoreSessionForPage(page, monitorId, url, logger); // ADD
      await applyNavigationHeaders(page, opts.headers || {}); // ADD
    } else { // ADD
      await warmUpOrigin(page, url, gotoOptions, logger, null); // ADD
      await applyNavigationHeaders(page, opts.headers || {}); // ADD
    } // ADD

    if (session && !restoredSession) { // ADD
      await warmUpOrigin(page, url, gotoOptions, logger, session); // ADD
      await applyNavigationHeaders(page, opts.headers || {}); // ADD
    } // ADD

    const includeScreenshot = opts.captureScreenshot !== false;

    logger?.stageStart('browser:collect', {
      includeScreenshot,
      waitAfterMs,
      waitUntil: gotoOptions.waitUntil,
    });
    let snapshot;
    try {
      snapshot = await collectBrowserSnapshot(page, {
        url,
        gotoOptions,
        selector,
        waitAfterMs,
        browserOptions: opts,
        includeScreenshot,
      }, logger);
      logger?.stageEnd('browser:collect', {
        blocked: snapshot.blocked,
        status: snapshot.navStatus,
        finalUrl: snapshot.finalUrl,
      });
    } catch (err) {
      logger?.stageEnd('browser:collect', {
        blocked: null,
        status: null,
        error: err?.message || String(err),
      });
      throw err;
    }

    const needsBypass =
      snapshot.blocked ||
      (snapshot.navStatus && [401, 403, 429].includes(snapshot.navStatus)) ||
      (opts.forceBotBypass === true && snapshot.navStatus && snapshot.navStatus >= 300);

    if (needsBypass && opts.disableBotBypass !== true) {
      logger?.info('browser:collect', 'Attempting bot bypass', {
        blocked: snapshot.blocked,
        status: snapshot.navStatus,
      });
      try {
        snapshot = await attemptBotBypass(page, {
          url,
          gotoOptions,
          selector,
          waitAfterMs,
          browserOptions: opts,
          includeScreenshot,
          logger,
          monitorId, // ADD
        });
      } catch (err) {
        logger?.warn('browser:bot-bypass', 'Bypass attempt failed', {
          message: err?.message || String(err),
        });
        if (!snapshot.blocked) {
          throw err;
        }
      }
    }

    const http_status = snapshot.navStatus || 200; // FIX

    const screenshotInfo = snapshot.screenshot_b64 ? snapshot.screenshot_b64.length : 0; // FIX
    console.log(`BROWSER status=${http_status} blocked=${!!snapshot.blocked} finalUrl=${snapshot.finalUrl || url} screenshotLength=${screenshotInfo}`); // LOG

    if (monitorId) { // ADD
      await persistSessionFromPage(page, monitorId, snapshot.finalUrl || url, logger); // ADD
    } // ADD

    return { // FIX
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
  } catch (err) {
    throw err;
  } finally {
    if (page) {
      logger?.stageStart('browser:release-page', {});
      try {
        await releasePage(page);
        logger?.stageEnd('browser:release-page', { released: true });
      } catch (err) {
        logger?.stageEnd('browser:release-page', {
          released: false,
          error: err?.message || String(err),
        });
      }
    }
  }
}

// ---- Warstwa retry ----
async function scanUrl({ url, tryb, selector, browserOptions = {}, staticOptions = {}, logger, monitorId }) { // FIX
  const normUrl = normalizeUrl(url);
  let lastErr = null;

  for (let i = 0; i <= MAX_RETRIES; i++) {
    logger?.stageStart('scan-attempt', { attempt: i + 1, mode: tryb, url: normUrl });
    try {
      if (tryb === 'browser') {
        const result = await fetchBrowser(normUrl, { selector, browserOptions, logger, monitorId }); // FIX
        logger?.stageEnd('scan-attempt', {
          attempt: i + 1,
          outcome: 'success',
          mode: result.mode,
          status: result.http_status,
          blocked: result.blocked,
        });
        return result;
      }
      let result = await fetchStatic(normUrl, { selector, ...staticOptions, logger }); // FIX
      const htmlCheck = (result.html || '').toLowerCase(); // FIX
      let fallbackTriggered = false; // FIX
      let fallbackReason = null; // FIX
      if (result.blocked) { // FIX
        fallbackTriggered = true; // FIX
        fallbackReason = result.block_reason || 'static-blocked'; // FIX
      } else if (result.http_status === 403) { // FIX
        fallbackTriggered = true; // FIX
        fallbackReason = 'http-403'; // FIX
      } else if (htmlCheck.includes('captcha')) { // FIX
        fallbackTriggered = true; // FIX
        fallbackReason = 'captcha-detected'; // FIX
      } else if (htmlCheck.includes('please enable js') || htmlCheck.includes('please enable javascript')) { // FIX
        fallbackTriggered = true; // FIX
        fallbackReason = 'javascript-required'; // FIX
      } // FIX
      if (fallbackTriggered) { // FIX
        console.log(`FALLBACK url=${normUrl} reason=${fallbackReason}`); // LOG
        logger?.info('scan', 'Fallback to browser', { reason: fallbackReason, status: result.http_status }); // FIX
        result = await fetchBrowser(normUrl, { selector, browserOptions, logger, monitorId }); // FIX
      } // FIX
      logger?.stageEnd('scan-attempt', { // FIX
        attempt: i + 1, // FIX
        outcome: 'success', // FIX
        mode: result.mode, // FIX
        status: result.http_status, // FIX
        blocked: !!result.blocked, // FIX
        fallback: fallbackTriggered, // FIX
      }); // FIX
      return result; // FIX
    } catch (e) {
      lastErr = e;
      logger?.stageEnd('scan-attempt', {
        attempt: i + 1,
        outcome: 'error',
        message: e?.message || String(e),
      });
      if (i < MAX_RETRIES) await sleep(500 + i * 300);
    }
  }
  logger?.error('scan', 'All attempts failed', {
    attempts: MAX_RETRIES + 1,
    lastError: lastErr?.message || String(lastErr),
  });
  throw lastErr;
}

// ---- PG helpers ----
async function withPg(tx) {
  const client = await pool.connect();
  try {
    return await tx(client);
  } catch (err) {
    throw err;
  } finally {
    client.release();
  }
}

// Planowanie: tworzymy zadania tylko dla wskazanego monitora
async function scheduleMonitorDue(monitorId) { // FIX
  if (!isUuid(monitorId)) { // FIX
    throw new Error('INVALID_MONITOR_ID'); // FIX
  } // FIX
  return withPg(async (pg) => { // FIX
    try { // FIX
      await pg.query('BEGIN'); // FIX
      const res = await pg.query( // FIX
        `INSERT INTO zadania_skanu (id, monitor_id, zaplanowano_at, status)
         VALUES (gen_random_uuid(), $1::uuid, NOW(), 'oczekuje')
         RETURNING id`, // FIX
        [monitorId] // FIX
      ); // FIX
      await pg.query('COMMIT'); // FIX
      return res.rowCount || 0; // FIX
    } catch (e) { // FIX
      try { await pg.query('ROLLBACK'); } catch {} // FIX
      throw e; // FIX
    } // FIX
  }); // FIX
} // FIX


// Pobierz paczkę tylko dla wybranego monitora i usuń duplikaty później
async function claimMonitorBatch(monitorId, limit) { // FIX
  if (!isUuid(monitorId)) { // FIX
    throw new Error('INVALID_MONITOR_ID'); // FIX
  } // FIX
  return withPg(async (pg) => { // FIX
    try { // FIX
      await pg.query('BEGIN'); // FIX
      const res = await pg.query( // FIX
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
          RETURNING z.id, z.monitor_id, p.url AS url`, // FIX
        [monitorId, limit] // FIX
      ); // FIX
      await pg.query('COMMIT'); // FIX
      return res.rows; // FIX
    } catch (e) { // FIX
      try { await pg.query('ROLLBACK'); } catch {} // FIX
      throw e; // FIX
    } // FIX
  }); // FIX
} // FIX


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

async function markMonitorRequiresIntervention(monitorId, { reason, snapshotId, logger } = {}) { // ADD
  if (!monitorId) return; // ADD
  monitorsRequiringIntervention.add(monitorId); // ADD
  storeMonitorSession(monitorId, null); // ADD
  try { // ADD
    await withPg(async (pg) => { // ADD
      try { // ADD
        await pg.query( // ADD
          `UPDATE monitory
              SET status = 'wymaga_interwencji',
                  aktywny = false
            WHERE id = $1`, // ADD
          [monitorId], // ADD
        ); // ADD
      } catch (err) { // ADD
        logger?.warn('monitor-status', 'Failed to set status column', { message: err?.message || String(err) }); // ADD
        try { // ADD
          await pg.query(`UPDATE monitory SET aktywny = false WHERE id = $1`, [monitorId]); // ADD
        } catch (_) {} // ADD
      } // ADD
      try { // ADD
        const message = snapshotId // ADD
          ? `Monitor wymaga interwencji: ${reason || 'BOT_PROTECTION'} (snapshot: ${snapshotId})` // ADD
          : `Monitor wymaga interwencji: ${reason || 'BOT_PROTECTION'}`; // ADD
        await pg.query( // ADD
          `INSERT INTO powiadomienia (monitor_id, typ, tresc, utworzono_at)
           VALUES ($1, 'monitor_blocked', $2, NOW())`, // ADD
          [monitorId, message], // ADD
        ); // ADD
      } catch (notifyErr) { // ADD
        logger?.warn('monitor-status', 'Failed to insert notification', { message: notifyErr?.message || String(notifyErr) }); // ADD
      } // ADD
    }); // ADD
  } catch (err) { // ADD
    logger?.warn('monitor-status', 'Monitor intervention update failed', { message: err?.message || String(err) }); // ADD
  } // ADD
  console.log(`[intervention] monitor=${monitorId} status=wymaga_interwencji reason=${reason || 'BOT_PROTECTION'} snapshot=${snapshotId || 'none'}`); // LOG
} // ADD

// ---- Worker ----
const queue = new PQueue({ concurrency: MAX_CONCURRENCY });

async function processTask(task) {
  const { id: taskId, monitor_id } = task;
  const logger = createRunLogger({ taskId, monitorId: monitor_id });
  const startedAt = Date.now();
  let finalStatus = 'unknown';
  let finalHash = null;
  let finalSnapshotId = null;
  let finalError = null;

  logger.headerStart({ taskId, monitorId: monitor_id });

  try {
    logger.stageStart('validate-identifiers', { taskId, monitorId: monitor_id });
    const validTaskId = isUuid(taskId);
    const validMonitorId = isUuid(monitor_id);
    if (!validTaskId || !validMonitorId) {
      logger.stageEnd('validate-identifiers', { validTaskId, validMonitorId, outcome: 'invalid' });
      finalStatus = 'blad';
      finalError = 'INVALID_UUID';
      logger.error('validate-identifiers', 'Invalid UUID detected', { validTaskId, validMonitorId });
      logger.stageStart('pg:finish-task', { status: 'blad' });
      try {
        await finishTask(taskId, {
          status: 'blad',
          blad_opis: 'INVALID_UUID',
          tresc_hash: null,
          snapshot_mongo_id: null,
        });
        logger.stageEnd('pg:finish-task', { status: 'blad' });
      } catch (finishErr) {
        logger.stageEnd('pg:finish-task', {
          status: 'blad',
          error: finishErr?.message || String(finishErr),
        });
        logger.error('pg:finish-task', 'Failed to update task status', {
          message: finishErr?.message || String(finishErr),
        });
      }
      return;
    }
    logger.stageEnd('validate-identifiers', { validTaskId, validMonitorId, outcome: 'ok' });

    logger.stageStart('load-monitor', { monitorId: monitor_id });
    const monitor = await withPg((pg) => loadMonitor(pg, monitor_id));
    if (!monitor) {
      logger.stageEnd('load-monitor', { outcome: 'not-found' });
      finalStatus = 'blad';
      finalError = 'MONITOR_NOT_FOUND';
      logger.error('load-monitor', 'Monitor not found', {});
      logger.stageStart('pg:finish-task', { status: 'blad' });
      try {
        await finishTask(taskId, {
          status: 'blad',
          blad_opis: 'MONITOR_NOT_FOUND',
          tresc_hash: null,
          snapshot_mongo_id: null,
        });
        logger.stageEnd('pg:finish-task', { status: 'blad' });
      } catch (finishErr) {
        logger.stageEnd('pg:finish-task', {
          status: 'blad',
          error: finishErr?.message || String(finishErr),
        });
        logger.error('pg:finish-task', 'Failed to update task status', {
          message: finishErr?.message || String(finishErr),
        });
      }
      return;
    }
    logger.stageEnd('load-monitor', {
      outcome: 'found',
      tryb_skanu: monitor.tryb_skanu,
      url: monitor.url,
    });

    logger.stageStart('parse-behavior', { hasSelector: !!monitor.css_selector });
    const { selector, staticOptions, browserOptions } = parseMonitorBehavior(monitor.css_selector || null);
    logger.stageEnd('parse-behavior', {
      selectorPreview: selector ? selector.slice(0, 120) : null,
      staticOptionKeys: Object.keys(staticOptions || {}),
      browserOptionKeys: Object.keys(browserOptions || {}),
    });

    const tryb = (monitor.tryb_skanu || 'static').toLowerCase() === 'browser' ? 'browser' : 'static';
    const url = normalizeUrl(monitor.url); // FIX
    console.log(`SCAN START monitor=${monitor_id} url=${url}`); // LOG
    logger.info('determine-mode', 'Resolved scan mode', {
      tryb,
      url,
      selectorPreview: selector ? selector.slice(0, 120) : null,
    });

    let domainPermit = null; // ADD
    let domainReleaseInfo = { blocked: false, error: false }; // ADD
    try { // ADD
      domainPermit = await acquireDomainSlot(url, { logger, monitorId: monitor_id }); // ADD
    } catch (acqErr) { // ADD
      finalStatus = 'blad'; // ADD
      finalError = acqErr?.code || acqErr?.message || String(acqErr); // ADD
      logger.error('throttle', 'Domain throttle prevented scan', { // ADD
        message: finalError, // ADD
        waitMs: acqErr?.waitMs, // ADD
      }); // ADD
      console.error(`SCAN ABORT monitor=${monitor_id} reason=${finalError}`); // LOG
      if (acqErr?.code === 'DOMAIN_BLOCKED') { // ADD
        monitorsRequiringIntervention.add(monitor_id); // ADD
        await markMonitorRequiresIntervention(monitor_id, { reason: finalError, snapshotId: null, logger }); // ADD
      } // ADD
      try { // ADD
        await finishTask(taskId, { // ADD
          status: 'blad', // ADD
          blad_opis: finalError.slice(0, 500), // ADD
          tresc_hash: null, // ADD
          snapshot_mongo_id: null, // ADD
        }); // ADD
      } catch (finishErr) { // ADD
        logger.error('pg:finish-task', 'Failed to update task status after throttle block', { message: finishErr?.message || String(finishErr) }); // ADD
      } // ADD
      return; // ADD
    } // ADD

    logger.stageStart('scan', { url, tryb });
    const result = await scanUrl({ url, tryb, selector, browserOptions, staticOptions, logger, monitorId: monitor_id }); // FIX
    logger.stageEnd('scan', {
      mode: result.mode,
      http_status: result.http_status,
      blocked: result.blocked,
      hash: result.hash,
      finalUrl: result.final_url,
    });
    domainReleaseInfo = { blocked: !!result.blocked, error: false }; // ADD

    logger.stageStart('mongo:save-snapshot', { mode: result.mode });
    let snapshotId;
    try {
      snapshotId = await saveSnapshotToMongo({
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
      console.log(`MONGO snapshot=${snapshotId} monitor=${monitor_id} blocked=${!!result.blocked}`); // LOG
      logger.stageEnd('mongo:save-snapshot', {
        snapshotId,
        htmlLength: result.html ? result.html.length : 0,
      });
    } catch (err) {
      logger.stageEnd('mongo:save-snapshot', {
        snapshotId: null,
        error: err?.message || String(err),
      });
      throw err;
    }

    finalSnapshotId = snapshotId;
    finalHash = result.hash;

    if (result.blocked) {
      finalStatus = 'blad'; // FIX
      finalError = result.block_reason || 'BOT_PROTECTION';
      logger.warn('scan', 'Result blocked by bot protection', {
        reason: finalError,
        status: result.http_status,
      });
      await markMonitorRequiresIntervention(monitor_id, { reason: finalError, snapshotId, logger }); // ADD
      logger.stageStart('pg:finish-task', { status: 'blad' });
      try {
        await finishTask(taskId, {
          status: 'blad',
          blad_opis: result.block_reason || 'BOT_PROTECTION',
          tresc_hash: null,
          snapshot_mongo_id: snapshotId,
        });
        logger.stageEnd('pg:finish-task', { status: 'blad' });
      } catch (finishErr) {
        logger.stageEnd('pg:finish-task', {
          status: 'blad',
          error: finishErr?.message || String(finishErr),
        });
        logger.error('pg:finish-task', 'Failed to update task status', {
          message: finishErr?.message || String(finishErr),
        });
      }
      return;
    }

    logger.stageStart('pg:finish-task', { status: 'ok' });
    try {
      await finishTask(taskId, {
        status: 'ok',
        blad_opis: null,
        tresc_hash: result.hash,
        snapshot_mongo_id: snapshotId,
      });
      logger.stageEnd('pg:finish-task', { status: 'ok' });
    } catch (finishErr) {
      logger.stageEnd('pg:finish-task', {
        status: 'ok',
        error: finishErr?.message || String(finishErr),
      });
      logger.error('pg:finish-task', 'Failed to update task status', {
        message: finishErr?.message || String(finishErr),
      });
      throw finishErr;
    }
    finalStatus = 'ok';
  } catch (e) {
    finalStatus = 'blad';
    finalError = e?.message || String(e);
    logger.error('run', 'Unhandled error during task', {
      message: finalError,
      stack: e?.stack,
    });
    domainReleaseInfo.error = true; // ADD
    try {
      logger.stageStart('pg:finish-task', { status: 'blad' });
      await finishTask(taskId, {
        status: 'blad',
        blad_opis: finalError.slice(0, 500),
        tresc_hash: null,
        snapshot_mongo_id: null,
      });
      logger.stageEnd('pg:finish-task', { status: 'blad' });
    } catch (finishErr) {
      logger.stageEnd('pg:finish-task', {
        status: 'blad',
        error: finishErr?.message || String(finishErr),
      });
      logger.error('pg:finish-task', 'Failed to update task status', {
        message: finishErr?.message || String(finishErr),
      });
    }
  } finally {
    if (domainPermit?.release) { // ADD
      domainPermit.release(domainReleaseInfo); // ADD
    } // ADD
    const duration = Date.now() - startedAt; // FIX
    console.log(`SCAN END monitor=${monitor_id} status=${finalStatus} durationMs=${duration} error=${finalError || 'none'}`); // LOG
    logger.headerEnd({ // FIX
      status: finalStatus,
      durationMs: duration, // FIX
      snapshotId: finalSnapshotId,
      hash: finalHash,
      error: finalError,
    });
  }
}



async function runExecutionCycle(monitorId) { // FIX
  if (!isUuid(monitorId)) { // FIX
    throw new Error('INVALID_MONITOR_ID'); // FIX
  } // FIX
  if (monitorsRequiringIntervention.has(monitorId)) { // ADD
    console.log(`[intervention] monitor=${monitorId} paused`); // LOG
    return; // ADD
  } // ADD
  try { // FIX
    const planned = await scheduleMonitorDue(monitorId); // FIX
    if (planned) { // FIX
      console.log(`PLAN scheduled=${planned} monitor=${monitorId}`); // LOG
    } // FIX
  } catch (e) { // FIX
    console.error(`[PLAN] error=${e?.message || e}`); // LOG
  } // FIX

  let tasks = []; // FIX
  try { // FIX
    tasks = await claimMonitorBatch(monitorId, MAX_CONCURRENCY); // FIX
  } catch (e) { // FIX
    console.error(`[PLAN] claim-error=${e?.message || e}`); // LOG
  } // FIX

  const uniqueByUrl = new Map(); // FIX
  const duplicates = []; // FIX
  for (const task of tasks) { // FIX
    const normalizedTaskUrl = task?.url ? normalizeUrl(task.url) : null; // ADD
    if (!normalizedTaskUrl) { // ADD
      uniqueByUrl.set(`${task.id}`, task); // FIX
      continue; // FIX
    } // FIX
    if (uniqueByUrl.has(normalizedTaskUrl)) { // FIX
      duplicates.push(task); // FIX
    } else { // FIX
      uniqueByUrl.set(normalizedTaskUrl, { ...task, url: normalizedTaskUrl }); // FIX
    } // FIX
  } // FIX
  const uniqueTasks = Array.from(uniqueByUrl.values()); // FIX
  console.log(`PLAN monitor=${monitorId} fetched=${tasks.length} unique=${uniqueTasks.length}`); // LOG
  for (const dup of duplicates) { // FIX
    finishTask(dup.id, { status: 'blad', blad_opis: 'DUPLICATE_URL', tresc_hash: null, snapshot_mongo_id: null }).catch(() => {}); // FIX
  } // FIX

  for (const t of uniqueTasks) { // FIX
    queue.add(() => processTask(t)).catch((e) => // FIX
      console.error('[task] błąd krytyczny:', e) // FIX
    ); // FIX
  } // FIX

  await queue.onIdle(); // FIX
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
  if (monitorId && !isUuid(monitorId)) {
    console.error(`[cli] invalid monitor id: ${monitorId}`);
    process.exit(1);
  }
  if (!monitorId) { // FIX
    console.error('[cli] monitor-id is required for scanning'); // LOG
    process.exit(1); // FIX
  }

  if (once) {
    console.log(`[once] uruchamiam jednorazowy scan monitora ${monitorId}`); // LOG
    await runExecutionCycle(monitorId); // FIX
    return;
  }

  console.log(`[loop] start pętli co ${LOOP_MS} ms`);
  // pierwsze odpalenie od razu
  await runExecutionCycle(monitorId); // FIX

  // cyklicznie
  setInterval(async () => {
    try {
      await runExecutionCycle(monitorId); // FIX
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

