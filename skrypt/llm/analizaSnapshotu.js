// skrypt/analizaSnapshotu.js
import { mongoClient } from '../polaczenieMDB.js';
import { generateTextWithOllama } from './ollamaClient.js';
import { Double } from 'mongodb';
import { performance } from 'node:perf_hooks';


const db = mongoClient.db('inzynierka');
const analizyCol = db.collection('analizy');

const MAX_TEXT_CHARS = 8000;

export async function ensureSnapshotAnalysis(snapshot, { logger } = {}) {
  // jeśli już jest analiza – zwracamy ją
  const t0 = performance.now();
  const existing = await analizyCol.findOne({
    snapshot_id: snapshot._id,
    type: 'snapshot',
  });
  if (existing) {
  logger?.info('snapshot_analysis_cached', {
    snapshotId: snapshot._id.toString(),
    monitorId: String(snapshot.monitor_id || ''),
    zadanieId: String(snapshot.zadanie_id || ''),
    url: snapshot.url,
    durationMs: Math.round(performance.now() - t0),
  });
  return existing;
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

  const title = extracted_v2?.title || '';
  const description = extracted_v2?.description || '';
  let text = extracted_v2?.text || '';

  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + '\n...[TRUNCATED]';
  }

  // ceny z pluginu (jeśli są)
  const pluginPrices = Array.isArray(plugin_prices)
    ? plugin_prices
    : Array.isArray(snapshot.plugin_prices)
      ? snapshot.plugin_prices
      : [];

  let priceInfo;

  if (extracted_v2?.price) {
    const p = extracted_v2.price;
    priceInfo = `Cena główna z extractora: ${p.value} ${p.currency}`;
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
  } else {
    priceInfo = 'Brak ceny w extractorze i w pluginie.';
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

Tekst strony (przycięty):
${text}
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

