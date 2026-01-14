// skrypt/analizaSnapshotu.js
import { mongoClient } from '../polaczenieMDB.js';
import { generateTextWithOllama } from './ollamaClient.js';
import {
  sanitizeNullableString as sanitizeNullableStringUtil,
  sanitizeRequiredString as sanitizeRequiredStringUtil,
  parseTrackedFields,
  hashUserPrompt,
  parseJsonFromLLM,
  parseKeyValueBlock,
} from './analysisUtils.js';
import { Double } from 'mongodb';
import { performance } from 'node:perf_hooks';


const db = mongoClient.db('inzynierka');
const analizyCol = db.collection('analizy');

const MAX_TEXT_CHARS = 8000;


function toNumberMaybe(v) {
  if (v == null) return null;
  const s = String(v)
    .replace(/\u00A0/g, ' ')
    .replace(/[^\d.,-]/g, ' ')
    .trim();

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

// ostrożnie: bierz tylko gdy się powtarza (mode), żeby nie zgadywać “main”
function pickMainPriceFromPluginPrices(pluginPrices) {
  if (!Array.isArray(pluginPrices) || pluginPrices.length === 0) return null;

  const parsed = pluginPrices
    .map((p) => ({
      value: toNumberMaybe(p?.value ?? p),
      currency: p?.currency ?? null,
      raw: p,
    }))
    .filter((x) => typeof x.value === 'number');

  if (!parsed.length) return null;

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

  // jeśli nic się nie powtarza → brak dowodu, nie zgadujemy
  if (!bestKey || bestCount < 2) return null;

  const [currencyRaw, valueRaw] = bestKey.split('|');
  return {
    value: Number(valueRaw),
    currency: currencyRaw || null,
  };
}








function extractPriceHintFromText(text) {
  if (!text) return { value: null, currency: null };

  const s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return { value: null, currency: null };

  // np. "1769,00 zł", "1 699 PLN", "199 €"
  const priceWithCurrRe = /(\d[\d\s.,]*\d?)\s*(zł|pln|eur|€|usd|\$|£)/gi;
  const deliveryHints = [
    'dostawa',
    'wysyłka',
    'shipping',
    'delivery',
    'przesyłka',
    'odbiór',
  ];
  const mainPriceHints = ['cena', 'price', 'wartość', 'do zapłaty', 'pay'];

  const candidates = [];
  let match;
  while ((match = priceWithCurrRe.exec(s))) {
    const rawValue = match[1].trim().replace(/\s+/g, ' ');
    const currRaw = match[2].trim();
    const c = currRaw.toLowerCase();
    let currency = null;
    if (c.includes('zł') || c === 'pln') currency = 'PLN';
    else if (c.includes('eur') || c === '€') currency = 'EUR';
    else if (c.includes('usd') || c === '$') currency = 'USD';
    else if (c.includes('£')) currency = 'GBP';

    const value = toNumberMaybe(rawValue);
    if (typeof value !== 'number') continue;

    const contextStart = Math.max(0, match.index - 40);
    const contextEnd = Math.min(s.length, match.index + match[0].length + 40);
    const context = s.slice(contextStart, contextEnd).toLowerCase();
    const isDelivery = deliveryHints.some((hint) => context.includes(hint));
    const hasMainHint = mainPriceHints.some((hint) => context.includes(hint));

    candidates.push({
      value,
      currency,
      isDelivery,
      hasMainHint,
    });
  }

  if (!candidates.length) return { value: null, currency: null };

  const preferred = candidates.filter((c) => !c.isDelivery);
  const pool = preferred.length ? preferred : candidates;
  const withMainHint = pool.filter((c) => c.hasMainHint);
  const ranked = withMainHint.length ? withMainHint : pool;
  ranked.sort((a, b) => b.value - a.value);

  const winner = ranked[0];
  return { value: winner.value, currency: winner.currency };
}

function normalizePriceObject(price) {
  if (!price || typeof price !== 'object') {
    return { value: null, currency: null };
  }
  const value = toNumberMaybe(price.value ?? price.amount ?? null);
  return {
    value: typeof value === 'number' ? value : null,
    currency: sanitizeNullableStringUtil(price.currency),
  };
}

function normalizePriceHint(input) {
  if (!input || typeof input !== 'object') {
    return { min: null, max: null };
  }
  const min = toNumberMaybe(input.min ?? null);
  const max = toNumberMaybe(input.max ?? null);
  return {
    min: typeof min === 'number' ? min : null,
    max: typeof max === 'number' ? max : null,
  };
}

function normalizeFeatures(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => (item == null ? '' : String(item).trim()))
    .filter((item) => item.length > 0);
}

