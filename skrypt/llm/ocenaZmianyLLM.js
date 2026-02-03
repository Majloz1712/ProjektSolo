// skrypt/llm/ocenaZmianyLLM.js
// Refactor: JSON-first decisioning based on analysis.universal_data.
// - No legacy regex/BEGIN_TRACKLY parsing.
// - Optional LLM judge (format=json) only when userPrompt requires interpretation.

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
  // Try each quote first (more precise), then joined text.
  for (const q of quotes) {
    const v = extractRatingFromText(q);
    if (v != null) return v;
  }
  return extractRatingFromText(quotes.join(' '));
}


function extractReviewsCountFromText(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  // Common multilingual keywords; intentionally generic.
  const m = s.match(/(\d{1,6})\s*(?:opin(?:ia|ie|ii)?|recenz(?:ja|je|ji)?|review(?:s)?|rating(?:s)?|ocen(?:a|y)?)/i);
  if (m) {
    const val = Number(m[1]);
    if (Number.isFinite(val) && val >= 0) return val;
  }
  // Fallback: "(123)" next to a review/ratings keyword
  const m2 = s.match(/(?:opin(?:ia|ie|ii)?|recenz(?:ja|je|ji)?|review(?:s)?|rating(?:s)?|ocen(?:a|y)?)[^\d]{0,30}\(\s*(\d{1,6})\s*\)/i);
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



function normalizeForJsonPrompt(value, max = 240) {
  const s = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmed = s.length > max ? `${s.slice(0, max)}…` : s;
  return trimmed;
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

  // jeśli user wpisze key wprost
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

function decideByUniversalData(userPrompt, universalDataDiff) {
  if (!universalDataDiff?.any) return null;

  const changed = Array.isArray(universalDataDiff.changed) ? universalDataDiff.changed : [];
  const added = Array.isArray(universalDataDiff.added) ? universalDataDiff.added : [];
  const removed = Array.isArray(universalDataDiff.removed) ? universalDataDiff.removed : [];

  const touchedKeys = [
    ...changed.map((x) => x.key),
    ...added.map((x) => x.key),
    ...removed.map((x) => x.key),
  ].filter(Boolean);

  if (!touchedKeys.length) return null;

  const cared = touchedKeys
    .filter((k) => !userIgnoresKey(userPrompt, k))
    .filter((k) => userCaresAboutKey(userPrompt, k));

  // jeśli user nie wskazuje nic dot. tych kluczy -> nie wymuszaj (oddaj do judge)
  if (!cared.length) return null;

  const lines = [];
  for (const c of changed) {
    if (cared.includes(c.key)) lines.push(`${c.key}: ${c.before} -> ${c.after}`);
  }
  for (const a of added) {
    if (cared.includes(a.key)) lines.push(`${a.key}: (added) -> ${a.after}`);
  }
  for (const r of removed) {
    if (cared.includes(r.key)) lines.push(`${r.key}: ${r.before} -> (removed)`);
  }

  return {
    important: true,
    category: cared.includes('rating')
      ? 'rating_change'
      : cared.includes('reviews_count')
        ? 'reviews_change'
        : 'tracked_universal_change',
    importance_reason: `Wykryto zmianę w monitorowanych polach: ${lines.join('; ')}`,
    evidence_used: cared.map((k) => `universal_data.${k}`),
    short_title: 'Zmiana w monitorowanych danych',
    short_description: lines.join('; '),
    llm_fallback_used: false,
  };
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

function classifyByKey(key) {
  const k = key.toLowerCase();
  if (k.includes('price') || k.includes('cena')) return 'price_change';
  if (k.includes('avail') || k.includes('dost')) return 'availability_change';
  if (k.includes('rating') || k.includes('ocena')) return 'rating_change';
  if (k.includes('review') || k.includes('opin')) return 'reviews_change';
  if (k.includes('deliver') || k.includes('wysy') || k.includes('shipping')) return 'delivery_change';
  if (k.includes('seller') || k.includes('sprzed')) return 'seller_change';
  return 'content_update';
}

function buildDeterministicDecision({ uDiff, mDiff }) {
  // 1) Metrics first (rating/reviews_count)
  if (mDiff.rating) {
    return {
      important: true,
      category: 'rating_change',
      importance_reason: `Zmiana oceny: ${mDiff.rating.before} → ${mDiff.rating.after}.`,
      evidence_used: ['metrics.rating'],
      short_title: 'Zmiana oceny',
      short_description: `Ocena zmieniła się z ${mDiff.rating.before} na ${mDiff.rating.after}.`,
    };
  }
  if (mDiff.reviews_count) {
    return {
      important: true,
      category: 'reviews_change',
      importance_reason: `Zmiana liczby opinii: ${mDiff.reviews_count.before} → ${mDiff.reviews_count.after}.`,
      evidence_used: ['metrics.reviews_count'],
      short_title: 'Zmiana liczby opinii',
      short_description: `Liczba opinii zmieniła się z ${mDiff.reviews_count.before} na ${mDiff.reviews_count.after}.`,
    };
  }

  // 2) Universal data diff
  if (!uDiff.any) {
    return {
      important: false,
      category: 'minor_change',
      importance_reason: 'Brak różnic w extracted universal_data (i brak różnic w metrics).',
      evidence_used: [],
      short_title: 'Brak istotnej zmiany',
      short_description: 'Nie wykryto różnic w kluczowych danych.',
    };
  }

  const changedKey = uDiff.changed[0]?.key || uDiff.added[0]?.key || uDiff.removed[0]?.key || 'content';
  const category = classifyByKey(changedKey);

  if (uDiff.changed.length) {
    const c = uDiff.changed[0];
    return {
      important: true,
      category,
      importance_reason: `Zmiana danych: ${c.key}: "${c.before}" → "${c.after}".`,
      evidence_used: [`universal_data.${c.key}`],
      short_title: 'Zmiana na stronie',
      short_description: `${c.key}: "${c.before}" → "${c.after}"`,
    };
  }

  if (uDiff.added.length) {
    const a = uDiff.added[0];
    return {
      important: true,
      category,
      importance_reason: `Pojawiły się nowe dane: ${a.key}="${a.after}".`,
      evidence_used: [`universal_data.${a.key}`],
      short_title: 'Nowa informacja na stronie',
      short_description: `${a.key}: "${a.after}"`,
    };
  }

  const r = uDiff.removed[0];
  return {
    important: true,
    category,
    importance_reason: `Zniknęły dane: ${r.key} (wcześniej: "${r.before}").`,
    evidence_used: [`universal_data.${r.key}`],
    short_title: 'Zmiana na stronie',
    short_description: `${r.key} zostało usunięte/ukryte.`,
  };
}

function evidencePool({ uDiff, mDiff, diff }) {
  const pool = [];
  if (mDiff.rating) pool.push('metrics.rating');
  if (mDiff.reviews_count) pool.push('metrics.reviews_count');
  for (const c of uDiff.changed) pool.push(`universal_data.${c.key}`);
  for (const a of uDiff.added) pool.push(`universal_data.${a.key}`);
  for (const r of uDiff.removed) pool.push(`universal_data.${r.key}`);
  if (Array.isArray(diff?.reasons)) pool.push(...diff.reasons.map((x) => `diff_reason:${x}`));
  return pool;
}

function safeParseJsonFromLLM(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;

  const s = String(raw).trim();
  try {
    return JSON.parse(s);
  } catch {}

  // fallback: wytnij pierwszego JSON-a z tekstu
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function validateEvidenceUsed(evidenceUsed, evidencePool) {
  if (!Array.isArray(evidenceUsed)) return false;

  const pool = new Set(
    (evidencePool || [])
      .map((x) => String(x || '').trim())
      .filter(Boolean),
  );

  // jeśli pool pusty, jedyny poprawny wybór to []
  if (pool.size === 0) return evidenceUsed.length === 0;

  return evidenceUsed.every((item) => pool.has(String(item || '').trim()));
}

/**
 * Sanityzacja: model czasem zwraca "chunk:section-5:Computer Components"
 * albo "universal_data.brand:Computer Components".
 * Tu obcinamy "dodatki" po dwukropkach i zostawiamy tylko klucze,
 * które faktycznie istnieją w allowedKeys.
 */
function sanitizeEvidenceUsedAgainstAllowedKeys(evidenceUsed, allowedKeys) {
  if (!Array.isArray(evidenceUsed)) return [];
  const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys || []);

  const out = [];
  const seen = new Set();

  for (const item of evidenceUsed) {
    let candidate = String(item ?? '').trim();
    if (!candidate) continue;

    // 1) Spróbuj dokładnie
    if (allowed.has(candidate)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
      continue;
    }

    // 2) Jeśli LLM dopisał coś po dwukropku, tnij od końca aż do trafienia
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

    // 3) Jeśli nadal nic — odrzuć (halucynacja / nie-dozwolone)
  }

  return out;
}


async function judgeImportanceWithLLM(
  { userPrompt, prevSummary, newSummary, diffMetrics, diffReasons, metricsDelta },
  { logger } = {},
) {
  const log = logger || console;

  // ---- evidence pool (stabilne identyfikatory, w tym universal_data.*) ----
  const uDiff = diffMetrics?.universalDataDiff;
  const universalKeysChanged = [
    ...(uDiff?.changed || []).map((x) => x?.key).filter(Boolean),
    ...(uDiff?.added || []).map((x) => x?.key).filter(Boolean),
    ...(uDiff?.removed || []).map((x) => x?.key).filter(Boolean),
  ];

  // ---- chunk evidence as STABLE ids (we provide details separately) ----
  const tcd = diffMetrics?.textChunkDiff && typeof diffMetrics.textChunkDiff === 'object' ? diffMetrics.textChunkDiff : null;
  const changedChunks = Array.isArray(tcd?.changed_for_judge)
    ? tcd.changed_for_judge
    : Array.isArray(tcd?.changed)
      ? tcd.changed
      : [];
  const addedChunks = Array.isArray(tcd?.added) ? tcd.added : [];
  const removedChunks = Array.isArray(tcd?.removed) ? tcd.removed : [];

const changedChunkKeys = new Set();

// changedChunks: zwykle [{ key: ... }]
for (const c of changedChunks) {
  if (c?.key) changedChunkKeys.add(c.key);
}

// tcd.changedChunks: czasem lista stringów, czasem obiekty — obsłuż oba
if (Array.isArray(tcd?.changedChunks)) {
  for (const it of tcd.changedChunks) {
    if (typeof it === 'string' && it.trim()) changedChunkKeys.add(it.trim());
    else if (it?.key) changedChunkKeys.add(it.key);
  }
}

const chunkIds = [...changedChunkKeys];

const chunkAddedIds = addedChunks.map((c) => c?.key).filter(Boolean);
const chunkRemovedIds = removedChunks.map((c) => c?.key).filter(Boolean);

  // Prompt-driven evidence quotes (verbatim) extracted during snapshot analysis.
  // We expose them as stable short IDs so the model can cite them deterministically.
  const beforeQuotes = Array.isArray(diffMetrics?.evidence_v1?.before)
    ? diffMetrics.evidence_v1.before
    : [];
  const afterQuotes = Array.isArray(diffMetrics?.evidence_v1?.after)
    ? diffMetrics.evidence_v1.after
    : [];

  // Aliases used by generic metric extractors further down.
  // They expect arrays of quote strings.
  const evidenceBefore = beforeQuotes;
  const evidenceAfter = afterQuotes;
  const evidenceQuoteRefs = [];
  const evidenceQuoteMap = {};
  for (let i = 0; i < beforeQuotes.length; i += 1) {
    const ref = `evidence_before#${i}`;
    evidenceQuoteRefs.push(ref);
    evidenceQuoteMap[ref] = String(beforeQuotes[i]);
  }
  for (let i = 0; i < afterQuotes.length; i += 1) {
    const ref = `evidence_after#${i}`;
    evidenceQuoteRefs.push(ref);
    evidenceQuoteMap[ref] = String(afterQuotes[i]);
  }


  const evidencePool = [
    ...(Array.isArray(diffReasons) ? diffReasons.map((r) => `diff_reason:${r}`) : []),
    ...(metricsDelta?.rating ? ['metrics.rating'] : []),
    ...(metricsDelta?.reviews_count ? ['metrics.reviews_count'] : []),
    ...evidenceQuoteRefs,
    ...universalKeysChanged.map((k) => `universal_data.${k}`),
    ...chunkIds.map((k) => `chunk:${k}`),
    ...chunkAddedIds.map((k) => `chunk_added:${k}`),
    ...chunkRemovedIds.map((k) => `chunk_removed:${k}`),
  ];

  // Compact metrics for the model (avoid huge payloads)
  const diffMetricsCompact = {
    ...(diffMetrics || {}),
    textChunkDiff: tcd
      ? {
          mode: tcd.mode,
          templateSource: tcd.templateSource,
          templateFit: tcd.templateFit,
          changedChunks: tcd.changedChunks,
          nowChunks: tcd.nowChunks,
          significant: tcd.significant,
          changed: changedChunks,
          added: addedChunks,
          removed: removedChunks,
        }
      : null,
  };

  const evidenceQuoteBlock = (() => {
    const lines = [];
    lines.push('Dowody (verbatim cytaty wybrane na etapie analizy, pod USER_PROMPT):');
    lines.push('BEFORE:');
    if (beforeQuotes.length === 0) {
      lines.push('- (brak)');
    } else {
      for (let i = 0; i < beforeQuotes.length; i++) {
        const ref = `evidence_before#${i}`;
        const q = normalizeForJsonPrompt(evidenceQuoteMap[ref] ?? '');
        lines.push(`- ${ref}: "${q}"`);
      }
    }
    lines.push('AFTER:');
    if (afterQuotes.length === 0) {
      lines.push('- (brak)');
    } else {
      for (let i = 0; i < afterQuotes.length; i++) {
        const ref = `evidence_after#${i}`;
        const q = normalizeForJsonPrompt(evidenceQuoteMap[ref] ?? '');
        lines.push(`- ${ref}: "${q}"`);
      }
    }
    return lines.join('\n');
  })();

  const requireQuoteEvidence = String(process.env.LLM_JUDGE_REQUIRE_QUOTE_EVIDENCE || 'true') !== 'false';

  // Best-effort numeric hints derived ONLY from evidence quotes.
  // This helps the judge ignore OCR glue / trailing tokens when the numeric value is unchanged.
  const derivedEvidenceMetrics = {
    rating_before: extractRatingFromEvidenceQuotes(evidenceBefore),
    rating_after: extractRatingFromEvidenceQuotes(evidenceAfter),
    reviews_count_before: extractReviewsCountFromEvidenceQuotes(evidenceBefore),
    reviews_count_after: extractReviewsCountFromEvidenceQuotes(evidenceAfter),
  };


  const prompt = `
Jesteś sędzią zmian na stronie.

USER_PROMPT:
${userPrompt || '(brak)'}

Dane (kontekst):
- prevSummary: ${prevSummary || '(brak)'}
- newSummary: ${newSummary || '(brak)'}

${evidenceQuoteBlock}

Pochodne metryki z dowodów (tylko z powyższych cytatów; mogą być null):
${JSON.stringify(derivedEvidenceMetrics)}


WAŻNE (odporność na szum OCR):
- Twoim priorytetem są ZMIANY WARTOŚCI LICZBOWYCH, jeśli tego dotyczy USER_PROMPT (np. ocena/rating, liczba opinii/recenzji).
- Najpierw wyłuskaj z dowodów BEFORE i AFTER te same metryki (np. ocena w skali /5, liczba opinii).
- Uznaj zmianę za istotną tylko, gdy wartości metryk faktycznie się różnią.
  * Przykład szumu: "Rewelacyjny 5,00/5" vs "Rewelacyjny 5,00/5 4 allegro" -> ocena nadal 5.00 -> important=false.
- Jeśli nie potrafisz wydobyć porównywalnych metryk po OBU stronach -> important=false.
- Ignoruj liczby niezwiązane z USER_PROMPT (ceny, raty, dostawa, % polecenia sprzedawcy), jeśli USER_PROMPT każe je ignorować.

Diff metrics (JSON):
${JSON.stringify(diffMetricsCompact ?? null)}

Zmiany w chunkach (szczegóły):
${JSON.stringify(
  {
    changed_chunks: changedChunks,
    added_chunks: addedChunks,
    removed_chunks: removedChunks,
  },
  null,
  0,
)}

Zasady:
- Zwróć WYŁĄCZNIE JSON.
- evidence_used MUSI być tablicą stringów wybranych DOKŁADNIE z evidence_pool.
- Jeśli important=true, evidence_used MUSI zawierać przynajmniej jeden identyfikator
- Jeśli w evidence_pool istnieją zarówno identyfikatory "evidence_before#*" jak i "evidence_after#*", to przy important=true evidence_used MUSI zawierać co najmniej jeden dowód z KAŻDEJ strony.
  zaczynający się od "evidence_before#" lub "evidence_after#" (czyli dowód-cytat).
  Nie opieraj ważności wyłącznie na universal_data.* albo diff_reason.
	- Jeśli USER_PROMPT oczekuje zmiany (np. "pojawi się", "zmieni się"), ustaw important=true tylko gdy dowody sugerują konkretną różnicę między BEFORE i AFTER (nie sama obecność sekcji).

- Jeśli nie masz wystarczających dowodów -> important=false i evidence_used=[].

evidence_pool:
${JSON.stringify(evidencePool)}

Zwróć JSON:
{
  "important": boolean,
  "category": string,
  "reason": string,
  "evidence_used": string[]
}
`;

  let raw = null;
  try {
    raw = await generateTextWithOllama({
      prompt,
      model: process.env.OLLAMA_TEXT_MODEL || process.env.LLM_MODEL || 'llama3.2:3b',
      format: 'json',
      temperature: 0,
      timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS_JUDGE || process.env.OLLAMA_TIMEOUT_MS || 120000),
    });
  } catch (err) {
    return {
      prompt,
      raw: String(err?.message || err),
      result: {
        important: false,
        category: 'minor_change',
        reason: 'Błąd LLM podczas oceny ważności.',
        evidence_used: [],
        llm_fallback_used: true,
      },
      fallbackUsed: true,
    };
  }

  const parsed = safeParseJsonFromLLM(raw);


  // allowedKeys = tylko realnie istniejące klucze:
  // - universalDataDiff.changed + universalDataDiff.added
  // - machineDiff.changedChunks (u nas: changedChunks => chunkIds)
	const allowedKeys = new Set(evidencePool);


  // przefiltruj evidence_used (uwzględnij dopiski po ':')
  const sanitizedEvidenceUsed = sanitizeEvidenceUsedAgainstAllowedKeys(parsed?.evidence_used, allowedKeys);

  // Waliduj względem pełnego evidence_pool (po sanityzacji)
  const evidenceOk = parsed ? validateEvidenceUsed(sanitizedEvidenceUsed, evidencePool) : false;

  if (!parsed || !evidenceOk) {
    return {
      prompt,
      raw,
      result: {
        important: false,
        category: 'minor_change',
        reason: 'Brak wiarygodnych dowodów spełniających kryteria userPrompt.',
        evidence_used: [],
        llm_fallback_used: true,
      },
      fallbackUsed: true,
    };
  }

  const important = !!parsed.important;
  const usedHasQuoteEvidence = sanitizedEvidenceUsed.some(
    (k) => typeof k === 'string' && (k.startsWith('evidence_before#') || k.startsWith('evidence_after#')),
  );

  // Hard rule for correctness:
  // Important=true requires at least one prompt-evidence quote (before/after) to be cited.
  // This prevents false positives based only on generic diff fields (universal_data, diff_reason, ...).
  if (important && !usedHasQuoteEvidence) {
    return {
      prompt,
      raw,
      result: {
        important: false,
        category: 'minor_change',
        reason:
          'Model zwrócił important=true, ale nie podał żadnego dowodu-cytatu (evidence_before#/evidence_after#).',
        evidence_used: [],
        llm_fallback_used: true,
      },
      fallbackUsed: true,
    };
  }


// Extra correctness rule: if we have BOTH before and after evidence quotes in the pool,
// then important=true must cite at least one from each side (comparative decision).
const poolHasBefore = evidencePool.some((k) => typeof k === 'string' && k.startsWith('evidence_before#'));
const poolHasAfter = evidencePool.some((k) => typeof k === 'string' && k.startsWith('evidence_after#'));
if (important && poolHasBefore && poolHasAfter) {
  const usedBefore = sanitizedEvidenceUsed.some((k) => typeof k === 'string' && k.startsWith('evidence_before#'));
  const usedAfter = sanitizedEvidenceUsed.some((k) => typeof k === 'string' && k.startsWith('evidence_after#'));
  if (!usedBefore || !usedAfter) {
    return {
      prompt,
      raw,
      result: {
        important: false,
        category: 'minor_change',
        reason:
          'Model zwrócił important=true, ale nie podał dowodów z obu stron (BEFORE i AFTER), więc nie da się wiarygodnie potwierdzić zmiany.',
        evidence_used: [],
        llm_fallback_used: true,
      },
      fallbackUsed: true,
    };
  }
}

// Anti-noise guard for rating/reviews monitoring:
// If extracted rating and/or reviews_count are identical before vs after, treat this as OCR noise and do not notify.
const cat = String(parsed.category || '').toLowerCase();
const looksLikeReviewCategory = /opini|recenz|review|rating|ocen/.test(cat);
if (important && looksLikeReviewCategory) {
  const ratingBefore = extractRatingFromEvidenceQuotes(evidenceBefore);
  const ratingAfter = extractRatingFromEvidenceQuotes(evidenceAfter);
  const reviewsBefore = extractReviewsCountFromEvidenceQuotes(evidenceBefore);
  const reviewsAfter = extractReviewsCountFromEvidenceQuotes(evidenceAfter);

  const ratingComparable = ratingBefore != null && ratingAfter != null;
  const reviewsComparable = reviewsBefore != null && reviewsAfter != null;

  const ratingSame = ratingComparable ? Math.abs(ratingBefore - ratingAfter) < 0.001 : false;
  const reviewsSame = reviewsComparable ? reviewsBefore === reviewsAfter : false;

  // If we can compare at least one metric and all comparable metrics are unchanged -> noise.
  const anyComparable = ratingComparable || reviewsComparable;
  const allComparableSame = (!ratingComparable || ratingSame) && (!reviewsComparable || reviewsSame);

  if (anyComparable && allComparableSame) {
    return {
      prompt,
      raw,
      result: {
        important: false,
        category: 'minor_change',
        reason:
          'Wykryto zmianę tekstu, ale porównywalne metryki (ocena/liczba opinii) nie zmieniły się — prawdopodobny szum OCR.',
        evidence_used: [],
        llm_fallback_used: false,
      },
      fallbackUsed: false,
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
  { logger } = {},
) {
  const log = logger || console;
  const t0 = performance.now();

  const normalizedUserPrompt = normalizeUserPrompt(userPrompt);

  const uDiff = diffUniversalData(prevAnalysis, newAnalysis);
  const mDiff = metricDelta(prevAnalysis, newAnalysis);

  // If userPrompt is provided, prefer LLM judge for maximum flexibility.
  // Deterministic logic is used only as a fallback (no userPrompt or judge failure).
  let decision = null;
  let usedMode = 'deterministic';
  let usedPrompt = null;
  let usedRaw = null;

  if (normalizedUserPrompt) {
    const prevSummary = prevAnalysis?.summary || '';
    const newSummary = newAnalysis?.summary || '';
    const diffReasons = Array.isArray(diff?.reasons) ? diff.reasons : [];

    // attach uDiff + (optional) chunk diff to metrics for judge
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
        diffReasons,
        metricsDelta: mDiff,
      },
      { logger: log },
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

  // 3) Bez userPrompt: czysto deterministycznie
  if (!decision) {
    decision = buildDeterministicDecision({ uDiff, mDiff });
    if (decision.llm_fallback_used == null) decision.llm_fallback_used = false;
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
      universal_data: uDiff,
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
  { logger } = {},
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
      ],
    );

    detectionId = detectionsRes.rows[0].id;

    // If not important – we still store wykrycie but skip notification.
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
        llmDecision?.short_description || llmDecision?.importance_reason || 'Wykryto istotną zmianę na monitorowanej stronie.',
        llmDecision?.short_title || 'Zmiana na monitorowanej stronie',
      ],
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

