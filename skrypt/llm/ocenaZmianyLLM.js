// skrypt/llm/ocenaZmianyLLM.js
// Refactor: JSON-first decisioning based on analysis.universal_data.
// - No legacy regex/BEGIN_TRACKLY parsing.
// - Optional LLM judge (format=json) only when userPrompt requires interpretation.
//
// FIX (2026-02-08): Map LLM-provided evidence_used QUOTES back to evidence_before#/evidence_after# IDs.
// Some models return verbatim quotes instead of IDs even when instructed.
// We now normalize and map those quotes to the correct evidence IDs before validation,
// so important=true won't be discarded solely due to quote-form evidence_used.
//
// FIX (2026-02-09): Judge schema + prompt consistency (reason vs importance_reason)
// and prefer out.json when calling Ollama with JSON schema.

import { generateTextWithOllama } from './ollamaClient.js';
import { pool } from '../polaczeniePG.js';
import { mongoClient } from '../polaczenieMDB.js';
import { performance } from 'node:perf_hooks';

const db = mongoClient.db('inzynierka');
const ocenyZmienCol = db.collection('oceny_zmian');

const OLLAMA_MODEL =
  process.env.OLLAMA_TEXT_MODEL ||
  process.env.LLM_MODEL ||
  'llama3.2:3b';

// --- IMPORTANT ---
// Prompt asks for "reason", so schema MUST require "reason" (not "importance_reason").
// Also require evidence_used to reduce "important=true without evidence" cases.
const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['important', 'category', 'reason', 'evidence_used'],
  properties: {
    important: { type: 'boolean' },
    category: { type: 'string' },
    reason: { type: 'string' },
    short_title: { type: 'string' },
    short_description: { type: 'string' },
    evidence_used: {
      type: 'array',
      items: { type: 'string' },
    },
    llm_fallback_used: { type: 'boolean' },
  },
};

function normalizeUserPrompt(value) {
  const prompt = String(value || '').trim();
  return prompt.length ? prompt : null;
}

function extractRatingFromText(text) {
  if (!text) return null;
  const s = String(text);
  // Pattern: 5,00/5 or 4.7/5 or 5/5
  const m = s.match(/(\d{1,2})(?:[\.,](\d{1,2}))?\s*\/\s*5/);
  if (m) {
    const intPart = Number(m[1]);
    const fracPart = m[2] ? Number(m[2]) : 0;
    const fracScale = m[2] ? Math.pow(10, m[2].length) : 1;
    const val = intPart + fracPart / fracScale;
    if (Number.isFinite(val) && val >= 0 && val <= 5) return val;
  }
  // Pattern: 4,7 ★ / 4.7★ (fallback)
  const m2 = s.match(/(\d{1,2})(?:[\.,](\d{1,2}))?\s*(?:★|\u2605)/);
  if (m2) {
    const intPart = Number(m2[1]);
    const fracPart = m2[2] ? Number(m2[2]) : 0;
    const fracScale = m2[2] ? Math.pow(10, m2[2].length) : 1;
    const val = intPart + fracPart / fracScale;
    if (Number.isFinite(val) && val >= 0 && val <= 5) return val;
  }
  return null;
}

function extractRatingFromEvidenceQuotes(quotes) {
  if (!Array.isArray(quotes) || !quotes.length) return null;
  for (const q of quotes) {
    const v = extractRatingFromText(q);
    if (v != null) return v;
  }
  return extractRatingFromText(quotes.join(' '));
}



function extractReviewsCountFromText(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  const m = s.match(
    /(\d{1,6})\s*(?:opin(?:ia|ie|ii)?|recenz(?:ja|je|ji)?|review(?:s)?|rating(?:s)?|ocen(?:a|y)?)/i
  );
  if (m) {
    const val = Number(m[1]);
    if (Number.isFinite(val) && val >= 0) return val;
  }
  const m2 = s.match(
    /(?:opin(?:ia|ie|ii)?|recenz(?:ja|je|ji)?|review(?:s)?|rating(?:s)?|ocen(?:a|y)?)[^\d]{0,30}\(\s*(\d{1,6})\s*\)/i
  );
  if (m2) {
    const val = Number(m2[1]);
    if (Number.isFinite(val) && val >= 0) return val;
  }
  return null;
}