function parseFeatures(input) {
  if (!input) return [];
  const items = Array.isArray(input) ? input : [input];
  return items
    .flatMap((item) => String(item).split(/\r?\n|\|/))
    .map((part) => part.replace(/^-+\s*/, '').trim())
    .filter((part) => part.length > 0);
}

function normalizeUserPromptValue(input) {
  const trimmed = (input ?? '').toString().trim();
  return trimmed.length ? trimmed : null;
}

function buildUnknownExtra(source) {
  return {
    value: 'unknown',
    confidence: 0,
    evidence: [],
    source: source || 'ocr',
  };
}

function normalizeEvidenceArray(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => (item == null ? '' : String(item).trim()))
    .filter((item) => item.length > 0);
}

function buildContextPack({ title, description, text, ocrText, pluginPrices }) {
  const extractedText = [title, description, text]
    .map((item) => (item == null ? '' : String(item).trim()))
    .filter((item) => item.length > 0)
    .join('\n');

  const ocr = String(ocrText || '');
  const plugin = pluginPrices && pluginPrices.length ? JSON.stringify(pluginPrices) : '';

  const combined = [extractedText, plugin, ocr].filter((item) => item.length > 0).join('\n');

  return {
    extractedText,
    ocrText: ocr,
    pluginText: plugin,
    contextPackText: combined,
  };
}

function pickEvidenceSource(evidence, contextPack) {
  if (!evidence) return null;
  if (contextPack.ocrText.includes(evidence)) return 'ocr';
  if (contextPack.extractedText.includes(evidence)) return 'extracted';
  if (contextPack.pluginText.includes(evidence)) return 'plugin';
  return null;
}

function sanitizeExtrasFromLLM({ trackedFields, rawExtras, contextPack }) {
  const extras = {};
  const allowedSources = new Set(['ocr', 'extracted', 'plugin']);

  for (const field of trackedFields) {
    const candidate = rawExtras && typeof rawExtras === 'object' ? rawExtras[field] : null;
    if (!candidate || typeof candidate !== 'object') {
      extras[field] = buildUnknownExtra('ocr');
      continue;
    }

    const evidence = normalizeEvidenceArray(candidate.evidence);
    const source = allowedSources.has(candidate.source) ? candidate.source : 'ocr';
    const contextText =
      source === 'ocr'
        ? contextPack.ocrText
        : source === 'extracted'
          ? contextPack.extractedText
          : source === 'plugin'
            ? contextPack.pluginText
            : '';
    const packText = contextPack.contextPackText || '';

    if (!evidence.length || !packText) {
      extras[field] = buildUnknownExtra(source);
      continue;
    }

    const evidenceOk = evidence.every((snippet) => contextText.includes(snippet));
    const evidenceOkInPack = evidence.every((snippet) => packText.includes(snippet));
    if (!evidenceOk || !evidenceOkInPack) {
      extras[field] = buildUnknownExtra(source);
      continue;
    }

    let value = candidate.value;
    if (field === 'main_price' || field === 'review_count' || field === 'rating') {
      value = toNumberMaybe(value);
    }

    if (value == null) {
      extras[field] = buildUnknownExtra(source);
      continue;
    }

    const confidence =
      typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence)
        ? Math.max(0, Math.min(1, candidate.confidence))
        : 0;

    extras[field] = {
      value,
      confidence,
      evidence,
      source,
    };
  }

  return extras;
}

function extractReviewCountFromText(text) {
  const s = String(text || '');
  const re = /(\d+)\s*(opinii|opinie|reviews|review)/i;
  const match = s.match(re);
  if (!match) return null;
  const value = toNumberMaybe(match[1]);
  if (value == null) return null;
  return { value, evidence: match[0] };
}

