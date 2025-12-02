// skrypt/ocenaZmianyLLM.js
import { generateTextWithOllama } from './ollamaClient.js';
import { pool } from '../polaczeniePG.js';
import { mongoClient } from '../polaczenieMDB.js';

const db = mongoClient.db('inzynierka');
const analizyCol = db.collection('analizy');        // istniejące analizy snapshotów
const ocenyZmienCol = db.collection('oceny_zmian'); // nowe/istniejące oceny zmian

export async function evaluateChangeWithLLM({
  monitorId,
  zadanieId,
  url,
  prevAnalysis,
  newAnalysis,
  diff,
}) {
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

  const raw = await generateTextWithOllama({ prompt });

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
    const curlyMatches = raw.match(/\{[\s\S]*?\}/g); // lazy: wiele małych bloków

    if (curlyMatches && curlyMatches.length > 0) {
      // Najpierw szukamy bloków, które wyglądają jak decyzja LLM
      const withImportant = curlyMatches.filter((block) =>
        block.includes('"important"'),
      );

      if (withImportant.length > 0) {
        // weź ostatni blok z "important"
        jsonText = withImportant[withImportant.length - 1].trim();
      } else {
        // fallback: jak nic nie ma z "important", bierz ostatni jak wcześniej
        jsonText = curlyMatches[curlyMatches.length - 1].trim();
      }
    }
  }

  // Jeśli dalej nic – fallback
  if (!jsonText) {
    console.error('[LLM change-eval] Brak JSON w odpowiedzi LLM (warstwa 3). RAW =', raw);

    // fallback: jeżeli LLM nie zwrócił JSON, ale diff mówi o zmianie cen → i tak ISTOTNE
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
    return { parsed: fallback, raw, mongoId: insertedId };
  }

  // 4) Parsowanie + ewentualny auto-fix
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    console.error('[LLM change-eval] JSON.parse error (warstwa 3). JSONTEXT =', jsonText, 'ERR =', e);

    // spróbuj "ułagodzić" – np. brak końcowej klamry
    let fixed = jsonText.trim();
    if (fixed.startsWith('{') && !fixed.endsWith('}')) {
      fixed = fixed + '}';
      try {
        parsed = JSON.parse(fixed);
      } catch (e2) {
        console.error('[LLM change-eval] JSON.parse error po auto-fixie. FIXED =', fixed, 'ERR =', e2);
      }
    }
  }

  if (!parsed) {
    // fallback jak wyżej, ale z BAD_JSON
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
    return { parsed: fallback, raw, mongoId: insertedId };
  }

  // 5) Sukces – normalny zapis
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


// zapis do Postgresa – dopasowany do aktualnego schematu
export async function saveDetectionAndNotification({
  monitorId,
  zadanieId,
  url,
  snapshotMongoId,
  diff,
  llmDecision,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) pewnosc – na razie na sztywno 1.0, lub z llmDecision.confidence
    const pewnosc =
      typeof llmDecision.confidence === 'number'
        ? llmDecision.confidence
        : 1.0;

    // 2) INSERT do wykrycia
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

    const detectionId = detectionsRes.rows[0].id;

    // 3) Jeżeli nieważne – kończymy na wykryciu
    if (llmDecision.important !== true) {
      await client.query('COMMIT');
      return { detectionId };
    }

    // 4) Pobierz uzytkownik_id z tabeli monitory
    const monitorRes = await client.query(
      `SELECT uzytkownik_id FROM monitory WHERE id = $1`,
      [monitorId],
    );

    const userRow = monitorRes.rows[0];

    if (!userRow || !userRow.uzytkownik_id) {
      console.warn(
        'saveDetectionAndNotification: monitor nie ma uzytkownik_id – zapisano wykrycie, pomijam powiadomienie.',
      );
      await client.query('COMMIT');
      return { detectionId };
    }

    const uzytkownikId = userRow.uzytkownik_id;

    // 5) INSERT do powiadomienia – zgodny z obecną tabelą
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
        'oczekuje', // status NOT NULL, ma też default, ale dajemy jawnie
        llmDecision.short_description ||
          llmDecision.importance_reason ||
          'Wykryto istotną zmianę na monitorowanej stronie.',
        llmDecision.short_title || 'Zmiana na monitorowanej stronie',
      ],
    );

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






