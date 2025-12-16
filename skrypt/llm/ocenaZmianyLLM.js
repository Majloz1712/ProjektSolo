// skrypt/ocenaZmianyLLM.js
import { generateTextWithOllama } from './ollamaClient.js';
import { pool } from '../polaczeniePG.js';
import { mongoClient } from '../polaczenieMDB.js';
import { performance } from 'node:perf_hooks';

const db = mongoClient.db('inzynierka');
const analizyCol = db.collection('analizy');        // istniejące analizy snapshotów
const ocenyZmienCol = db.collection('oceny_zmian'); // nowe/istniejące oceny zmian

export async function evaluateChangeWithLLM(
  {
    monitorId,
    zadanieId,
    url,
    prevAnalysis,
    newAnalysis,
    diff,
  },
  { logger } = {},
) {
  const log = logger || console;
  const tEval0 = performance.now();
  const finish = (result) => {
  log.info('llm_change_eval_done', {
    monitorId,
    zadanieId,
    url,
    durationMs: Math.round(performance.now() - tEval0),
    important: result?.parsed?.important ?? null,
    category: result?.parsed?.category ?? null,
  });
  return result;
};
  log.info('llm_change_eval_start', {
    monitorId,
    zadanieId,
    url,
  });

  const prompt = `
Jesteś systemem oceny zmian na stronach monitorowanych przez użytkownika.

Twoje zadanie: NA PODSTAWIE PONIŻSZYCH DANYCH zdecyduj,
czy KONKRETNA ZMIANA jest istotna dla użytkownika.

1) Analiza poprzedniego snapshota (JSON):
${JSON.stringify(prevAnalysis || {}, null, 2)}

2) Analiza nowego snapshota (JSON):
${JSON.stringify(newAnalysis || {}, null, 2)}

3) Twardy diff (JSON):
${JSON.stringify(diff || {}, null, 2)}

------------------------------------------------------------------------------------
ZASADY OCENY ISTOTNOŚCI (BARDZO WAŻNE – PRZESTRZEGAJ ICH BEZWZGLĘDNIE):

1. Jeżeli diff.metrics.pluginPricesChanged == true → ZAWSZE traktuj to jako zmianę ISTOTNĄ.
   Ustaw:
   {
     "important": true,
     "category": "price_change",
     "importance_reason": "wykryto zmianę cen (plugin_prices)"
   }

2. Jeżeli zmieniają się liczby dotyczące:
   - opinii / recenzji / ocen
   - średniej oceny (rating)
   - liczby ofert / planów / wariantów
   - liczby dostępnych sztuk / wyników
   to także traktuj zmianę jako ISTOTNĄ (kategorie: rating_change / offers_change / engagement_change).

3. Istotne są też:
   - zmiana dostępności oferty (dostępny/niedostępny),
   - wejście/wyjście z promocji,
   - istotna zmiana typu oferty/strony.

4. Nieistotne:
   - zmiany w nawigacji, stopce, kosmetyczne modyfikacje tekstu bez wpływu na cenę/dostępność/opinie/oferty.

------------------------------------------------------------------------------------
FORMAT ODPOWIEDZI (ZWRÓĆ TYLKO JEDEN JSON, DOTYCZĄCY TEJ KONKRETNEJ ZMIANY):

{
  "important": true lub false,
  "importance_reason": "krótko dlaczego",
  "category": "price_change / rating_change / offers_change / engagement_change / availability_change / content_update / minor_change",
  "short_title": "krótki tytuł",
  "short_description": "krótki opis zmiany"
}

ZWRÓĆ TYLKO JEDEN POPRAWNY JSON, BEZ DODATKOWYCH TEKSTÓW, PRZYKŁADÓW ANI "or".
`;

    // --- NOWE: bezpieczne wywołanie LLM z obsługą AbortError ---

let raw;
try {
  const tLlm0 = performance.now();
  raw = await generateTextWithOllama({ prompt });

  log.info('llm_call_done', {
    monitorId,
    zadanieId,
    url,
    durationMs: Math.round(performance.now() - tLlm0),
  });
} catch (err) {

    const isAbort = err?.name === 'AbortError';

    log.error('llm_change_eval_request_error', {
      monitorId,
      zadanieId,
      url,
      error: err?.message || String(err),
      name: err?.name || null,
      stack: err?.stack,
      aborted: isAbort,
    });

    // fallback podobny jak masz niżej dla "brak JSON", tylko z innym reason
    const priceChange =
      diff &&
      diff.metrics &&
      diff.metrics.pluginPricesChanged === true;

    const fallback = {
      important: !!priceChange,
      importance_reason: priceChange
        ? 'Brak odpowiedzi od LLM (AbortError / błąd requestu), ale diff wskazuje na zmianę cen (pluginPricesChanged == true).'
        : 'Brak odpowiedzi od LLM (AbortError / błąd requestu); traktuję zmianę jako nieistotną.',
      category: priceChange ? 'price_change' : 'llm_error',
      short_title: priceChange ? 'Zmiana cen (LLM timeout)' : 'Błąd analizy zmiany (LLM timeout)',
      short_description: priceChange
        ? 'Wykryto zmianę cen na podstawie diff, mimo błędu / timeoutu odpowiedzi LLM.'
        : 'Nie udało się uzyskać odpowiedzi od LLM (AbortError).',
    };

        const doc = {
      zadanieId,
      monitorId,
      createdAt: new Date(),
      type: 'change_evaluation',
      url,
      diff,
      model: process.env.OLLAMA_TEXT_MODEL || 'llama3',
      prompt,
      llm_decision: fallback,
      raw_response: null,
      error: err?.message || String(err),
      error_name: err?.name || null,
      aborted: isAbort,
    };


    const { insertedId } = await ocenyZmienCol.insertOne(doc);

    return {
      parsed: fallback,
      raw: null,
      mongoId: insertedId,
    };
  }

  // --- DALEJ zostawiasz swój istniejący kod: jsonText/parsed/fallback przy złym JSON ---

  let jsonText = null;
  let parsed = null;

  const trimmed = raw.trim();

  // 1) cała odpowiedź to JSON
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    jsonText = trimmed;
  }

  // 2) blok ```json ... ```
  if (!jsonText) {
    const codeBlockMatch = raw.match(/```json([\s\S]*?)```/i);
    if (codeBlockMatch && codeBlockMatch[1]) {
      jsonText = codeBlockMatch[1].trim();
    }
  }

  // 3) wszystkie bloki { ... } – spróbuj wybrać ten z kluczem "important"
  if (!jsonText) {
    const curlyMatches = raw.match(/\{[\s\S]*?\}/g);

    if (curlyMatches && curlyMatches.length > 0) {
      const withImportant = curlyMatches.filter((block) =>
        block.includes('"important"'),
      );

      if (withImportant.length > 0) {
        jsonText = withImportant[withImportant.length - 1].trim();
      } else {
        jsonText = curlyMatches[curlyMatches.length - 1].trim();
      }
    }
  }

  // Jeśli dalej nic – fallback
  if (!jsonText) {
    log.error('llm_change_eval_no_json', {
      monitorId,
      zadanieId,
      url,
      raw,
    });

    const priceChange =
      diff &&
      diff.metrics &&
      diff.metrics.pluginPricesChanged === true;

    const fallback = {
      important: !!priceChange,
      importance_reason: priceChange
        ? 'Brak JSON od LLM, ale diff wskazuje na zmianę cen (pluginPricesChanged == true).'
        : 'LLM nie zwrócił żadnego JSON; traktuję zmianę jako nieistotną.',
      category: priceChange ? 'price_change' : 'llm_error',
      short_title: priceChange ? 'Zmiana cen (fallback)' : 'Błąd analizy zmiany',
      short_description: priceChange
        ? 'Wykryto zmianę cen na podstawie diff, mimo błędu odpowiedzi LLM.'
        : 'Nie udało się znaleźć JSON-a w odpowiedzi LLM.',
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
    log.info('llm_change_eval_fallback_no_json_saved', {
      monitorId,
      zadanieId,
      mongoId: insertedId,
    });

    return { parsed: fallback, raw, mongoId: insertedId };
  }

  // 4) Parsowanie + ewentualny auto-fix
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    log.error('llm_change_eval_json_parse_error', {
      monitorId,
      zadanieId,
      url,
      jsonText,
      error: e?.message || String(e),
    });

    let fixed = jsonText.trim();
    if (fixed.startsWith('{') && !fixed.endsWith('}')) {
      fixed = fixed + '}';
      try {
        parsed = JSON.parse(fixed);
      } catch (e2) {
        log.error('llm_change_eval_json_parse_error_fixed', {
          monitorId,
          zadanieId,
          url,
          fixedJson: fixed,
          error: e2?.message || String(e2),
        });
      }
    }
  }

  if (!parsed) {
    const priceChange =
      diff &&
      diff.metrics &&
      diff.metrics.pluginPricesChanged === true;

    const fallback = {
      important: !!priceChange,
      importance_reason: priceChange
        ? 'JSON od LLM był nieparsowalny, ale diff wskazuje na zmianę cen (pluginPricesChanged == true).'
        : 'LLM zwrócił nieparsowalny JSON; traktuję zmianę jako nieistotną.',
      category: priceChange ? 'price_change' : 'llm_error',
      short_title: priceChange ? 'Zmiana cen (bad JSON)' : 'Błąd analizy zmiany',
      short_description: priceChange
        ? 'Wykryto zmianę cen na podstawie diff, mimo błędnego JSON-a od LLM.'
        : 'Nie udało się sparsować JSON-a z odpowiedzi LLM.',
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
    log.info('llm_change_eval_fallback_bad_json_saved', {
      monitorId,
      zadanieId,
      mongoId: insertedId,
    });

    return { parsed: fallback, raw, mongoId: insertedId };
  }

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

  log.info('llm_change_eval_success', {
    monitorId,
    zadanieId,
    mongoId: insertedId,
    important: parsed?.important === true,
    category: parsed?.category || null,
  });

  return { parsed, raw, mongoId: insertedId };
}