function extractReviewsCountFromEvidenceQuotes(quotes) {
  if (!Array.isArray(quotes) || !quotes.length) return null;
  for (const q of quotes) {
    const v = extractReviewsCountFromText(q);
    if (v != null) return v;
  }
  return extractReviewsCountFromText(quotes.join(' '));
}

const UNIVERSAL_KEYWORDS = {
  rating: ['ocen', 'rating', 'gwiazdk', 'star'],
  reviews_count: ['recenz', 'opini', 'review', 'komentarz'],
  main_price: ['cen', 'price', 'koszt', 'pln', 'zł'],
  delivery: ['dostaw', 'shipping', 'wysyłk'],
  availability: ['dostęp', 'stock', 'availability', 'stan'],
  seller: ['sprzed', 'seller', 'merchant', 'sklep'],
};

function promptMentions(promptLower, keywords) {
  return keywords.some((k) => promptLower.includes(k));
}

function userCaresAboutKey(userPrompt, key) {
  const p = String(userPrompt || '').toLowerCase();
  if (!p) return false;
  if (p.includes(String(key).toLowerCase())) return true;
  const kw = UNIVERSAL_KEYWORDS[key];
  if (!kw) return false;
  return promptMentions(p, kw);
}

function userIgnoresKey(userPrompt, key) {
  const p = String(userPrompt || '').toLowerCase();
  if (!p.includes('ignoruj') && !p.includes('pomi')) return false;
  const kw = UNIVERSAL_KEYWORDS[key];
  if (!kw) return false;
  return promptMentions(p, kw);
}

function normalizeKey(s) {
  return String(s || '').trim();
}

function normalizeValue(s) {
  const v = String(s ?? '').trim();
  return v.length ? v : 'unknown';
}

function universalDataToMap(analysis) {
  const list = Array.isArray(analysis?.universal_data) ? analysis.universal_data : [];
  const map = new Map();
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const key = normalizeKey(it.key);
    if (!key) continue;
    map.set(key, normalizeValue(it.value));
  }
  return map;
}

function diffUniversalData(prevAnalysis, newAnalysis) {
  const prev = universalDataToMap(prevAnalysis);
  const next = universalDataToMap(newAnalysis);

  const added = [];
  const removed = [];
  const changed = [];

  for (const [k, v] of next.entries()) {
    if (!prev.has(k)) added.push({ key: k, after: v });
    else {
      const before = prev.get(k);
      if (before !== v) changed.push({ key: k, before, after: v });
    }
  }

  for (const [k, v] of prev.entries()) {
    if (!next.has(k)) removed.push({ key: k, before: v });
  }

  return { added, removed, changed, any: added.length > 0 || removed.length > 0 || changed.length > 0 };
}

function metricDelta(prevAnalysis, newAnalysis) {
  const prevRating = typeof prevAnalysis?.metrics?.rating === 'number' ? prevAnalysis.metrics.rating : null;
  const newRating = typeof newAnalysis?.metrics?.rating === 'number' ? newAnalysis.metrics.rating : null;
  const prevReviews = typeof prevAnalysis?.metrics?.reviews_count === 'number' ? prevAnalysis.metrics.reviews_count : null;
  const newReviews = typeof newAnalysis?.metrics?.reviews_count === 'number' ? newAnalysis.metrics.reviews_count : null;

  return {
    rating: prevRating != null && newRating != null && prevRating !== newRating ? { before: prevRating, after: newRating } : null,
    reviews_count:
      prevReviews != null && newReviews != null && prevReviews !== newReviews
        ? { before: prevReviews, after: newReviews }
        : null,
  };
}

function buildDeterministicDecision({ mDiff }) {
  const ratingChanged = typeof mDiff?.rating === 'number' && mDiff.rating !== 0;
  const reviewsChanged = typeof mDiff?.reviews_count === 'number' && mDiff.reviews_count !== 0;

  const important = ratingChanged || reviewsChanged;

  return {
    important,
    category: important ? 'metric_change' : 'minor_change',
    reason: important
      ? 'Wykryto zmianę metryki liczbowej (na podstawie porównania analiz).'
      : 'Brak potwierdzonej zmiany metryki liczbowej.',
    evidence_used: [],
    llm_fallback_used: true,
  };
}

