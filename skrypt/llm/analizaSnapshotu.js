// skrypt/analizaSnapshotu.js
import { mongoClient } from '../polaczenieMDB.js';
import { generateTextWithOllama } from './ollamaClient.js';
import { Double } from 'mongodb';

const db = mongoClient.db('inzynierka');
const snapshotsCol = db.collection('snapshots');
const analizyCol = db.collection('analizy');

const MAX_TEXT_CHARS = 8000;

export async function ensureSnapshotAnalysis(snapshot) {
  const existing = await analizyCol.findOne({
    snapshot_id: snapshot._id,
    type: 'snapshot',
  });
  if (existing) return existing;

  // ⬇⬇⬇ DODAJ TO:
  const { _id, monitor_id, zadanie_id, url, extracted_v2 } = snapshot;
  // teraz możesz używać _id, monitor_id itd. niżej
  if (!zadanie_id) {
  console.warn('Brak zadanie_id w snapshot, pomijam analizę:', _id.toString());
  return null;
}

    const title = extracted_v2?.title || '';
  const description = extracted_v2?.description || '';
  let text = extracted_v2?.text || '';

  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + '\n...[TRUNCATED]';
  }

  // ceny z pluginu (jeśli są)
  const pluginPrices = Array.isArray(snapshot.plugin_prices)
    ? snapshot.plugin_prices
    : [];

  let priceInfo;

  if (extracted_v2?.price) {
    // klasyczna cena z extractora (to co miałeś wcześniej)
    const p = extracted_v2.price;
    priceInfo = `Cena główna z extractora: ${p.value} ${p.currency}`;
  } else if (pluginPrices.length) {
    // fallback na ceny z pluginu
    const values = pluginPrices
      .map(p => Number(p.value))
      .filter(x => !Number.isNaN(x));

    if (values.length) {
      const minPrice = Math.min(...values);
      priceInfo = `Cena z pluginu (minimalna znaleziona): ${minPrice}`;
    } else {
      priceInfo = `Ceny znalezione przez plugin: ${JSON.stringify(pluginPrices).slice(0, 500)}`;
    }
  } else {
    priceInfo = 'Brak ceny w extractorze i w pluginie.';
  }


// --------------- [ KONIEC DODATKU ] ------------------


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

  let rawResponse;
  let parsed;

  try {
    rawResponse = await generateTextWithOllama({ prompt });

    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Brak JSON w odpowiedzi LLM');

    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('Błąd analizy snapshotu (warstwa 1):', err);
    return analizyCol.insertOne({
      type: 'snapshot',
      snapshot_id: snapshot._id,
      monitor_id,
      url,
      created_at: new Date(),
      model: process.env.OLLAMA_TEXT_MODEL || 'llama3',
      source: 'ollama',
      error: err.message,
    });
  }



// ...

const doc = {
  // 👇 WYMAGANE PRZEZ JSON SCHEMA:
  zadanieId: String(zadanie_id),        // string (UUID)
  monitorId: String(monitor_id),        // string (UUID)
  score: new Double(1.0),               // PEWNY double
  createdAt: new Date(),                // prawdziwy Date, NIE string

  // 👇 RESZTA TO TWOJE DODATKOWE POLA:
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




  console.log('ANALIZA DOC:', JSON.stringify(doc, null, 2));

  await analizyCol.insertOne(doc);
  return doc;
}
