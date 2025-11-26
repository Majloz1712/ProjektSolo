// skrypt/ocenaZmianyLLM.js
import { generateTextWithOllama } from './ollamaClient.js';
import { pool } from '../polaczeniePG.js';
import { mongoClient } from '../polaczenieMDB.js';



const db = mongoClient.db('inzynierka');
const analizyCol = db.collection('analizy');        // istniejące analizy snapshotów
const ocenyZmienCol = db.collection('oceny_zmian'); // nowa kolekcja na oceny zmian

export async function evaluateChangeWithLLM({
  monitorId,
  zadanieId,
  url,
  prevAnalysis,
  newAnalysis,
  diff,
}) {
  const prompt = `
Jesteś asystentem oceniającym zmiany na stronie monitorowanej przez użytkownika.

Masz:
1) Analizę poprzedniego stanu strony (JSON):
${JSON.stringify(prevAnalysis || {}, null, 2)}

2) Analizę nowego stanu strony (JSON):
${JSON.stringify(newAnalysis || {}, null, 2)}

3) Wynik "twardego" diffu (JSON):
${JSON.stringify(diff || {}, null, 2)}

Twoje zadanie:
- Określ, czy zmiana jest ISTOTNA z punktu widzenia użytkownika, który obserwuje:
  - cenę, dostępność, typ oferty, ogólne cechy strony.
- Odpowiedz w formacie JSON **i nie dodawaj żadnego tekstu przed ani po**:

{
  "important": true lub false,
  "importance_reason": "krótko dlaczego",
  "category": "np. 'price_change', 'availability_change', 'content_update', 'minor_change'",
  "short_title": "krótki tytuł do powiadomienia",
  "short_description": "krótki opis zmiany w jednym-dwóch zdaniach"
}

Zwróć WYŁĄCZNIE JSON, bez komentarza i bez dodatkowego tekstu.
`;

  const raw = await generateTextWithOllama({ prompt });

  let parsed;
  let jsonText = null;

  // 1) Najpierw spróbuj, czy cała odpowiedź to czysty JSON
  // 1) Najpierw spróbuj, czy odpowiedź wygląda jak JSON (zaczyna się od "{")
const trimmed = raw.trim();
if (trimmed.startsWith('{')) {
  jsonText = trimmed;
} else {
  // 2) Spróbuj znaleźć blok ```json ... ```
  const codeBlockMatch = raw.match(/```json([\s\S]*?)```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    jsonText = codeBlockMatch[1].trim();
  } else {
    // 3) Ostatnia deska ratunku – pierwszy blok z klamrami
    const curlyMatch = raw.match(/\{[\s\S]*\}/);
    if (curlyMatch) {
      jsonText = curlyMatch[0];
    }
  }
}


if (!jsonText) {
  console.error('[LLM change-eval] Brak JSON w odpowiedzi LLM (warstwa 3). RAW =', raw);

  const fallback = {
    important: false,
    importance_reason: 'LLM nie zwrócił żadnego JSON; traktuję zmianę jako nieistotną.',
    category: 'llm_error',
    short_title: 'Błąd analizy zmiany',
    short_description: 'Nie udało się znaleźć JSON-a w odpowiedzi LLM.',
  };

  const doc = {
    zadanieId,
    monitorId,
    createdAt: new Date(),
    type: 'change_evaluation',
    url,
    diff,
    llm_decision: fallback,
    raw_response: raw,
    error: 'NO_JSON',
  };

  const { insertedId } = await ocenyZmienCol.insertOne(doc);
  return { parsed: fallback, raw, mongoId: insertedId };
}

// 🔽 TUTAJ DODAJEMY „AUTO-DOMKNIĘCIE” KLAMRY

try {
  parsed = JSON.parse(jsonText);
} catch (e) {
  // spróbuj naprawić typowy przypadek: brak końcowej klamry
  const fixed = jsonText.trim().startsWith('{') && !jsonText.trim().endsWith('}')
    ? jsonText.trim() + '}'
    : null;

  if (fixed) {
    try {
      parsed = JSON.parse(fixed);
    } catch (e2) {
      console.error('[LLM change-eval] JSON.parse error nawet po auto-fixie. RAW =', raw, 'JSONTEXT =', jsonText, 'FIXED =', fixed, 'ERR =', e2);
    }
  } else {
    console.error('[LLM change-eval] JSON.parse error (warstwa 3). RAW =', raw, 'JSONTEXT =', jsonText, 'ERR =', e);
  }

  if (!parsed) {
    const fallback = {
      important: false,
      importance_reason: 'LLM zwrócił nieparsowalny JSON; traktuję zmianę jako nieistotną.',
      category: 'llm_error',
      short_title: 'Błąd analizy zmiany',
      short_description: 'Nie udało się sparsować JSON-a z odpowiedzi LLM.',
    };

    const doc = {
      zadanieId,
      monitorId,
      createdAt: new Date(),
      type: 'change_evaluation',
      url,
      diff,
      llm_decision: fallback,
      raw_response: raw,
      error: 'BAD_JSON',
    };

    const { insertedId } = await ocenyZmienCol.insertOne(doc);
    return { parsed: fallback, raw, mongoId: insertedId };
  }
}

  // jeśli się udało sparsować:
  const doc = {
    zadanieId,
    monitorId,
    score: 1.0,
    createdAt: new Date(),
    type: 'change_evaluation',
    url,
    diff,
    llm_decision: parsed,
    raw_response: raw,
    error: null,
  };

  const { insertedId } = await ocenyZmienCol.insertOne(doc);

  return { parsed, raw, mongoId: insertedId };
}


// zapis do Postgresa – dopasuj nazwy kolumn do tego co masz
export async function saveDetectionAndNotification({
  monitorId,
    zadanieId,   // <<< jeżeli używasz w INSERT
  snapshotMongoId,
  diff,
  llmDecision,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // TODO: dopasuj do swojej struktury tabeli "wykrycia"
    const detectionsRes = await client.query(
      `
      INSERT INTO wykrycia (monitor_id, snapshot_mongo_id, category, important, reason, diff_json, created_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
      RETURNING id
      `,
      [
        monitorId,
        String(snapshotMongoId),
        llmDecision.category || null,
        llmDecision.important === true,
        llmDecision.importance_reason || null,
        JSON.stringify(diff),
      ]
    );

    const detectionId = detectionsRes.rows[0].id;

    if (llmDecision.important === true) {
      // TODO: dopasuj do swojej tabeli "powiadomienia"
      await client.query(
        `
        INSERT INTO powiadomienia (monitor_id, wykrycie_id, tytul, tresc, utworzone_at)
        VALUES ($1, $2, $3, $4, NOW())
        `,
        [
          monitorId,
          detectionId,
          llmDecision.short_title || 'Zmiana na monitorowanej stronie',
          llmDecision.short_description ||
            llmDecision.importance_reason ||
            'Wykryto istotną zmianę.',
        ]
      );
    }

    await client.query('COMMIT');
    return { detectionId };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Błąd zapisu wykrycia/powiadomienia do Postgres:', err);
    throw err;
  } finally {
    client.release();
  }
}