export async function saveDetectionAndNotification(
  {
    monitorId,
    zadanieId,
    url,
    snapshotMongoId,
    diff,
    llmDecision,
  },
  { logger } = {},
) {
const log = logger || console;
const tSave0 = performance.now();
let detectionId = null;
let ok = false;

const client = await pool.connect();


  try {
    await client.query('BEGIN');

    const pewnosc =
      typeof llmDecision.confidence === 'number'
        ? llmDecision.confidence
        : 1.0;

    const detectionsRes = await client.query(
      `
      INSERT INTO wykrycia (
        zadanie_id,
        url,
        tytul,
        pewnosc,
        monitor_id,
        snapshot_mongo_id,
        category,
        important,
        reason,
        diff_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
      `,
      [
        zadanieId,
        url,
        llmDecision.short_title || null,
        pewnosc,
        monitorId,
        String(snapshotMongoId),
        llmDecision.category || null,
        llmDecision.important === true,
        llmDecision.importance_reason || null,
        JSON.stringify(diff),
      ],
    );

    detectionId = detectionsRes.rows[0].id;


    // jeśli LLM uznał zmianę za nieistotną – zapisujemy wykrycie, ale bez powiadomienia
    if (llmDecision.important !== true) {
      await client.query('COMMIT');
      log.info('saveDetectionAndNotification_not_important', {
        monitorId,
        zadanieId,
        detectionId,
      });
      ok = true;
return { detectionId };

    }

    // pobranie użytkownika z monitora
    const monitorRes = await client.query(
      `SELECT uzytkownik_id FROM monitory WHERE id = $1`,
      [monitorId],
    );

    const userRow = monitorRes.rows[0];

    if (!userRow || !userRow.uzytkownik_id) {
      log.warn('saveDetectionAndNotification_missing_user', {
        monitorId,
        zadanieId,
        detectionId,
      });
      await client.query('COMMIT');
      return { detectionId };
    }

    const uzytkownikId = userRow.uzytkownik_id;

    // tworzymy powiadomienie
    await client.query(
      `
      INSERT INTO powiadomienia (
        uzytkownik_id,
        monitor_id,
        wykrycie_id,
        status,
        tresc,
        tytul
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        uzytkownikId,
        monitorId,
        detectionId,
        'oczekuje',
        llmDecision.short_description ||
          llmDecision.importance_reason ||
          'Wykryto istotną zmianę na monitorowanej stronie.',
        llmDecision.short_title || 'Zmiana na monitorowanej stronie',
      ],
    );

    await client.query('COMMIT');

    log.info('saveDetectionAndNotification_created_notification', {
      monitorId,
      zadanieId,
      detectionId,
      uzytkownikId,
    });

    return { detectionId };
  } catch (err) {
    await client.query('ROLLBACK');
    log.error('saveDetectionAndNotification_pg_error', {
      monitorId,
      zadanieId,
      error: err?.message || String(err),
      stack: err?.stack,
    });
    throw err;
} finally {
  log.info('save_detection_done', {
    monitorId,
    zadanieId,
    url,
    detectionId,
    ok,
    durationMs: Math.round(performance.now() - tSave0),
  });

  client.release();
}
}