function safeParseJsonFromLLM(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;

  const s = String(raw).trim();
  try {
    return JSON.parse(s);
  } catch {}

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function sanitizeEvidenceUsedAgainstAllowedKeys(evidenceUsed, allowedKeys) {
  if (!Array.isArray(evidenceUsed)) return [];
  const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys || []);

  const out = [];
  const seen = new Set();

  for (const item of evidenceUsed) {
    let candidate = String(item ?? '').trim();
    if (!candidate) continue;

    if (allowed.has(candidate)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
      continue;
    }

    let trimmed = candidate;
    while (trimmed.includes(':')) {
      trimmed = trimmed.slice(0, trimmed.lastIndexOf(':')).trim();
      if (allowed.has(trimmed)) {
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          out.push(trimmed);
        }
        break;
      }
    }
  }

  return out;
}

// --- FIX helpers: quote -> evidence id mapping ---

function normalizeQuoteForMatch(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .toLowerCase();
}

function buildQuoteToIdMap(evidenceBefore, evidenceAfter) {
  const map = new Map();
  for (const e of evidenceBefore || []) {
    const key = normalizeQuoteForMatch(e?.quote);
    if (key) map.set(key, e?.id);
  }
  for (const e of evidenceAfter || []) {
    const key = normalizeQuoteForMatch(e?.quote);
    if (key) map.set(key, e?.id);
  }
  return map;
}