function extractRatingFromText(text) {
  const s = String(text || '');
  const slashMatch = s.match(/(\d+(?:[.,]\d+)?)\s*\/\s*5/i);
  if (slashMatch) {
    const value = toNumberMaybe(slashMatch[1]);
    if (value != null) return { value, evidence: slashMatch[0] };
  }
  const ratingMatch = s.match(/rating\s*(\d+(?:[.,]\d+)?)/i);
  if (!ratingMatch) return null;
  const value = toNumberMaybe(ratingMatch[1]);
  if (value == null) return null;
  return { value, evidence: ratingMatch[0] };
}

function extractPriceEvidenceFromText(text) {
  const s = String(text || '');
  const priceWithCurrRe = /(\d[\d\s.,]*\d?)\s*(zł|pln|eur|€|usd|\$|£)/gi;
  const match = priceWithCurrRe.exec(s);
  if (!match) return null;
  const value = toNumberMaybe(match[1]);
  if (value == null) return null;
  const currency = normalizeCurrencyFromText(match[2]);
  return { value, currency, evidence: match[0] };
}

function findPriceEvidenceForValue(text, targetValue) {
  if (targetValue == null) return null;
  const s = String(text || '');
  const priceWithCurrRe = /(\d[\d\s.,]*\d?)\s*(zł|pln|eur|€|usd|\$|£)/gi;
  let match;
  while ((match = priceWithCurrRe.exec(s))) {
    const value = toNumberMaybe(match[1]);
    if (value == null) continue;
    if (Number(value) === Number(targetValue)) {
      const currency = normalizeCurrencyFromText(match[2]);
      return { value, currency, evidence: match[0] };
    }
  }
  return null;
}

async function extractExtrasForTrackedFields({
  trackedFields,
  contextPack,
  extracted_v2,
  pluginPrices,
  mainPrice,
  logger,
}) {
  if (!trackedFields.length) return {};

  const basePrompt = `
Jesteś ekstraktorem pól z danych wejściowych.
Zwróć WYŁĄCZNIE JSON w formacie:
{
  "extras": {
    "<field>": {
      "value": number lub "unknown",
      "confidence": number (0..1),
      "evidence": ["dokładne cytaty z danych wejściowych"],
      "source": "ocr" | "extracted" | "plugin"
    }
  }
}

Zwracaj WYŁĄCZNIE pola: ${trackedFields.join(', ')}.
Nie zgaduj. Jeśli nie potrafisz poprzeć wartości cytatem z danych wejściowych -> ustaw value="unknown", confidence=0, evidence=[].
Nie używaj liczb z instrukcji użytkownika jako źródła prawdy.

INPUT DATA (OCR/DOM/PLUGIN):
${contextPack.contextPackText || '[EMPTY]'}
`.trim();

  let rawResponse = null;
  let rawExtras = null;

  try {
    rawResponse = await generateTextWithOllama({
      prompt: basePrompt,
      logger,
      temperature: 0,
    });

    const parsed = parseJsonFromResponse(rawResponse);
    if (parsed && typeof parsed === 'object') {
      rawExtras = parsed.extras || parsed;
    }
  } catch (err) {
    logger?.warn?.('snapshot_extras_llm_error', {
      error: err?.message || String(err),
    });
  }

  if (rawExtras && typeof rawExtras === 'object') {
    return sanitizeExtrasFromLLM({
      trackedFields,
      rawExtras,
      contextPack,
    });
  }

  const fallbackRawExtras = {};
  const combinedText = contextPack.contextPackText;

  if (trackedFields.includes('main_price')) {
    const fallbackValue = typeof mainPrice?.value === 'number' ? mainPrice.value : null;

    if (fallbackValue != null) {
      const extractedPriceRaw = extracted_v2?.price
        ? typeof extracted_v2.price === 'string'
          ? extracted_v2.price
          : `${extracted_v2.price?.value ?? ''} ${extracted_v2.price?.currency ?? ''}`.trim()
        : '';
      const extractedParsed = extracted_v2?.price ? parseExtractorPrice(extracted_v2.price) : null;
      const pluginMain = pluginPrices.length ? pickMainPriceFromPluginPrices(pluginPrices) : null;

      if (extracted_v2?.price) {
        if (extractedParsed && typeof extractedParsed.value === 'number' && extractedParsed.value === fallbackValue) {
          const evidence = extractedPriceRaw && combinedText.includes(extractedPriceRaw) ? extractedPriceRaw : null;
          if (evidence) {
            fallbackRawExtras.main_price = {
              value: extractedParsed.value,
              confidence: 0.6,
              evidence: [evidence],
              source: 'extracted',
            };
          }
        }
      }

      if (!fallbackRawExtras.main_price && pluginPrices.length) {
        if (pluginMain && typeof pluginMain.value === 'number' && pluginMain.value === fallbackValue) {
          const matching = pluginPrices.find((p) => toNumberMaybe(p?.value ?? p) === pluginMain.value);
          const evidence = matching ? JSON.stringify(matching) : null;
          if (evidence && combinedText.includes(evidence)) {
            fallbackRawExtras.main_price = {
              value: pluginMain.value,
              confidence: 0.5,
              evidence: [evidence],
              source: 'plugin',
            };
          }
        }
      }

      if (!fallbackRawExtras.main_price) {
        const evidence =
          findPriceEvidenceForValue(combinedText, fallbackValue) ||
          extractPriceEvidenceFromText(combinedText);
        if (evidence && typeof evidence.value === 'number' && evidence.value === fallbackValue) {
          fallbackRawExtras.main_price = {
            value: evidence.value,
            confidence: 0.5,
            evidence: [evidence.evidence],
            source: 'ocr',
          };
        }
      }

      if (!fallbackRawExtras.main_price) {
        const inferredSource =
          pluginMain && pluginMain.value === fallbackValue
            ? 'plugin'
            : extractedParsed && extractedParsed.value === fallbackValue
              ? 'extracted'
              : 'ocr';
        fallbackRawExtras.main_price = {
          value: fallbackValue,
          confidence: 0,
          evidence: [],
          source: inferredSource,
        };
      }
    }
  }

  if (trackedFields.includes('review_count')) {
    const reviewMatch = extractReviewCountFromText(combinedText);
    if (reviewMatch) {
      const source = pickEvidenceSource(reviewMatch.evidence, contextPack);
      fallbackRawExtras.review_count = {
        value: reviewMatch.value,
        confidence: 0.5,
        evidence: [reviewMatch.evidence],
        source: source || 'ocr',
      };
    }
  }

  if (trackedFields.includes('rating')) {
    const ratingMatch = extractRatingFromText(combinedText);
    if (ratingMatch) {
      const source = pickEvidenceSource(ratingMatch.evidence, contextPack);
      fallbackRawExtras.rating = {
        value: ratingMatch.value,
        confidence: 0.5,
        evidence: [ratingMatch.evidence],
        source: source || 'ocr',
      };
    }
  }

  return sanitizeExtrasFromLLM({
    trackedFields,
    rawExtras: fallbackRawExtras,
    contextPack,
  });
}

