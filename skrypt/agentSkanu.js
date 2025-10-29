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
const USE_STEALTH = process.env.PUP_STEALTH === '1';

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

async function ensurePuppeteer() {
  if (puppeteer) return { puppeteer, isStealth };
  const puppeteerExtra = require('puppeteer-extra');
  const stealth = require('puppeteer-extra-plugin-stealth')();
  puppeteerExtra.use(stealth);
  puppeteer = puppeteerExtra;
  isStealth = true;
  return { puppeteer, isStealth };
}


// ---- Tryb STATIC ----
async function fetchStatic(url, { selector } = {}) {

    



    const startedAt = Date.now(); 
    const res = await fetchWithTimeout(
      url,
      {
        redirect: 'follow',
        headers: {
          'user-agent': USER_AGENT,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
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

// ---- Tryb BROWSER (Puppeteer) ----
// ---- Tryb BROWSER (Puppeteer + stealth + heurystyka bot-wall) ----
// ---- Tryb BROWSER (Puppeteer + stealth + heurystyka bot-wall + screenshot) ----
async function fetchBrowser(url, { selector } = {}) {
  const startedAt = Date.now();

  const { puppeteer } = await ensurePuppeteer();

  // opcjonalny proxy: wpisz w .env PUPPETEER_PROXY=http://user:pass@host:port
  const extraArgs = [];
  if (process.env.PUPPETEER_PROXY) {
    extraArgs.push(`--proxy-server=${process.env.PUPPETEER_PROXY}`);
  }

  const browser = await puppeteer.launch({
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
  });

  let page = null;
  try {
    page = await browser.newPage();

    // Realistyczne środowisko
    await page.emulateTimezone('Europe/Warsaw');
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/123.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'accept-language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    // Złap status dokumentu
    let navStatus = null;
    page.on('response', (resp) => {
      try {
        if (resp.request().resourceType() === 'document' && navStatus === null) {
          navStatus = resp.status();
        }
      } catch (_) {}
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: BROWSER_TIMEOUT_MS });

    // krótki „oddech” dla SPA/challenge (użyj setTimeout dla kompatybilności)
    await new Promise((r) => setTimeout(r, 800));

    if (selector) {
      try { await page.waitForSelector(selector, { timeout: 3000 }); } catch (_) {}
    }

    // Heurystyka wykrywania ściany bot-protection (DataDome/Cloudflare itp.)
    const botWall = await page.evaluate(() => {
      const txt = (document.body?.innerText || '').toLowerCase();
      const title = (document.title || '').toLowerCase();
      const hasCMsg = !!document.querySelector('#cmsg'); // "Please enable JS ..."
      const hasCaptchaDelivery = !!document.querySelector('script[src*="captcha-delivery.com"],script[src*="ct.captcha-delivery.com"]');
      return (
        hasCMsg ||
        hasCaptchaDelivery ||
        title.includes('enable js') ||
        txt.includes('enable js') ||
        txt.includes('captcha') ||
        txt.includes('bot protection')
      );
    });

    const finalUrl = page.url();

    // Pobierz treść (fragment lub całość)
    let html = null;
    if (selector) {
      html = await page.$eval(selector, (el) => el.outerHTML).catch(() => null);
    }
    if (!html) html = await page.content();
    if (html.length > TEXT_TRUNCATE_AT) html = html.slice(0, TEXT_TRUNCATE_AT);

    // Metadane
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

    // Screenshot (pomaga w debugowaniu bot-wall)
    let screenshot_b64 = null;
    try {
      const png = await page.screenshot({ fullPage: true });
      screenshot_b64 = png.toString('base64');
    } catch (_) {}

    const http_status = navStatus || 200;
    const hash = sha256(html);

    return {
      mode: 'browser',
      startedAt,
      finishedAt: Date.now(),
      final_url: finalUrl,
      http_status,
      html,
      meta,
      hash,
      blocked: !!botWall,
      block_reason: botWall ? 'BOT_PROTECTION' : null,
      screenshot_b64,
    };
  } finally {
    try { if (page) await page.close(); } catch (_) {}
    try { await browser.close(); } catch (_) {}
  }
}


// ---- Warstwa retry ----
async function scanUrl({ url, tryb, selector }) {
  const normUrl = normalizeUrl(url);
  let lastErr = null;

  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      if (tryb === 'browser') {
        return await fetchBrowser(normUrl, { selector });
      }
      return await fetchStatic(normUrl, { selector });
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
  const selector = monitor.css_selector || null;

  try {
    const result = await scanUrl({ url, tryb, selector });

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