function mapEvidenceUsedQuotesToIds(evidenceUsed, quoteToId) {
  if (!Array.isArray(evidenceUsed) || !evidenceUsed.length) return [];
  const out = [];

  for (const item of evidenceUsed) {
    const s = String(item ?? '').trim();
    if (!s) continue;

    if (s.startsWith('evidence_before#') || s.startsWith('evidence_after#') || s.startsWith('diff_reason:')) {
      out.push(s);
      continue;
    }

    const norm = normalizeQuoteForMatch(s);
    const mapped = quoteToId.get(norm);
    if (mapped) {
      out.push(mapped);
      continue;
    }

    const variants = [
      s.replace(/^["']|["']$/g, ''),
      s.replace(/^\-\s*/, ''),
      s.replace(/^["']|["']$/g, '').replace(/^\-\s*/, ''),
    ];

    let found = null;
    for (const v of variants) {
      const m = quoteToId.get(normalizeQuoteForMatch(v));
      if (m) {
        found = m;
        break;
      }
    }
    if (found) out.push(found);
  }

  const seen = new Set();
  return out.filter((x) => {
    const k = String(x).trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function judgeImportanceWithLLM(
  { userPrompt, prevSummary, newSummary, diffMetrics },
  { logger } = {}
) {
  const log = logger || console;

  const beforeQuotes = Array.isArray(diffMetrics?.evidence_v1?.before) ? diffMetrics.evidence_v1.before : [];
  const afterQuotes = Array.isArray(diffMetrics?.evidence_v1?.after) ? diffMetrics.evidence_v1.after : [];

  const norm = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const beforeNormSet = new Set(beforeQuotes.map(norm).filter(Boolean));
  const afterNormSet = new Set(afterQuotes.map(norm).filter(Boolean));

  const setsEqual =
    beforeNormSet.size === afterNormSet.size &&
    [...beforeNormSet].every((x) => afterNormSet.has(x));

  if (setsEqual) {
    return {
      prompt: null,
      raw: null,
      result: {
        important: false,
        category: 'minor_change',
        reason: 'Dowody BEFORE i AFTER są identyczne (po treści) — brak wykrywalnej różnicy.',
        evidence_used: [],
        llm_fallback_used: false,
      },
      fallbackUsed: true,
    };
  }

  const evidenceBefore = beforeQuotes.map((q, i) => ({ id: `evidence_before#${i}`, quote: String(q) }));
  const evidenceAfter = afterQuotes.map((q, i) => ({ id: `evidence_after#${i}`, quote: String(q) }));

  const evidencePool = [
    ...evidenceBefore.map((e) => e.id),
    ...evidenceAfter.map((e) => e.id),
  ];

  const ratingBefore = extractRatingFromEvidenceQuotes(beforeQuotes);
  const ratingAfter = extractRatingFromEvidenceQuotes(afterQuotes);
  const reviewsCountBefore = extractReviewsCountFromEvidenceQuotes(beforeQuotes);
  const reviewsCountAfter = extractReviewsCountFromEvidenceQuotes(afterQuotes);

  const derivedMetrics = {
    rating_before: ratingBefore,
    rating_after: ratingAfter,
    reviews_count_before: reviewsCountBefore,
    reviews_count_after: reviewsCountAfter,
  };

  const evidenceTextBefore = evidenceBefore.map((e) => `- ${e.id}: "${e.quote}"`).join('\n');
  const evidenceTextAfter = evidenceAfter.map((e) => `- ${e.id}: "${e.quote}"`).join('\n');

const prompt = `
Jesteś sędzią zmian na stronie.

CEL:
Na podstawie USER_PROMPT oceń, czy zmiana między BEFORE i AFTER jest ISTOTNA.
Używaj WYŁĄCZNIE dowodów (cytatów) poniżej. Nie dopisuj faktów spoza cytatów.
derivedMetrics traktuj tylko jako pomocniczy hint — jeśli są sprzeczne z cytatami, IGNORUJ je.

USER_PROMPT:
${userPrompt}

Dane (kontekst):
- prevSummary: ${prevSummary || '(brak)'}
- newSummary: ${newSummary || '(brak)'}

Dowody (verbatim cytaty wybrane na etapie analizy, pod USER_PROMPT):
BEFORE:
${evidenceTextBefore || '- (brak)'}
AFTER:
${evidenceTextAfter || '- (brak)'}

derivedMetrics (hint; mogą być null):
${JSON.stringify(derivedMetrics)}

PRIORYTET (BARDZO WAŻNE):
- Najpierw ustal, jakie ASPEKTY są monitorowane przez USER_PROMPT (np. "nowa recenzja", "zmiana oceny", "cena", "dostępność").
- Uznaj zmianę za ISTOTNĄ tylko wtedy, gdy dotyczy tych aspektów. Zmiany poza zakresem USER_PROMPT ignoruj.

Zasady oceny (KLUCZOWE):
1) KOSMETYKA vs SEMANTYKA
- Zmiana jest KOSMETYCZNA, jeśli dotyczy tylko: literówek, odmiany, interpunkcji, wielkości liter, kolejności słów,
  skrót vs pełna forma, formatowanie, brak spacji, podwójne znaki, artefakty ekstrakcji/OCR.
- Same ozdobniki/ikonki (np. ★★★, emoji, separatory) bez zmiany liczb/treści -> KOSMETYCZNE.
-> wtedy important=false.

2) ISTOTNOŚĆ (tylko zmiana faktu w zakresie USER_PROMPT)
- Zmiana jest ISTOTNA tylko jeśli potrafisz wskazać zmianę FAKTU/STATUSU jako "BEFORE: X -> AFTER: Y"
  i dotyczy aspektu z USER_PROMPT.
- Negacje i odwrócenie sensu ("nie", "brak", "bez", "niedostępny" vs "dostępny") traktuj jako ISTOTNE.
- Liczby/jednostki (ocena, liczba ocen, liczba recenzji/opinii, cena, %, daty, ilości, godziny) traktuj jako ISTOTNE
  tylko gdy są w zakresie USER_PROMPT (chyba że USER_PROMPT każe liczby ignorować).

3) SPRZECZNOŚCI / SZUM DOWODÓW
- Jeśli dowody AFTER (lub BEFORE) są wewnętrznie sprzeczne (np. różne liczby dla tego samego parametru),
  nie zgaduj. Ustaw category="uncertain_noise" i wybierz important=false, opisując konflikt w reason.
- Jeśli brakuje dowodów do jednoznacznej oceny -> important=false i evidence_used=[].

HEURYSTYKA:
- Jeśli różnica to 1–2 wyrazy i NIE zmienia faktu/znaczenia -> important=false.
- W razie wątpliwości wybierz important=false.

- Jeśli dowody są długimi paragrafami: najpierw znajdź 1–3 zdania, które różnią się między BEFORE i AFTER.
- Jeśli wykryjesz zmianę ISTOTNĄ, w reason zacytuj dokładnie zmienione zdanie lub jego kluczowy fragment:
  "BEFORE: <fragment> -> AFTER: <fragment>".
- Jeśli nie potrafisz wskazać konkretnego zmienionego zdania na podstawie cytatów -> important=false.


Zasady zwrotu:
- Zwróć WYŁĄCZNIE JSON (bez markdown).
- evidence_used MUSI być tablicą stringów wybranych DOKŁADNIE z evidence_pool.
- Jeśli important=true:
  - evidence_used MUSI zawierać min. 1 ID,
  - oraz jeśli istnieją evidence_before#* i evidence_after#*, to evidence_used MUSI zawierać min. 1 z BEFORE i 1 z AFTER,
  - reason MUSI zawierać krótkie "BEFORE: ... -> AFTER: ..." (zmiana faktu w zakresie USER_PROMPT).
- Jeśli important=false -> evidence_used MUSI być [].

evidence_pool:
${JSON.stringify(evidencePool)}

Zwróć JSON:
{
  "important": boolean,
  "category": string,
  "reason": string,
  "evidence_used": string[]
}
`.trim();


  const system = 'Jesteś sędzią zmian na stronie. Zwracaj wyłącznie JSON.';

  let raw = null;
  let parsed = null;

  try {
    const out = await generateTextWithOllama({
      model: OLLAMA_MODEL,
      prompt,
      system,
      format: JUDGE_SCHEMA,
      temperature: 0,
    });

    // Keep raw for debug; prefer out.json (schema mode).
    raw = out?.text ?? out?.raw ?? null;
    parsed = out?.json ?? null;

    // Fallback: if wrapper didn't expose .json for some reason.
    if (!parsed) parsed = safeParseJsonFromLLM(raw);
  } catch (err) {
    log?.warn?.('llm_judge_call_failed', { err: err?.message || String(err) });
    return {
      prompt,
      raw,
      result: {
        important: false,
        category: 'minor_change',
        reason: 'Błąd wywołania LLM (judge).',
        evidence_used: [],
        llm_fallback_used: true,
      },
      fallbackUsed: true,
    };
  }

  if (!parsed) {
    return {
      prompt,
      raw,
      result: {
        important: false,
        category: 'minor_change',
        reason: 'Nie udało się sparsować odpowiedzi LLM (judge).',
        evidence_used: [],
        llm_fallback_used: true,
      },
      fallbackUsed: true,
    };
  }

  const important = parsed.important === true;

  const quoteToId = buildQuoteToIdMap(evidenceBefore, evidenceAfter);
  const mappedEvidenceUsed = mapEvidenceUsedQuotesToIds(parsed.evidence_used, quoteToId);
  const sanitizedEvidenceUsed = sanitizeEvidenceUsedAgainstAllowedKeys(mappedEvidenceUsed, evidencePool);

  if (important) {
    const hasBefore = sanitizedEvidenceUsed.some((x) => String(x).startsWith('evidence_before#'));
    const hasAfter = sanitizedEvidenceUsed.some((x) => String(x).startsWith('evidence_after#'));
    const ok =
      sanitizedEvidenceUsed.length > 0 &&
      (!evidenceBefore.length || hasBefore) &&
      (!evidenceAfter.length || hasAfter);

    if (!ok) {
      return {
        prompt,
        raw,
        result: {
          important: false,
          category: 'minor_change',
          reason:
            'Model zwrócił important=true, ale nie spełnił zasad evidence_used (brak wymaganych identyfikatorów).',
          evidence_used: [],
          llm_fallback_used: true,
        },
        fallbackUsed: true,
      };
    }
  }

  return {
    prompt,
    raw,
    result: {
      important,
      category: parsed.category || 'minor_change',
      reason: parsed.reason || 'Brak istotnych zmian.',
      evidence_used: sanitizedEvidenceUsed,
      llm_fallback_used: false,
    },
    fallbackUsed: false,
  };
}

export async function evaluateChangeWithLLM(
  { monitorId, zadanieId, url, prevAnalysis, newAnalysis, diff, userPrompt },
  { logger } = {}
) {
  const log = logger || console;
  const t0 = performance.now();

  const normalizedUserPrompt = normalizeUserPrompt(userPrompt);

  const uDiff = diffUniversalData(prevAnalysis, newAnalysis);
  const mDiff = metricDelta(prevAnalysis, newAnalysis);

  let decision = null;
  let usedMode = 'deterministic';
  let usedPrompt = null;
  let usedRaw = null;

  if (normalizedUserPrompt) {
    const prevSummary = prevAnalysis?.summary || '';
    const newSummary = newAnalysis?.summary || '';
    const diffMetrics = {
      ...(diff?.metrics || {}),
      evidence_v1: diff?.evidence_v1 || null,
      universalDataDiff: uDiff,
    };

    const judge = await judgeImportanceWithLLM(
      {
        userPrompt: normalizedUserPrompt,
        prevSummary,
        newSummary,
        diffMetrics,
      },
      { logger: log }
    );

    usedMode = 'judge';
    usedPrompt = judge.prompt;
    usedRaw = judge.raw;

    decision = {
      important: !!judge.result.important,
      category: judge.result.category || 'minor_change',
      importance_reason: judge.result.reason || 'Brak istotnych zmian.',
      evidence_used: Array.isArray(judge.result.evidence_used) ? judge.result.evidence_used : [],
      short_title: judge.result.important ? 'Zmiana na monitorowanej stronie' : 'Brak istotnej zmiany',
      short_description: judge.result.reason || 'Brak istotnych zmian.',
      llm_fallback_used: judge.result.llm_fallback_used === true,
    };
  }

  if (!decision) {
    decision = buildDeterministicDecision({ mDiff });
    if (decision.llm_fallback_used == null) decision.llm_fallback_used = false;

    // Normalize deterministic output into the same shape as judge.
    decision = {
      important: decision.important === true,
      category: decision.category || 'minor_change',
      importance_reason: decision.reason || 'Brak istotnych zmian.',
      evidence_used: Array.isArray(decision.evidence_used) ? decision.evidence_used : [],
      short_title: decision.important ? 'Zmiana na monitorowanej stronie' : 'Brak istotnej zmiany',
      short_description: decision.reason || 'Brak istotnych zmian.',
      llm_fallback_used: decision.llm_fallback_used === true,
    };
  }

  const insertDoc = {
    createdAt: new Date(),
    monitorId,
    zadanieId,
    url,
    llm_mode: usedMode,
    model: usedMode === 'judge' ? OLLAMA_MODEL : null,
    prompt_used: usedPrompt,
    raw_response: usedRaw,
    llm_decision: decision,
    analysis_diff: {
      metrics_delta: mDiff,
      machine_diff_reasons: diff?.reasons || [],
    },
    error: null,
    durationMs: Math.round(performance.now() - t0),
  };

  const { insertedId } = await ocenyZmienCol.insertOne(insertDoc);

  log?.info?.('llm_change_eval_success', {
    monitorId,
    zadanieId,
    mongoId: insertedId,
    important: !!decision.important,
    category: decision.category || null,
    usedMode,
  });

  return { parsed: decision, raw: usedRaw, mongoId: insertedId };
}

export async function saveDetectionAndNotification(
  { monitorId, zadanieId, url, snapshotMongoId, diff, llmDecision },
  { logger } = {}
) {
  const log = logger || console;
  const tSave0 = performance.now();

  const client = await pool.connect();
  let detectionId = null;
  let ok = false;

  try {
    await client.query('BEGIN');

    const pewnosc = typeof llmDecision?.confidence === 'number' ? llmDecision.confidence : 1.0;

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
        llmDecision?.short_title || null,
        pewnosc,
        monitorId,
        String(snapshotMongoId),
        llmDecision?.category || null,
        llmDecision?.important === true,
        llmDecision?.importance_reason || null,
        JSON.stringify(diff ?? null),
      ]
    );

    detectionId = detectionsRes.rows[0].id;

    if (llmDecision?.important !== true) {
      await client.query('COMMIT');
      ok = true;
      return { detectionId };
    }

    const monitorRes = await client.query(`SELECT uzytkownik_id FROM monitory WHERE id = $1`, [monitorId]);
    const userRow = monitorRes.rows[0];

    if (!userRow || !userRow.uzytkownik_id) {
      log?.warn?.('saveDetectionAndNotification_missing_user', { monitorId, zadanieId, detectionId });
      await client.query('COMMIT');
      ok = true;
      return { detectionId };
    }

    const uzytkownikId = userRow.uzytkownik_id;

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
        llmDecision?.short_description ||
          llmDecision?.importance_reason ||
          'Wykryto istotną zmianę na monitorowanej stronie.',
        llmDecision?.short_title || 'Zmiana na monitorowanej stronie',
      ]
    );

    await client.query('COMMIT');
    ok = true;

    log?.info?.('saveDetectionAndNotification_created_notification', {
      monitorId,
      zadanieId,
      detectionId,
      uzytkownikId,
    });

    return { detectionId };
  } catch (err) {
    await client.query('ROLLBACK');
    log?.error?.('saveDetectionAndNotification_pg_error', {
      monitorId,
      zadanieId,
      error: err?.message || String(err),
      stack: err?.stack,
    });
    throw err;
  } finally {
    log?.info?.('save_detection_done', {
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

