// skrypt/analizaSnapshotu.js
import { mongoClient } from '../polaczenieMDB.js';
import { generateTextWithOllama } from './ollamaClient.js';
import { Double } from 'mongodb';
import { performance } from 'node:perf_hooks';


const db = mongoClient.db('inzynierka');
const analizyCol = db.collection('analizy');

const MAX_TEXT_CHARS = 8000;

function extractPriceHintFromText(text) {
  if (!text) return { value: null, currency: null };

  const s = String(text).replace(/\s+/g, ' ').trim();

  // np. "1769,00 zł", "1 699 PLN", "199 €"
  const priceWithCurrRe = /(\d[\d\s.,]*\d?)\s*(zł|pln|eur|€|usd|\$|£)/i;
  const m = s.match(priceWithCurrRe);
  if (!m) return { value: null, currency: null };

  const value = m[1].trim().replace(/\s+/g, ' ');
  const currRaw = m[2].trim();
  const c = currRaw.toLowerCase();

  let currency = null;
  if (c.includes('zł') || c === 'pln') currency = 'PLN';
  else if (c.includes('eur') || c === '€') currency = 'EUR';
  else if (c.includes('usd') || c === '$') currency = 'USD';
  else if (c.includes('£')) currency = 'GBP';

  return { value, currency };
}

export async function ensureSnapshotAnalysis(snapshot, { force = false, logger } = {}) {

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

  const ocrPrice = extractPriceHintFromText(ocrTextFull);

  let priceInfo;

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
      summary: null,
      podsumowanie: null,
      product_type: null,
      main_currency: null,
      price_hint: { min: null, max: null },
      features: [],
      raw_response: null,
      error: 'NO_INPUT_DATA',
    };

    await analizyCol.insertOne(doc);
    return doc;
  }


  const prompt = `
Jesteś asystentem analizującym strony e-commerce.
Na podstawie danych strony wygeneruj zwięzły JSON:

{
  "summary": "krótki opis (1-3 zdania) co to za strona",
  "product_type": "np. 'obuwie męskie', 'kurtki damskie', 'lista ogłoszeń', 'strona produktu' itp.",
  "main_currency": "np. 'PLN' lub null",
  "price_hint": {
    "min": number lub null,
    "max": number lub null
  },
  "features": [
    "krótka lista cech typu: 'lista ofert', 'ma filtry rozmiaru', 'zawiera promocje' itd."
  ]
}

Zawsze zwróć poprawny JSON.

Tytuł: ${title}
Opis: ${description}
${priceInfo}

Tekst strony (extractor/OCR fallback, przycięty):
${text}

${ocrPreview ? `\nOCR ze screenshotu (preview):\n${ocrPreview}\n` : ''}
`;


  let rawResponse = null;
  let parsed = null;

  try {
    const tLlm0 = performance.now();
rawResponse = await generateTextWithOllama({ prompt, logger });
logger?.info('snapshot_analysis_llm_done', {
  snapshotId: _id.toString(),
  monitorId: String(monitor_id || ''),
  zadanieId: String(zadanie_id || ''),
  url,
  durationMs: Math.round(performance.now() - tLlm0),
});


    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Brak JSON w odpowiedzi LLM');

    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    // ❌ błąd LLM – zapisujemy dokument z błędem, żeby schema się zgadzała
    const errorDoc = {
      zadanieId: String(zadanie_id),
      monitorId: String(monitor_id),
      score: new Double(0.0),
      createdAt: new Date(),

      type: 'snapshot',
      snapshot_id: _id,
      url,
      model: process.env.OLLAMA_TEXT_MODEL || 'llama3',
      prompt,

      summary: null,
      podsumowanie: null,
      product_type: null,
      main_currency: null,
      price_hint: { min: null, max: null },
      features: [],
      raw_response: rawResponse,
      error: err?.message || String(err),
    };

    logger?.error('snapshot_analysis_llm_error', {
      snapshotId: _id.toString(),
      monitorId: String(monitor_id),
      zadanieId: String(zadanie_id),
      url,
      
      error: err?.message || String(err),
      durationMs: Math.round(performance.now() - t0),
    });

    await analizyCol.insertOne(errorDoc);
    return errorDoc;
  }

  // ✅ sukces – pełny dokument analizy
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

    summary: parsed.summary ?? null,
    podsumowanie: parsed.summary ?? null,
    product_type: parsed.product_type ?? null,
    main_currency:
      parsed.main_currency ??
      extracted_v2?.price?.currency ??
      null,
    price_hint: parsed.price_hint ?? null,
    features: parsed.features ?? [],
    raw_response: rawResponse,
    error: null,
  };

logger?.info('snapshot_analysis_success', {
  snapshotId: _id.toString(),
  monitorId: String(monitor_id),
  zadanieId: String(zadanie_id),
  durationMs: Math.round(performance.now() - t0),
});

  await analizyCol.insertOne(doc);
  return doc;
}

