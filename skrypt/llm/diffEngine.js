// skrypt/llm/diffEngine.js
import { mongoClient } from '../polaczenieMDB.js';
import { performance } from 'node:perf_hooks';
import crypto from 'node:crypto';

const db = mongoClient.db(process.env.MONGO_DB || 'inzynierka');
const snapshotsCol = db.collection('snapshots');
const analizyCol = db.collection('analizy');

// Znajdź poprzedni snapshot tego samego monitora (starszy po ts)
export async function getPreviousSnapshot(currentSnapshot, { logger } = {}) {
  if (!currentSnapshot) return null;

  const log = logger || console;
  const t0 = performance.now();

  const query = {
    monitor_id: currentSnapshot.monitor_id,
    ts: { $lt: currentSnapshot.ts },
  };

  const prev = await snapshotsCol
    .find(query)
    .sort({ ts: -1 })
    .limit(1)
    .next();

  const durationMs = Math.round(performance.now() - t0);

  if (durationMs >= 20) {
    log.info('diff_prev_snapshot_done', {
      monitorId: String(currentSnapshot.monitor_id || ''),
      snapshotId: currentSnapshot?._id?.toString?.() || null,
      durationMs,
      found: !!prev,
    });
  }

  return prev || null;
}

// Bardzo prosty score różnicy tekstu (0 = identyczny, 1 = zupełnie inny)
function simpleTextDiffScore(a, b) {
  if (!a && !b) return 0;
  if (!a || !b) return 1;
  if (a === b) return 0;

  const aWords = new Set(a.split(/\s+/).filter(Boolean));
  const bWords = new Set(b.split(/\s+/).filter(Boolean));

  if (aWords.size === 0 && bWords.size === 0) return 0;

  let intersection = 0;
  for (const w of aWords) {
    if (bWords.has(w)) intersection += 1;
  }

  const union = new Set([...aWords, ...bWords]).size;
  if (union === 0) return 0;

  return 1 - intersection / union;
}

function normalizeB64(b64) {
  if (!b64) return null;
  let s = String(b64).trim();
  const idx = s.indexOf('base64,');
  if (idx !== -1) s = s.slice(idx + 7);
  if (s.startsWith('data:')) {
    const comma = s.indexOf(',');
    if (comma !== -1) s = s.slice(comma + 1);
  }
  s = s.trim();
  return s.length ? s : null;
}

function sha1(str) {
  if (!str) return null;
  return crypto.createHash('sha1').update(str).digest('hex');
}