function parseJsonFromResponse(rawResponse) {
  const parsed = parseJsonFromLLM(rawResponse);
  return parsed.ok ? parsed.data : null;
}

async function safeInsertAnalysis(doc, { logger, snapshotId } = {}) {
  let insertedId = null;
  try {
    const result = await analizyCol.insertOne(doc);
    insertedId = result?.insertedId ?? null;
  } catch (err) {
    logger?.error?.('snapshot_analysis_insert_failed', {
      snapshotId: snapshotId?.toString?.() || String(snapshotId || ''),
      code: err?.code ?? null,
      message: err?.message || String(err),
      errInfo: err?.errInfo ?? null,
    });
  }
  return { doc, insertedId };
}

export async function ensureSnapshotAnalysis(snapshot, { force = false, logger, userPrompt } = {}) {

  // jeśli już jest analiza – zwracamy ją
  const t0 = performance.now();
  const existing = await analizyCol.findOne({
    snapshot_id: snapshot._id,
    type: 'snapshot',
  });

  // jeśli już jest analiza – zwracamy ją (chyba że force=true)
  if (existing && !force) {
    logger?.info('snapshot_analysis_cached', {
      snapshotId: snapshot._id.toString(),
      monitorId: String(snapshot.monitor_id || ''),
      zadanieId: String(snapshot.zadanie_id || ''),
      url: snapshot.url,
      durationMs: Math.round(performance.now() - t0),
    });
    return existing;
  }

  // force=true → kasujemy starą analizę i generujemy nową
  if (existing && force) {
    await analizyCol.deleteOne({ _id: existing._id });
    logger?.info('snapshot_analysis_force_regenerate', {
      snapshotId: snapshot._id.toString(),
      monitorId: String(snapshot.monitor_id || ''),
      zadanieId: String(snapshot.zadanie_id || ''),
      url: snapshot.url,
    });
  }



  const {
    _id,
    monitor_id,
    zadanie_id,
    url,
    extracted_v2,
    plugin_prices,
  } = snapshot;

  if (!zadanie_id) {
    logger?.warn('snapshot_missing_zadanie_id', {
      snapshotId: _id.toString(),
      monitorId: String(monitor_id || ''),
      url,
    });
    return null;
  }

  logger?.info('snapshot_analysis_start', {
    snapshotId: _id.toString(),
    monitorId: String(monitor_id || ''),
    zadanieId: String(zadanie_id || ''),
    url,
  });

  const title = (extracted_v2?.title || '').toString();
  const description = (extracted_v2?.description || '').toString();

  // OCR może być jedynym sensownym źródłem treści (np. Allegro/Booking, dużo JS)
  const ocrTextFull =
    snapshot?.vision_ocr?.clean_text ||
    snapshot?.vision_ocr?.clean_text_preview ||
    '';

  let text = (extracted_v2?.text || '').toString();

  // fallback: extractor dał pusty tekst → bierz OCR
  if (!text.trim() && ocrTextFull) {
    text = ocrTextFull;
  }

  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + '\n...[TRUNCATED]';
  }

  const ocrPreview = ocrTextFull
    ? ocrTextFull.slice(0, Math.min(MAX_TEXT_CHARS, 3500))
    : '';

  // ceny z pluginu (jeśli są)
  const pluginPrices = Array.isArray(plugin_prices)
    ? plugin_prices
    : Array.isArray(snapshot.plugin_prices)
      ? snapshot.plugin_prices
      : [];

  const normalizedUserPrompt = normalizeUserPromptValue(userPrompt);
  const { trackedFields, strict } = parseTrackedFields(normalizedUserPrompt);
  const intent = {
    userPrompt: normalizedUserPrompt,
    userPromptHash: hashUserPrompt(normalizedUserPrompt),
    schemaVersion: 'extras_v1',
    trackedFields,
    strict,
  };

  const ocrPrice = extractPriceHintFromText(ocrTextFull);
  const extractorMain = parseExtractorPrice(extracted_v2?.price);
