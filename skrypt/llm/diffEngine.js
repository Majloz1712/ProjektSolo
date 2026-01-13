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

function isKnownExtraValue(value) {
  return value != null && value !== 'unknown';
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

function extractNumbersWithContext(text) {
  if (!text) return [];
  const t = String(text);
  const re = /(-?\d[\d\s]{0,12}(?:[.,]\d{1,2})?)(?:\s*(zł|pln|eur|€|usd|\$|gbp|£))?/gi;
  const out = [];
  let m;
  while ((m = re.exec(t))) {
    const value = toNumberMaybe(m[1]);
    if (typeof value !== 'number') continue;
    const currency = m[2] ? normalizeCurrencyFromText(m[2]) : null;
    out.push({ value, currency, raw: m[0] });
  }
  return out;
}

function uniqueNumberSet(items) {
  const map = new Map();
  for (const it of items) {
    const key = `${it.currency || ''}|${it.value.toFixed(2)}`;
    if (!map.has(key)) {
      map.set(key, { value: it.value, currency: it.currency });
    }
  }
  return [...map.values()];
}

function pickSecondaryPrices(text, limit = 6) {
  const items = extractNumbersWithContext(text).filter((it) => it.currency);
  if (!items.length) return [];
  const uniq = uniqueNumberSet(items);
  return uniq.slice(0, limit);
}

function filterSecondaryPricesByMainPrice(prices, mainPriceValue) {
  if (!Array.isArray(prices) || prices.length === 0) return [];
  if (typeof mainPriceValue !== 'number' || !Number.isFinite(mainPriceValue) || mainPriceValue <= 0) {
    return prices;
  }
  const minAllowed = mainPriceValue * 0.25;
  const maxAllowed = mainPriceValue * 4;
  return prices.filter((price) => price.value >= minAllowed && price.value <= maxAllowed);
}

function extractReviewSignals(text) {
  if (!text) return { count: null, rating: null };
  const t = String(text).toLowerCase();
  const countMatch = t.match(/(\d+)\s*(opinii|ocen|reviews|review)\b/);
  const count = countMatch ? Number(countMatch[1]) : null;
  const ratingMatch = t.match(/(\d+(?:[.,]\d+)?)\s*\/\s*5/);
  const rating = ratingMatch ? Number(ratingMatch[1].replace(',', '.')) : null;
  return {
    count: Number.isFinite(count) ? count : null,
    rating: Number.isFinite(rating) ? rating : null,
  };
}

function numericDiffScore(prevText, nowText) {
  const prevNums = extractNumbersWithContext(prevText);
  const nowNums = extractNumbersWithContext(nowText);
  const prevSet = new Set(prevNums.map((it) => `${it.currency || ''}|${it.value.toFixed(2)}`));
  const nowSet = new Set(nowNums.map((it) => `${it.currency || ''}|${it.value.toFixed(2)}`));
  if (prevSet.size === 0 && nowSet.size === 0) return 0;
  let intersection = 0;
  for (const k of prevSet) if (nowSet.has(k)) intersection += 1;
  const union = new Set([...prevSet, ...nowSet]).size;
  return union ? 1 - intersection / union : 0;
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

  const trackedFields = Array.isArray(newAnalysis?.intent?.trackedFields)
    ? newAnalysis.intent.trackedFields
    : Array.isArray(prevAnalysis?.intent?.trackedFields)
      ? prevAnalysis.intent.trackedFields
      : [];
  metrics.trackedFields = trackedFields;
  const prevTrackedFields = Array.isArray(prevAnalysis?.intent?.trackedFields)
    ? prevAnalysis.intent.trackedFields
    : [];
  const trackedFieldsChanged =
    JSON.stringify(prevTrackedFields) !== JSON.stringify(trackedFields);
  metrics.trackedFieldsChanged = trackedFieldsChanged;
  metrics.trackedExtrasChanged = false;
  metrics.trackedExtrasChanges = {};
  const extrasReasons = [];

  if (trackedFieldsChanged) {
    extrasReasons.push('tracked_fields_changed');
  }

  if (trackedFields.length > 0) {
    for (const field of trackedFields) {
      const prevExtra = prevAnalysis?.extras?.[field];
      const nowExtra = newAnalysis?.extras?.[field];
      const prevVal = prevExtra?.value;
      const nowVal = nowExtra?.value;
      const prevKnown = isKnownExtraValue(prevVal);
      const nowKnown = isKnownExtraValue(nowVal);

      if (prevKnown && nowKnown && prevVal !== nowVal) {
        metrics.trackedExtrasChanged = true;
        metrics.trackedExtrasChanges[field] = {
          before: prevVal,
          after: nowVal,
          beforeEvidence: Array.isArray(prevExtra?.evidence) ? prevExtra.evidence : [],
          afterEvidence: Array.isArray(nowExtra?.evidence) ? nowExtra.evidence : [],
          beforeSource: prevExtra?.source ?? null,
          afterSource: nowExtra?.source ?? null,
        };
        extrasReasons.push(`tracked_${field}_changed: ${prevVal} -> ${nowVal}`);
      }
    }
  }

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
  const prevCombinedText = `${prevText} ${prevOcrText}`.trim();
  const nowCombinedText = `${nowText} ${nowOcrText}`.trim();
  const textDiffScore = simpleTextDiffScore(prevText, nowText);
  metrics.textDiffScore = textDiffScore;

  if (textDiffScore > 0.05) {
    reasons.push(`zmiana treści strony (score ~${textDiffScore.toFixed(3)})`);
  }

  const numericScore = numericDiffScore(prevCombinedText, nowCombinedText);
  metrics.numericDiffScore = numericScore;
  if (numericScore > 0.1) {
    reasons.push(`zmiana danych liczbowych w treści (score ~${numericScore.toFixed(3)})`);
  }

  const prevReviews = extractReviewSignals(prevCombinedText);
  const nowReviews = extractReviewSignals(nowCombinedText);
  metrics.reviews = {
    prevCount: prevReviews.count,
    nowCount: nowReviews.count,
    prevRating: prevReviews.rating,
    nowRating: nowReviews.rating,
  };
  if (prevReviews.count != null && nowReviews.count != null && prevReviews.count !== nowReviews.count) {
    reasons.push(`zmiana liczby opinii (${prevReviews.count} → ${nowReviews.count})`);
  }
  if (prevReviews.rating != null && nowReviews.rating != null && prevReviews.rating !== nowReviews.rating) {
    reasons.push(`zmiana oceny (${prevReviews.rating} → ${nowReviews.rating})`);
  }

  const mainPriceReference = prevMainPrice?.value ?? nowMainPrice?.value ?? null;
  const prevSecondaryPrices = filterSecondaryPricesByMainPrice(
    pickSecondaryPrices(prevCombinedText),
    mainPriceReference,
  );
  const nowSecondaryPrices = filterSecondaryPricesByMainPrice(
    pickSecondaryPrices(nowCombinedText),
    mainPriceReference,
  );
  metrics.secondaryPrices = {
    prev: prevSecondaryPrices,
    now: nowSecondaryPrices,
    prevMin: prevSecondaryPrices.length ? Math.min(...prevSecondaryPrices.map((p) => p.value)) : null,
    nowMin: nowSecondaryPrices.length ? Math.min(...nowSecondaryPrices.map((p) => p.value)) : null,
    prevMax: prevSecondaryPrices.length ? Math.max(...prevSecondaryPrices.map((p) => p.value)) : null,
    nowMax: nowSecondaryPrices.length ? Math.max(...nowSecondaryPrices.map((p) => p.value)) : null,
  };
  if (
    prevSecondaryPrices.length > 0 &&
    nowSecondaryPrices.length > 0 &&
    JSON.stringify(prevSecondaryPrices) !== JSON.stringify(nowSecondaryPrices)
  ) {
    reasons.push('zmiana cen drugorzędnych (secondary prices)');
  }

  const prevImages = (prev.images || []).length;
  const nowImages = (now.images || []).length;
  metrics.imagesCount = { prev: prevImages, now: nowImages };

  if (prevImages !== nowImages) {
    reasons.push('zmieniła się liczba obrazów / ofert');
  }

  let reasonsToUse = reasons;
  let hasAnyChange = reasons.length > 0;

  if (trackedFields.length > 0) {
    reasonsToUse = metrics.trackedExtrasChanged ? extrasReasons : [];
    hasAnyChange = metrics.trackedExtrasChanged;
  }

  let hasSignificantMachineChange = false;

  if (metrics.price && metrics.price.relChange != null) {
    if (Math.abs(metrics.price.relChange) >= 0.05) {
      hasSignificantMachineChange = true;
    }
  }

  if (textDiffScore > 0.15) {
    hasSignificantMachineChange = true;
  }

  if (metrics.numericDiffScore != null && metrics.numericDiffScore > 0.2) {
    hasSignificantMachineChange = true;
  }

  if (
    (metrics.reviews?.prevCount != null &&
      metrics.reviews?.nowCount != null &&
      metrics.reviews.prevCount !== metrics.reviews.nowCount) ||
    (metrics.reviews?.prevRating != null &&
      metrics.reviews?.nowRating != null &&
      metrics.reviews.prevRating !== metrics.reviews.nowRating)
  ) {
    hasSignificantMachineChange = true;
  }

  if (
    metrics.secondaryPrices &&
    metrics.secondaryPrices.prev?.length > 0 &&
    metrics.secondaryPrices.now?.length > 0 &&
    JSON.stringify(metrics.secondaryPrices.prev) !== JSON.stringify(metrics.secondaryPrices.now)
  ) {
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

  if (trackedFields.length > 0) {
    hasSignificantMachineChange = metrics.trackedExtrasChanged;
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
    reasons: reasonsToUse,
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