function normalizeOcrText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function toNumberMaybe(v) {
  if (v == null) return null;
  let s = String(v).replace(/\u00A0/g, ' ').trim();
  // wyciągnij pierwszą sensowną liczbę
  const m = s.match(/-?\d[\d ]*(?:[.,]\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/ /g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function normalizeCurrencyFromText(s) {
  const t = String(s || '').toLowerCase();
  if (t.includes('zł') || t.includes('pln')) return 'PLN';
  if (t.includes('€') || t.includes('eur')) return 'EUR';
  if (t.includes('$') || t.includes('usd')) return 'USD';
  if (t.includes('£') || t.includes('gbp')) return 'GBP';
  return null;
}

function parseExtractorPrice(extractedPrice) {
  if (!extractedPrice) return null;

  if (typeof extractedPrice === 'string') {
    const value = toNumberMaybe(extractedPrice);
    if (value == null) return null;
    return { value, currency: normalizeCurrencyFromText(extractedPrice) };
  }

  if (typeof extractedPrice === 'object') {
    const value = toNumberMaybe(extractedPrice.value ?? extractedPrice.amount ?? null);
    if (value == null) return null;
    const currency =
      extractedPrice.currency ??
      normalizeCurrencyFromText(extractedPrice.value ?? '') ??
      null;
    return { value, currency };
  }

  return null;
}

function parseAnalysisPrice(analysisPrice) {
  if (!analysisPrice) return null;
  if (typeof analysisPrice === 'object') {
    const value = toNumberMaybe(analysisPrice.value ?? analysisPrice.amount ?? null);
    if (value == null) return null;
    return {
      value,
      currency:
        analysisPrice.currency ??
        normalizeCurrencyFromText(analysisPrice.currency ?? '') ??
        null,
    };
  }
  return null;
}

// deterministycznie: 1 cena => bierz; wiele => bierz najczęściej występującą (mode) jeśli się powtarza
function pickMainPriceFromPluginPrices(pluginPrices) {
  if (!Array.isArray(pluginPrices) || pluginPrices.length === 0) return null;

  const parsed = pluginPrices
    .map((p) => ({
      value: toNumberMaybe(p?.value ?? p),
      currency: p?.currency ?? null,
    }))
    .filter((x) => typeof x.value === 'number');

  if (!parsed.length) return null;
  if (parsed.length === 1) return parsed[0];

  const counts = new Map();
  for (const it of parsed) {
    const key = `${it.currency || ''}|${it.value.toFixed(2)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let bestKey = null;
  let bestCount = 0;
  for (const [k, c] of counts.entries()) {
    if (c > bestCount) {
      bestCount = c;
      bestKey = k;
    }
  }

  // brak dowodu → nie zgadujemy
  if (!bestKey || bestCount < 2) return null;

  const [currencyRaw, valueRaw] = bestKey.split('|');
  return { value: Number(valueRaw), currency: currencyRaw || null };
}

// OCR fallback tylko gdy jest JEDNA unikalna cena z walutą w tekście
function parseUniquePriceFromText(text) {
  const t = String(text || '');
  const re = /(-?\d[\d\s]{0,12}(?:[.,]\d{1,2})?)\s*(zł|pln|eur|€|usd|\$|gbp|£)/gi;

  const found = [];
  let m;
  while ((m = re.exec(t))) {
    const value = toNumberMaybe(m[1]);
    if (typeof value === 'number') {
      const currency = normalizeCurrencyFromText(m[2]);
      found.push({ value, currency });
    }
  }

  if (!found.length) return null;

  const uniq = new Map();
  for (const it of found) {
    const key = `${it.currency || ''}|${it.value.toFixed(2)}`;
    uniq.set(key, it);
  }

  if (uniq.size !== 1) return null;
  return [...uniq.values()][0];
}


export async function computeMachineDiff(
  prevSnapshot,
  newSnapshot,
  { logger, prevAnalysis, newAnalysis } = {},
) {
  if (!prevSnapshot) {
    return {
      hasAnyChange: false,
      hasSignificantMachineChange: false,
      reasons: ['brak poprzedniego snapshotu'],
      metrics: {},
      prevSnapshotId: null,
      newSnapshotId: newSnapshot?._id ?? null,
    };
  }

  const log = logger || console;
  const t0 = performance.now();

  const prev = prevSnapshot.extracted_v2 || {};
  const now = newSnapshot.extracted_v2 || {};

  const reasons = [];
  const metrics = {};

  const prevPluginPrices = Array.isArray(prevSnapshot.plugin_prices)
    ? prevSnapshot.plugin_prices
    : [];
  const nowPluginPrices = Array.isArray(newSnapshot.plugin_prices)
    ? newSnapshot.plugin_prices
    : [];

  // ===== Screenshot diff (OCR/vision fallback) =====
  // NIE trzymamy base64 w metrykach – tylko hash.
  const prevShot = normalizeB64(prevSnapshot.screenshot_b64);
  const nowShot = normalizeB64(newSnapshot.screenshot_b64);

  const prevShotHash = sha1(prevShot);
  const nowShotHash = sha1(nowShot);

  // NIE trzymamy base64 – tylko hash + podstawowe meta
  metrics.screenshot = {
    prevHash: prevShotHash,
    nowHash: nowShotHash,
    prevPresent: !!prevShot,
    nowPresent: !!nowShot,
    prevChars: prevShot ? prevShot.length : 0,
    nowChars: nowShot ? nowShot.length : 0,
  };

  // twardy boolean
  metrics.screenshotChanged = Boolean(
    (prevShotHash || nowShotHash) && prevShotHash !== nowShotHash
  );

  if (metrics.screenshotChanged) {
    reasons.push('zmiana screenshotu (OCR fallback)');
  }

  // ===== OCR text diff (zapisany w snapshot.vision_ocr) =====
  const prevOcrText = normalizeOcrText(prevSnapshot?.vision_ocr?.clean_text || prevSnapshot?.vision_ocr?.text || '');
  const nowOcrText = normalizeOcrText(newSnapshot?.vision_ocr?.clean_text || newSnapshot?.vision_ocr?.text || '');

  const prevOcrHash = sha1(prevOcrText);
  const nowOcrHash = sha1(nowOcrText);

  metrics.ocr = {
    prevHash: prevOcrHash,
    nowHash: nowOcrHash,
    prevPresent: !!prevOcrText,
    nowPresent: !!nowOcrText,
    prevChars: prevOcrText ? prevOcrText.length : 0,
    nowChars: nowOcrText ? nowOcrText.length : 0,
  };

  metrics.ocrTextChanged = Boolean((prevOcrHash || nowOcrHash) && prevOcrHash !== nowOcrHash);

  const ocrTextDiffScore = simpleTextDiffScore(prevOcrText, nowOcrText);
  metrics.ocrTextDiffScore = ocrTextDiffScore;

  if (metrics.ocrTextChanged) {
    reasons.push(`zmiana tekstu OCR (score ~${ocrTextDiffScore.toFixed(3)})`);
  }


  if (JSON.stringify(prevPluginPrices) !== JSON.stringify(nowPluginPrices)) {
    metrics.pluginPricesChanged = true;
    reasons.push('zmiana cen z pluginu');
  } else {
    metrics.pluginPricesChanged = false;
  }

  const prevMainPrice =
    parseAnalysisPrice(prevAnalysis?.price) ||
    parseExtractorPrice(prev?.price) ||
    pickMainPriceFromPluginPrices(prevPluginPrices) ||
    parseUniquePriceFromText(prevOcrText);

  const nowMainPrice =
    parseAnalysisPrice(newAnalysis?.price) ||
    parseExtractorPrice(now?.price) ||
    pickMainPriceFromPluginPrices(nowPluginPrices) ||
    parseUniquePriceFromText(nowOcrText);

  if (prevMainPrice && nowMainPrice) {
    const oldVal = prevMainPrice.value;
    const newVal = nowMainPrice.value;

    if (typeof oldVal === 'number' && typeof newVal === 'number') {
      const absChange = newVal - oldVal;
      const relChange = oldVal !== 0 ? absChange / oldVal : null;

      metrics.price = { oldVal, newVal, absChange, relChange };

      if (absChange !== 0) {
        reasons.push(
          `zmiana ceny z ${oldVal} na ${newVal} (Δ=${absChange}, rel=${relChange})`,
        );
      }
    }
  }


  if (prev.title !== now.title) {
    metrics.titleChanged = true;
    reasons.push('zmiana tytułu strony');
  } else {
    metrics.titleChanged = false;
  }

  if (prev.description !== now.description) {
    metrics.descriptionChanged = true;
    reasons.push('zmiana opisu strony');
  } else {
    metrics.descriptionChanged = false;
  }

  const prevText = prev.text || '';
  const nowText = now.text || '';
  const textDiffScore = simpleTextDiffScore(prevText, nowText);
  metrics.textDiffScore = textDiffScore;

  if (textDiffScore > 0.05) {
    reasons.push(`zmiana treści strony (score ~${textDiffScore.toFixed(3)})`);
  }

  const prevImages = (prev.images || []).length;
  const nowImages = (now.images || []).length;
  metrics.imagesCount = { prev: prevImages, now: nowImages };

  if (prevImages !== nowImages) {
    reasons.push('zmieniła się liczba obrazów / ofert');
  }

  const hasAnyChange = reasons.length > 0;

  let hasSignificantMachineChange = false;

  if (metrics.price && metrics.price.relChange != null) {
    if (Math.abs(metrics.price.relChange) >= 0.05) {
      hasSignificantMachineChange = true;
    }
  }

  if (textDiffScore > 0.15) {
    hasSignificantMachineChange = true;
  }

  //if (typeof metrics.ocrTextDiffScore === 'number' && metrics.ocrTextDiffScore > 0.20) {
    //hasSignificantMachineChange = true;
  //}

  if (metrics.pluginPricesChanged) {
    hasSignificantMachineChange = true;
  }

  // screenshot diff traktujemy jako istotny na maszynowej warstwie
  if (metrics.screenshotChanged) {
    hasSignificantMachineChange = true;
  }

  const durationMs = Math.round(performance.now() - t0);
  if (durationMs >= 10) {
    log.info('diff_compute_done', {
      prevSnapshotId: prevSnapshot?._id?.toString?.() || null,
      newSnapshotId: newSnapshot?._id?.toString?.() || null,
      durationMs,
      hasAnyChange,
      hasSignificantMachineChange,
    });
  }

  return {
    hasAnyChange,
    hasSignificantMachineChange,
    reasons,
    metrics,
    prevSnapshotId: prevSnapshot._id,
    newSnapshotId: newSnapshot._id,
  };
}

export async function getSnapshotAnalysis(snapshotId, { logger } = {}) {
  const log = logger || console;
  const t0 = performance.now();

  const doc = await analizyCol.findOne({
    snapshot_id: snapshotId,
    type: 'snapshot',
  });

  const durationMs = Math.round(performance.now() - t0);
  if (durationMs >= 20) {
    log.info('diff_get_analysis_done', {
      snapshotId: snapshotId?.toString?.() || String(snapshotId),
      durationMs,
      found: !!doc,
    });
  }

  return doc;
}