const pluginMain = pickMainPriceFromPluginPrices(pluginPrices);

// OCR fallback zostawiamy jako “hint”, ale też parsujemy do number
const ocrMain =
  ocrPrice?.value ? { value: toNumberMaybe(ocrPrice.value), currency: ocrPrice.currency ?? null } : null;

const mainPrice =
  extractorMain ||
  pluginMain ||
  (ocrMain && typeof ocrMain.value === 'number' ? ocrMain : null);


  let priceInfo;
  const contextPack = buildContextPack({
    title,
    description,
    text,
    ocrText: ocrTextFull,
    pluginPrices,
  });

  const extras = await extractExtrasForTrackedFields({
    trackedFields,
    contextPack,
    extracted_v2,
    pluginPrices,
    mainPrice,
    logger,
  });

  // extractor: obsłuż i "object", i "string"
  if (extracted_v2?.price) {
    const p = extracted_v2.price;
    if (typeof p === 'string') {
      priceInfo = `Cena główna z extractora: ${p}`;
    } else {
      priceInfo = `Cena główna z extractora: ${p.value ?? ''} ${p.currency ?? ''}`.trim();
    }
  } else if (pluginPrices.length) {
    const values = pluginPrices
      .map((p) => Number(p.value))
      .filter((x) => !Number.isNaN(x));

    if (values.length) {
      const minPrice = Math.min(...values);
      priceInfo = `Cena z pluginu (minimalna znaleziona): ${minPrice}`;
    } else {
      priceInfo = `Ceny znalezione przez plugin: ${JSON.stringify(pluginPrices).slice(0, 500)}`;
    }
  } else if (ocrPrice.value) {
    priceInfo = `Cena z OCR: ${ocrPrice.value}${ocrPrice.currency ? ` ${ocrPrice.currency}` : ''}`;
  } else {
    priceInfo = 'Brak ceny w extractorze i w pluginie (i nie wykryto jej z OCR).';
  }

  // twardy guard: jak naprawdę nie ma danych → nie odpalaj LLM
  const hasAnyInput =
    !!title.trim() || !!description.trim() || !!text.trim() || (pluginPrices.length > 0) || !!ocrTextFull.trim();

  if (!hasAnyInput) {
    const doc = {
      zadanieId: String(zadanie_id),
      monitorId: String(monitor_id),
      score: new Double(0.0),
      createdAt: new Date(),
      type: 'snapshot',
      snapshot_id: _id,
      url,
      model: process.env.OLLAMA_TEXT_MODEL || 'llama3',
      prompt: null,
      summary: '',
      podsumowanie: '',
      product_type: '',
      main_currency: null,
      price: { value: null, currency: null },
      price_hint: { min: null, max: null },
      features: [],
      intent,
      extras,
      raw_response: null,
      error: 'NO_INPUT_DATA',
    };


    const { doc: storedDoc, insertedId } = await safeInsertAnalysis(doc, {
      logger,
      snapshotId: _id,
    });
    if (insertedId) {
      storedDoc._id = insertedId;
      storedDoc._inserted = true;
    } else {
      storedDoc._id = null;
      storedDoc._inserted = false;
    }
    return storedDoc;
  }


  const dataBlock = `
Tytuł: ${title}
Opis: ${description}
${priceInfo}

Tekst strony (extractor/OCR fallback, przycięty):
${text}

${ocrPreview ? `\nOCR ze screenshotu (preview):\n${ocrPreview}\n` : ''}
`;

  const userPromptSection = normalizedUserPrompt
    ? `
Instrukcje użytkownika:
${normalizedUserPrompt}
`
    : '';

  const prompt = `
Jesteś asystentem analizującym strony e-commerce.
Zwróć WYŁĄCZNIE blok w formacie:

BEGIN_TRACKLY_ANALYSIS
SUMMARY=krótki opis (1-3 zdania) co to za strona
PRODUCT_TYPE=np. 'obuwie męskie', 'kurtki damskie', 'lista ogłoszeń', 'strona produktu'
MAIN_CURRENCY=PLN|null
PRICE_MIN=number|null
PRICE_MAX=number|null
FEATURE=- krótka lista cech typu: 'lista ofert', 'ma filtry rozmiaru', 'zawiera promocje'
END_TRACKLY_ANALYSIS

ZWRÓĆ WYŁĄCZNIE TEN BLOK — bez żadnego dodatkowego tekstu, komentarzy, markdown ani bloków kodu.

${userPromptSection}
${dataBlock}
`;


  let rawResponse = null;
  let parsed = null;
  let parsedKvMode = 'none';
  let parsedKvDirect = false;
  let parsedKvExtracted = false;
  let fallbackUsed = false;
  let fallbackReason = null;

  try {
    const tLlm0 = performance.now();
const analysisTimeoutMsRaw = Number(process.env.OLLAMA_TIMEOUT_MS_ANALYSIS);
const analysisTimeoutMs = Number.isFinite(analysisTimeoutMsRaw) ? analysisTimeoutMsRaw : undefined;
rawResponse = await generateTextWithOllama({
  prompt,
  logger,
  options: { temperature: 0 },
  timeoutMs: analysisTimeoutMs,
});
logger?.info('snapshot_analysis_llm_done', {
  snapshotId: _id.toString(),
  monitorId: String(monitor_id || ''),
  zadanieId: String(zadanie_id || ''),
  url,
  durationMs: Math.round(performance.now() - tLlm0),
});


    const parsedResult = parseKeyValueBlock(rawResponse, {
      beginMarker: 'BEGIN_TRACKLY_ANALYSIS',
      endMarker: 'END_TRACKLY_ANALYSIS',
      keys: ['SUMMARY', 'PRODUCT_TYPE', 'MAIN_CURRENCY', 'PRICE_MIN', 'PRICE_MAX', 'FEATURE'],
    });
    parsed = parsedResult.ok ? parsedResult.data : null;
    parsedKvMode = parsedResult.mode || 'none';
    parsedKvDirect = parsedKvMode === 'direct';
    parsedKvExtracted = parsedKvMode === 'extracted';
    logger?.info('analysis_kv_parse_mode', {
      snapshotId: _id.toString(),
      kv_parse_mode: parsedKvMode,
    });
    logger?.info('analysis_kv_extract_used', {
      snapshotId: _id.toString(),
      kv_extract_used: parsedKvExtracted,
    });
    if (!parsed) {
      logger?.info('analysis_kv_extract_error', {
        snapshotId: _id.toString(),
        kv_extract_error: parsedResult.error || 'LLM_NO_BLOCK_FOUND',
      });
      fallbackUsed = true;
      fallbackReason = parsedResult.error || 'LLM_NO_BLOCK_FOUND';
    }
  } catch (err) {
    fallbackUsed = true;
    fallbackReason = err?.message || String(err);
  }

  if (fallbackUsed) {
    const normalizedPrice = normalizePriceObject(mainPrice);

    const fallbackDoc = {
      zadanieId: String(zadanie_id),
      monitorId: String(monitor_id),
      score: new Double(0.0),
      createdAt: new Date(),

      type: 'snapshot',
      snapshot_id: _id,
      url,
      model: process.env.OLLAMA_TEXT_MODEL || 'llama3',
      prompt,

      summary: '',
      podsumowanie: '',
      product_type: '',
      main_currency: null,
      price: normalizedPrice,
      price_hint: { min: null, max: null },
      features: [],
      intent,
      extras,
      raw_response: rawResponse != null ? String(rawResponse) : null,
      parsed_kv_mode: parsedKvMode,
      parsed_kv_direct: parsedKvDirect,
      parsed_kv_extracted: parsedKvExtracted,
      parsed_json_extracted: false,
      parsed_json_direct: false,
      fallback_used: true,
      fallback_reason: 'NO_KV_FROM_LLM',
      error: 'LLM_NO_BLOCK_FOUND',
    };

    logger?.warn('snapshot_analysis_llm_fallback', {
      snapshotId: _id.toString(),
      monitorId: String(monitor_id),
      zadanieId: String(zadanie_id),
      url,
      fallbackReason,
      durationMs: Math.round(performance.now() - t0),
    });

    const { doc: storedDoc, insertedId } = await safeInsertAnalysis(fallbackDoc, {
      logger,
      snapshotId: _id,
    });
    if (insertedId) {
      storedDoc._id = insertedId;
      storedDoc._inserted = true;
    } else {
      storedDoc._id = null;
      storedDoc._inserted = false;
    }
    return storedDoc;
  }

  // ✅ sukces – pełny dokument analizy
  const normalizedPrice = normalizePriceObject(mainPrice);
  const normalizedMainCurrency =
    sanitizeNullableStringUtil(parsed?.MAIN_CURRENCY) ||
    normalizedPrice.currency ||
    sanitizeNullableStringUtil(extracted_v2?.price?.currency);
  const priceHint = {
    min: toNumberMaybe(parsed?.PRICE_MIN ?? null),
    max: toNumberMaybe(parsed?.PRICE_MAX ?? null),
  };
  const features = parseFeatures(parsed?.FEATURE);
  const doc = {
    zadanieId: String(zadanie_id),
    monitorId: String(monitor_id),
    score: new Double(1.0),
    createdAt: new Date(),

    type: 'snapshot',
    snapshot_id: _id,
    url,
    model: process.env.OLLAMA_TEXT_MODEL || 'llama3',
    prompt,

    summary: sanitizeRequiredStringUtil(parsed?.SUMMARY),
    podsumowanie: sanitizeRequiredStringUtil(parsed?.SUMMARY),
    product_type: sanitizeRequiredStringUtil(parsed?.PRODUCT_TYPE),
    main_currency: normalizedMainCurrency,
    price: normalizedPrice,
    price_hint: normalizePriceHint(priceHint),
    features: normalizeFeatures(features),
    intent,
    extras,
    raw_response: rawResponse != null ? String(rawResponse) : null,
    parsed_kv_mode: parsedKvMode,
    parsed_kv_direct: parsedKvDirect,
    parsed_kv_extracted: parsedKvExtracted,
    parsed_json_extracted: false,
    parsed_json_direct: false,
    fallback_used: false,
    fallback_reason: null,
    error: null,
  };


logger?.info('snapshot_analysis_success', {
  snapshotId: _id.toString(),
  monitorId: String(monitor_id),
  zadanieId: String(zadanie_id),
  durationMs: Math.round(performance.now() - t0),
});

  const { doc: storedDoc, insertedId } = await safeInsertAnalysis(doc, {
    logger,
    snapshotId: _id,
  });
  if (insertedId) {
    storedDoc._id = insertedId;
    storedDoc._inserted = true;
  } else {
    storedDoc._id = null;
    storedDoc._inserted = false;
  }
  return storedDoc;
}
