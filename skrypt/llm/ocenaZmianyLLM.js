// skrypt/llm/ocenaZmianyLLM.js
// ZMIANA (krok 1 w tym pliku):
// - Uogólnione OCR (vision prompt): rating, reviews_count, labels, numbers, key_lines
// - Decyzję nadal podejmuje kod deterministycznie (mniej halucynacji / mniej spamu)
//
// ZMIANA (krok 2 w tym pliku):
// - Bardziej konserwatywna filtracja list (labels/numbers/key_lines) po confidence + evidence,
//   żeby ograniczyć halucynacje z vision.
// - Opcjonalny sygnał "numbers" (bardzo ostrożnie) – tylko gdy OCR poda sensowną listę
//   i podobieństwo jest naprawdę niskie (żeby nie spamować).

import { generateTextWithOllama } from './ollamaClient.js';
import {
  parseJsonFromLLM,
  normalizeUserPrompt,
  resolveEffectivePrompt,
  SYSTEM_DEFAULT_JUDGE_PROMPT,
} from './analysisUtils.js';

import { pool } from '../polaczeniePG.js';
import { mongoClient } from '../polaczenieMDB.js';
import { performance } from 'node:perf_hooks';

const db = mongoClient.db('inzynierka');
const analizyCol = db.collection('analizy'); // (zostawiamy – może używasz gdzie indziej)
const ocenyZmienCol = db.collection('oceny_zmian');

function stripBase64Prefix(b64) {
  if (!b64 || typeof b64 !== 'string') return null;
  return b64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
}

function extractJsonText(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();

  // 1) cała odpowiedź to JSON
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  // 2) blok ```json ... ```
  const codeBlockMatch = raw.match(/```json([\s\S]*?)```/i);
  if (codeBlockMatch && codeBlockMatch[1]) return codeBlockMatch[1].trim();

  // 3) blok ``` ... ``` (bez json)
  const anyCodeBlock = raw.match(/```([\s\S]*?)```/);
  if (anyCodeBlock && anyCodeBlock[1] && anyCodeBlock[1].trim().startsWith('{')) {
    return anyCodeBlock[1].trim();
  }

  // 4) wszystkie bloki { ... } – wybierz ostatni który ma "prev"/"new" lub "important"
  const curlyMatches = raw.match(/\{[\s\S]*?\}/g);
  if (curlyMatches && curlyMatches.length) {
    const preferred = curlyMatches.filter((b) => b.includes('"prev"') || b.includes('"new"') || b.includes('"important"'));
    return (preferred.length ? preferred[preferred.length - 1] : curlyMatches[curlyMatches.length - 1]).trim();
  }

  return null;
}

function safeParseJsonFromLLM(raw) {
  const jsonText = extractJsonText(raw);
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    // szybki fix: trailing commas
    try {
      const fixed = jsonText.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}

function normalizeEvidenceText(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function filterEvidenceUsed(evidenceUsed, diffReasons, diffTextEvidence) {
  if (!Array.isArray(evidenceUsed)) return { filtered: [], dropped: 0 };
  const reasonsStr = normalizeEvidenceText(JSON.stringify(diffReasons ?? []));
  const evidenceStr = normalizeEvidenceText(JSON.stringify(diffTextEvidence ?? {}));

  const filtered = evidenceUsed.filter((item) => {
    const snippet = normalizeEvidenceText(item);
    if (!snippet) return false;
    return reasonsStr.includes(snippet) || evidenceStr.includes(snippet);
  });

  return { filtered, dropped: evidenceUsed.length - filtered.length };
}

async function judgeImportanceWithLLM(
  { userPrompt, prevSummary, newSummary, diffMetrics, diffReasons, diffTextEvidence },
  { logger } = {},
) {
  const prompt = `
Masz DOKŁADNIE te dane wejściowe:
- prevSummary
- newSummary
- diffMetrics
- diffReasons
- diffTextEvidence
- userPrompt

  Twoje zadanie: oceń istotność zmiany zgodnie z userPrompt.
  NIE WOLNO używać wiedzy spoza podanych danych. Nie masz dostępu do OCR/HTML/screenshotów.
  Jeśli w danych nie ma dowodu spełniającego kryteria użytkownika -> important=false.
  evidence_used musi zawierać wyłącznie dokładne stringi skopiowane z diffReasons lub diffTextEvidence (bez parafraz).
  Nie wolno dodawać nowych tekstów do evidence_used.

Zwróć WYŁĄCZNIE JSON:
{
  "important": boolean,
  "category": string,
  "reason": string,
  "evidence_used": ["dokładne cytaty skopiowane z diffTextEvidence lub diffReasons"]
}

userPrompt:
${userPrompt || ''}

prevSummary:
${prevSummary || ''}

newSummary:
${newSummary || ''}

diffMetrics:
${JSON.stringify(diffMetrics ?? null)}

diffReasons:
${JSON.stringify(diffReasons ?? [])}

diffTextEvidence:
${JSON.stringify(diffTextEvidence ?? { added: [], removed: [] })}
`.trim();

  logger?.info?.('judge_llm_called', {
    hasUserPrompt: !!userPrompt,
  });

  let raw = null;
  let parsed = null;
  let fallbackUsed = false;
  let parsedJsonExtracted = false;
  let parsedJsonDirect = false;
  let evidenceValidationFailed = false;
  let fallbackReason = null;
  let evidenceFilteredCount = 0;

  try {
    const judgeTimeoutMsRaw = Number(process.env.OLLAMA_TIMEOUT_MS_JUDGE);
    const judgeTimeoutMs = Number.isFinite(judgeTimeoutMsRaw) ? judgeTimeoutMsRaw : undefined;
    raw = await generateTextWithOllama({
      prompt,
      model: process.env.OLLAMA_TEXT_MODEL || process.env.LLM_MODEL || 'llama3',
      options: { temperature: 0 },
      timeoutMs: judgeTimeoutMs,
    });

    const parsedResult = parseJsonFromLLM(raw);
    parsed = parsedResult.ok ? parsedResult.data : null;
    parsedJsonDirect = parsedResult.mode === 'direct';
    parsedJsonExtracted = parsedResult.mode === 'extracted';
    logger?.info?.('judge_json_extracted', {
      extracted: parsedJsonExtracted,
    });
    logger?.info?.('judge_json_extract_used', {
      json_extract_used: parsedJsonExtracted,
    });
    logger?.info?.('judge_json_parse_mode', {
      json_parse_mode: parsedResult.mode || 'none',
    });
    if (!parsed || typeof parsed.important !== 'boolean') {
      logger?.info?.('judge_json_extract_error', {
        json_extract_error: parsedResult.error || 'LLM_NO_JSON_FOUND',
      });
      fallbackUsed = true;
      fallbackReason = parsedResult.error || 'LLM_NO_JSON_FOUND';
    } else {
      const normalizedEvidence = Array.isArray(parsed.evidence_used)
        ? parsed.evidence_used.map((item) => String(item))
        : [];
      const filtered = filterEvidenceUsed(normalizedEvidence, diffReasons, diffTextEvidence);
      evidenceFilteredCount = filtered.dropped;
      parsed.evidence_used = filtered.filtered;
      logger?.info?.('judge_evidence_filtered_count', {
        dropped: filtered.dropped,
      });
      if (parsed.important === true && parsed.evidence_used.length === 0) {
        evidenceValidationFailed = true;
        fallbackUsed = true;
        fallbackReason = 'NO_EVIDENCE';
        logger?.info?.('judge_evidence_validation_failed', {
          important: parsed.important,
        });
      }
    }
  } catch {
    fallbackUsed = true;
    fallbackReason = 'LLM_NO_JSON_FOUND';
  }

  if (fallbackUsed) {
    logger?.info?.('judge_llm_fallback', {
      reason: fallbackReason || 'INVALID_TYPES',
    });
    return {
      result: {
        important: false,
        category: 'minor_change',
        reason: 'Brak wiarygodnych dowodów w dostarczonych danych.',
        evidence_used: [],
        llm_fallback_used: true,
        llm_fallback_reason: fallbackReason || 'LLM_NO_JSON_FOUND',
      },
      raw,
      prompt,
      parsed_json_extracted: parsedJsonExtracted,
      parsed_json_direct: parsedJsonDirect,
      evidence_validation_failed: evidenceValidationFailed,
      evidence_filtered_count: evidenceFilteredCount,
      llm_fallback_reason: fallbackReason || 'LLM_NO_JSON_FOUND',
      fallbackUsed: true,
    };
  }

  return {
    result: {
      important: !!parsed.important,
      category: String(parsed.category || 'minor_change'),
      reason: String(parsed.reason || ''),
      evidence_used: Array.isArray(parsed.evidence_used) ? parsed.evidence_used : [],
    },
    raw,
    prompt,
    parsed_json_extracted: parsedJsonExtracted,
    parsed_json_direct: parsedJsonDirect,
    evidence_validation_failed: false,
    evidence_filtered_count: evidenceFilteredCount,
    llm_fallback_reason: null,
    fallbackUsed: false,
  };
}


function ocrPreview(ocr, maxChars = 2000) {
  const t = ocr?.clean_text || ocr?.text || '';
  const s = String(t).replace(/\s+/g, ' ').trim();
  return s.length > maxChars ? s.slice(0, maxChars) + '...[TRUNCATED]' : s;
}

function summarizeOcrForStorage(ocr) {
  if (!ocr) return null;
  return {
    engine: ocr.engine || null,
    sourceHash: ocr.sourceHash || null,
    confidence: typeof ocr.confidence === 'number' ? ocr.confidence : null,
    clean_text_preview: ocrPreview(ocr, 500),
  };
}

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

function pickBestPriceFromTesseract(ocrSide) {
  const lines = ocrSide?.lines || [];
  if (!Array.isArray(lines) || lines.length === 0) return null;

  // szukamy "coś + waluta", bierzemy linię o najwyższym confidence
  const moneyRe = /(-?\d[\d\s]*([.,]\d{1,2})?)\s*(zł|zl|pln|eur|€|usd|\$|gbp|£)/i;

  let best = null;

  for (const ln of lines) {
    const t = String(ln?.text || "");
    const m = t.match(moneyRe);
    if (!m) continue;

    const n = toNumberMaybe(m[1]);
    if (n == null) continue;

    const conf = typeof ln?.confidence === "number" ? ln.confidence : 0;

    if (!best || conf > best.confidence) {
      best = {
        value: n,
        evidence: t,
        confidence: conf,
      };
    }
  }

  // próg ostrożny — żeby nie “strzelać” po słabym OCR
  if (best && best.confidence >= 0.65) return best;
  return null;
}



function toIntMaybe(v) {
  const n = toNumberMaybe(v);
  if (n == null) return null;
  return Math.trunc(n);
}

function parseRatingMaybe(v) {
  if (v == null) return null;
  const s = String(v).replace(/\u00A0/g, ' ').trim();
  // np. "4,8/5", "4.8", "4,8"
  const m = s.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  // ratingy zwykle 0..5
  if (n < 0 || n > 5.5) return null;
  return n;
}

function pickAnalysisPriceValue(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;
  const value = analysis?.price?.value ?? null;
  const n = toNumberMaybe(value);
  return typeof n === 'number' ? n : null;
}

function hasCurrencyHint(text) {
  const s = String(text || '').toLowerCase();
  return (
    s.includes('zł') ||
    s.includes('zl') ||
    s.includes('pln') ||
    s.includes('eur') ||
    s.includes('€') ||
    s.includes('$') ||
    s.includes('usd')
  );
}

function normText(v) {
  return String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function ocrField(side, key) {
  const f = side?.[key];
  const value = f?.value ?? f ?? null;
  const evidence = f?.evidence ?? null;
  const confidence = typeof f?.confidence === 'number' ? f.confidence : null;
  return { value, evidence, confidence };
}

function fieldIsReliable(f, minConf = 0.65) {
  if (!f) return false;
  const conf = typeof f.confidence === 'number' ? f.confidence : 0;
  const ev = f.evidence != null ? String(f.evidence).trim() : '';
  const val = f.value != null ? String(f.value).trim() : '';
  return conf >= minConf && ev.length >= 2 && val.length >= 1;
}

function pickMainPriceFromOcrSide(side) {
  if (!side || typeof side !== 'object') return null;

  // 1) main_price.value / evidence
  const mp = side.main_price || side.mainPrice;
  const mpValue = mp?.value ?? mp;
  const mpEvidence = mp?.evidence ?? '';

  if (hasCurrencyHint(mpValue) || hasCurrencyHint(mpEvidence)) {
    const n = toNumberMaybe(mpValue ?? mpEvidence);
    if (n != null) return n;
  }

  // 2) all_prices[]
  const arr = side.all_prices || side.allPrices || side.prices || [];
  if (Array.isArray(arr)) {
    for (const it of arr) {
      const v = it?.value ?? it;
      const e = it?.evidence ?? '';
      const c = typeof it?.confidence === 'number' ? it.confidence : null;
      // jeśli model poda "123" bez waluty – ignoruj, chyba że evidence ma walutę
      if (!hasCurrencyHint(v) && !hasCurrencyHint(e)) continue;
      // jeśli poda confidence i jest niskie – ignoruj
      if (c != null && c < 0.55) continue;

      const n = toNumberMaybe(v ?? e);
      if (n != null) return n;
    }
  }

  return null;
}

function pickRatingFromOcrSide(side) {
  const r = ocrField(side, 'rating');
  if (!fieldIsReliable(r, 0.6)) return null;
  return parseRatingMaybe(r.value ?? r.evidence);
}

function pickReviewsCountFromOcrSide(side) {
  const rc = ocrField(side, 'reviews_count');
  if (!fieldIsReliable(rc, 0.6)) return null;
  return toIntMaybe(rc.value ?? rc.evidence);
}

function normalizeList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => (typeof x === 'object' && x ? x : { value: x, evidence: null, confidence: null }))
    .map((x) => ({
      value: x?.value ?? null,
      evidence: x?.evidence ?? null,
      confidence: typeof x?.confidence === 'number' ? x.confidence : null,
    }));
}

function listToSet(arr, { minConf = 0.65, minLen = 2 } = {}) {
  const items = normalizeList(arr);
  const out = new Set();

  for (const it of items) {
    const val = it.value != null ? String(it.value).trim() : '';
    const ev = it.evidence != null ? String(it.evidence).trim() : '';
    const conf = typeof it.confidence === 'number' ? it.confidence : null;

    // jeśli model poda confidence -> wymagamy minimum
    if (conf != null && conf < minConf) continue;

    // evidence ma być “cytatem” -> jeśli brak evidence, to chociaż value musi być sensowne
    const text = normText(val || ev);
    if (!text || text.length < minLen) continue;

    // unikaj śmieci typu pojedyncze znaki
    if (text.length < minLen) continue;

    out.add(text);
  }

  return out;
}

function jaccardSet(a, b) {
  const A = a instanceof Set ? a : new Set(a || []);
  const B = b instanceof Set ? b : new Set(b || []);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
}

/**
 * Vision (OCR) ma tylko “czytać” obraz.
 * Decyzję o important podejmuje KOD deterministycznie.
 */
function buildDecisionFromOcrBundle(ocrBundle) {
  const prev = ocrBundle?.prev || ocrBundle?.before || ocrBundle?.old || null;
  const next = ocrBundle?.new || ocrBundle?.after || ocrBundle?.now || null;

  const oldPrice = pickMainPriceFromOcrSide(prev);
  const newPrice = pickMainPriceFromOcrSide(next);

  // 1) Cena
  if (oldPrice != null && newPrice != null && Math.abs(newPrice - oldPrice) >= 0.01) {
    return {
      important: true,
      category: 'price_change',
      importance_reason: 'OCR ze screenshotów potwierdził zmianę ceny (dwie różne ceny).',
      short_title: 'Zmiana ceny',
      short_description: `Cena zmieniła się z ${oldPrice} na ${newPrice}.`,
      old_price: oldPrice,
      new_price: newPrice,
    };
  }

  // 2) Dostępność
  const oldAvail = ocrField(prev, 'availability');
  const newAvail = ocrField(next, 'availability');
  if (fieldIsReliable(oldAvail, 0.65) && fieldIsReliable(newAvail, 0.65)) {
    const a = normText(oldAvail.value);
    const b = normText(newAvail.value);
    if (a && b && a !== b) {
      return {
        important: true,
        category: 'availability_change',
        importance_reason: 'OCR ze screenshotów potwierdził zmianę dostępności.',
        short_title: 'Zmiana dostępności',
        short_description: `"${a}" → "${b}"`,
        old_price: oldPrice ?? null,
        new_price: newPrice ?? null,
      };
    }
  }

  // 3) Dostawa
  const oldDel = ocrField(prev, 'delivery');
  const newDel = ocrField(next, 'delivery');
  if (fieldIsReliable(oldDel, 0.65) && fieldIsReliable(newDel, 0.65)) {
    const a = normText(oldDel.value);
    const b = normText(newDel.value);
    if (a && b && a !== b) {
      return {
        important: true,
        category: 'delivery_change',
        importance_reason: 'OCR ze screenshotów potwierdził zmianę dostawy.',
        short_title: 'Zmiana dostawy',
        short_description: `"${a}" → "${b}"`,
        old_price: oldPrice ?? null,
        new_price: newPrice ?? null,
      };
    }
  }

  // 4) Sprzedawca
  const oldSeller = ocrField(prev, 'seller');
  const newSeller = ocrField(next, 'seller');
  if (fieldIsReliable(oldSeller, 0.65) && fieldIsReliable(newSeller, 0.65)) {
    const a = normText(oldSeller.value);
    const b = normText(newSeller.value);
    if (a && b && a !== b) {
      return {
        important: true,
        category: 'seller_change',
        importance_reason: 'OCR ze screenshotów potwierdził zmianę sprzedawcy/źródła oferty.',
        short_title: 'Zmiana sprzedawcy',
        short_description: `"${a}" → "${b}"`,
        old_price: oldPrice ?? null,
        new_price: newPrice ?? null,
      };
    }
  }

  // 5) Ocena / liczba opinii
  const oldRating = pickRatingFromOcrSide(prev);
  const newRating = pickRatingFromOcrSide(next);
  if (oldRating != null && newRating != null && Math.abs(newRating - oldRating) >= 0.1) {
    return {
      important: true,
      category: 'content_update',
      importance_reason: 'OCR potwierdził zmianę oceny/gwiazdek.',
      short_title: 'Zmiana oceny',
      short_description: `Ocena zmieniła się z ${oldRating} na ${newRating}.`,
      old_price: oldPrice ?? null,
      new_price: newPrice ?? null,
    };
  }

  const oldReviews = pickReviewsCountFromOcrSide(prev);
  const newReviews = pickReviewsCountFromOcrSide(next);
  if (oldReviews != null && newReviews != null && Math.abs(newReviews - oldReviews) >= 10) {
    // podnosimy próg do 10, żeby nie spamować na popularnych stronach
    return {
      important: true,
      category: 'content_update',
      importance_reason: 'OCR potwierdził istotną zmianę liczby opinii/ocen.',
      short_title: 'Zmiana liczby opinii',
      short_description: `Liczba opinii zmieniła się z ${oldReviews} na ${newReviews}.`,
      old_price: oldPrice ?? null,
      new_price: newPrice ?? null,
    };
  }

  // 6) Etykiety / badge (promocja, smart, niedostępny...)
  const oldLabels = listToSet(prev?.labels || [], { minConf: 0.65, minLen: 2 });
  const newLabels = listToSet(next?.labels || [], { minConf: 0.65, minLen: 2 });
  const labelSim = jaccardSet(oldLabels, newLabels);

  if ((oldLabels.size + newLabels.size) > 0 && labelSim < 0.5) {
    const joined = [...newLabels].join(' ');
    if (joined.includes('niedost') || joined.includes('brak') || joined.includes('out of stock')) {
      return {
        important: true,
        category: 'availability_change',
        importance_reason: 'Zmiana etykiet/badge sugeruje zmianę dostępności.',
        short_title: 'Zmiana dostępności',
        short_description: `Etykiety zmieniły się: "${[...oldLabels].join(', ')}" → "${[...newLabels].join(', ')}"`,
        old_price: oldPrice ?? null,
        new_price: newPrice ?? null,
      };
    }

    return {
      important: true,
      category: 'content_update',
      importance_reason: 'OCR wykrył zmianę istotnych etykiet/badge na widoku.',
      short_title: 'Zmiana oznaczeń',
      short_description: `Etykiety zmieniły się: "${[...oldLabels].join(', ')}" → "${[...newLabels].join(', ')}"`,
      old_price: oldPrice ?? null,
      new_price: newPrice ?? null,
    };
  }

  // 7) Ogólna treść: key_lines (uogólnienie na dowolne strony)
  // BARDZO konserwatywnie, żeby nie spamować: wymagamy dużej zmiany + sensowna liczba linii.
  const oldLines = listToSet(prev?.key_lines || prev?.keyLines || [], { minConf: 0.65, minLen: 3 });
  const newLines = listToSet(next?.key_lines || next?.keyLines || [], { minConf: 0.65, minLen: 3 });
  const lineSim = jaccardSet(oldLines, newLines);

  if ((oldLines.size >= 14 || newLines.size >= 14) && lineSim < 0.45) {
    return {
      important: true,
      category: 'content_update',
      importance_reason: 'Wykryto większą zmianę widocznych tekstów na stronie (OCR key_lines).',
      short_title: 'Zmiana treści strony',
      short_description: 'Wykryto większą zmianę widocznych komunikatów/tekstu na stronie.',
      old_price: oldPrice ?? null,
      new_price: newPrice ?? null,
    };
  }

  // 8) (Opcjonalnie) "numbers" – tylko jeśli lista jest duża i bardzo się różni.
  // Uwaga: to potrafi spamować, więc jest bardzo konserwatywne.
  const oldNums = listToSet(prev?.numbers || [], { minConf: 0.7, minLen: 2 });
  const newNums = listToSet(next?.numbers || [], { minConf: 0.7, minLen: 2 });
  const numSim = jaccardSet(oldNums, newNums);

  if ((oldNums.size >= 10 || newNums.size >= 10) && numSim < 0.35) {
    return {
      important: true,
      category: 'content_update',
      importance_reason: 'Wykryto istotną zmianę ważnych wartości liczbowych na widoku (OCR numbers).',
      short_title: 'Zmiana danych liczbowych',
      short_description: 'Zmieniły się istotne wartości liczbowe widoczne na stronie.',
      old_price: oldPrice ?? null,
      new_price: newPrice ?? null,
    };
  }

  return {
    important: false,
    category: 'minor_change',
    importance_reason:
      'OCR nie potwierdził jednoznacznej zmiany ceny/dostępności/dostawy/sprzedawcy ani wyraźnej zmiany treści.',
    short_title: 'Brak istotnej zmiany',
    short_description: 'Różnice wyglądają na nieistotne lub niejednoznaczne.',
    old_price: oldPrice ?? null,
    new_price: newPrice ?? null,
  };
}

function buildDecisionFromMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;

  const textScore = typeof metrics.textDiffScore === 'number' ? metrics.textDiffScore : 0;
  const numericScore = typeof metrics.numericDiffScore === 'number' ? metrics.numericDiffScore : 0;

  const hasContentChange =
    metrics.titleChanged === true ||
    metrics.descriptionChanged === true ||
    textScore > 0.15;

  if (hasContentChange) {
    const reasons = [];
    if (metrics.titleChanged === true) reasons.push('zmiana tytułu');
    if (metrics.descriptionChanged === true) reasons.push('zmiana opisu');
    if (textScore > 0.15) reasons.push(`textDiffScore=${textScore.toFixed(3)}`);

    return {
      important: true,
      category: 'content_change',
      importance_reason: reasons.length
        ? `Wykryto istotną zmianę treści (${reasons.join(', ')}).`
        : 'Wykryto istotną zmianę treści.',
      short_title: 'Zmiana treści',
      short_description: 'Treść strony uległa istotnej zmianie.',
    };
  }

  const reviewsChanged =
    (metrics.reviews?.prevCount != null &&
      metrics.reviews?.nowCount != null &&
      metrics.reviews.prevCount !== metrics.reviews.nowCount) ||
    (metrics.reviews?.prevRating != null &&
      metrics.reviews?.nowRating != null &&
      metrics.reviews.prevRating !== metrics.reviews.nowRating);

  if (reviewsChanged) {
    const parts = [];
    if (metrics.reviews?.prevCount != null && metrics.reviews?.nowCount != null) {
      parts.push(`opinie ${metrics.reviews.prevCount} → ${metrics.reviews.nowCount}`);
    }
    if (metrics.reviews?.prevRating != null && metrics.reviews?.nowRating != null) {
      parts.push(`ocena ${metrics.reviews.prevRating} → ${metrics.reviews.nowRating}`);
    }

    return {
      important: true,
      category: 'review_change',
      importance_reason: parts.length
        ? `Zmiana opinii/oceny: ${parts.join(', ')}.`
        : 'Zmiana opinii lub oceny produktu.',
      short_title: 'Zmiana opinii',
      short_description: 'Zmieniono liczbę opinii lub średnią ocenę.',
    };
  }

  const secondaryChanged =
    metrics.secondaryPrices &&
    metrics.secondaryPrices.prev?.length > 0 &&
    metrics.secondaryPrices.now?.length > 0 &&
    JSON.stringify(metrics.secondaryPrices.prev) !== JSON.stringify(metrics.secondaryPrices.now);

  if (secondaryChanged) {
    const prevMin = metrics.secondaryPrices?.prevMin;
    const nowMin = metrics.secondaryPrices?.nowMin;
    const reasonParts = [];
    if (prevMin != null || nowMin != null) {
      reasonParts.push(`min ${prevMin ?? '—'} → ${nowMin ?? '—'}`);
    }

    return {
      important: true,
      category: 'secondary_price_change',
      importance_reason: reasonParts.length
        ? `Zmiana cen drugorzędnych (${reasonParts.join(', ')}).`
        : 'Zmiana cen drugorzędnych.',
      short_title: 'Zmiana cen (drugorzędne)',
      short_description: 'Wykryto zmianę cen drugorzędnych na stronie.',
    };
  }

  if (numericScore > 0.1) {
    return {
      important: true,
      category: 'numeric_change',
      importance_reason: `Zmiana danych liczbowych w treści (numericDiffScore=${numericScore.toFixed(3)}).`,
      short_title: 'Zmiana danych liczbowych',
      short_description: 'Wykryto istotną zmianę danych liczbowych na stronie.',
    };
  }

  return null;
}

function shouldUseVisionCompare({ diff, prevAnalysis, newAnalysis }) {
  if (diff?.metrics?.pluginPricesChanged === true) return false;
  if (prevAnalysis?.error || newAnalysis?.error) return true;

  const reasonsLen = Array.isArray(diff?.reasons) ? diff.reasons.length : 0;
  const textScore = typeof diff?.metrics?.textDiffScore === 'number' ? diff.metrics.textDiffScore : 0;

  const absPrice = diff?.metrics?.price && typeof diff.metrics.price.absChange === 'number' ? diff.metrics.price.absChange : 0;
  if (absPrice !== 0) return false;

  if (diff?.metrics?.screenshotChanged === true) return true;
  return reasonsLen === 0 || textScore < 0.01;
}

export async function evaluateChangeWithLLM(
  {
    monitorId,
    zadanieId,
    url,
    prevAnalysis,
    newAnalysis,
    diff,
    prevOcr,
    newOcr,
    userPrompt,
  },
  { logger } = {},
) {
  const log = logger || console;
  const tEval0 = performance.now();
  const normalizedUserPrompt = normalizeUserPrompt(userPrompt);
  const effectivePrompt = resolveEffectivePrompt(userPrompt, SYSTEM_DEFAULT_JUDGE_PROMPT);

  log.info('llm_change_eval_start', { monitorId, zadanieId, url });

  const trackedFields = Array.isArray(newAnalysis?.intent?.trackedFields)
    ? newAnalysis.intent.trackedFields
    : Array.isArray(prevAnalysis?.intent?.trackedFields)
      ? prevAnalysis.intent.trackedFields
      : [];
  const trackedExtrasChanges = diff?.metrics?.trackedExtrasChanges || {};
  const trackedExtrasChanged = diff?.metrics?.trackedExtrasChanged === true;
  const diffReasons = diff?.reasons || [];
  const diffTextEvidence = diff?.textEvidence || { added: [], removed: [] };
  const prevSummary = prevAnalysis?.summary || '';
  const newSummary = newAnalysis?.summary || '';

  const formatEvidence = (items) =>
    Array.isArray(items) && items.length ? items.map((item) => `"${item}"`).join(', ') : 'brak';

  let decision = null;
  let judgePrompt = null;
  let judgeRaw = null;
  let judgeParsedJsonExtracted = false;
  let judgeParsedJsonDirect = false;
  let judgeEvidenceValidationFailed = false;
  let judgeSkippedReason = null;
  let judgeEvidenceFilteredCount = 0;
  let judgeFallbackReason = null;
  let usedMode = 'rule';
  let usedModel = null;

  if (trackedFields.length > 0) {
    if (trackedFields.includes('main_price') && trackedExtrasChanges.main_price) {
      const change = trackedExtrasChanges.main_price;
      decision = {
        important: true,
        category: 'price_change',
        importance_reason: `Zmiana ceny (extras.main_price): ${change.before} → ${change.after}. Dowody: prev=[${formatEvidence(change.beforeEvidence)}], now=[${formatEvidence(change.afterEvidence)}].`,
        evidence_used: [...(change.beforeEvidence || []), ...(change.afterEvidence || [])],
        short_title: 'Zmiana ceny',
        short_description: `Cena zmieniła się z ${change.before} na ${change.after}.`,
        old_price: change.before,
        new_price: change.after,
      };
    } else if (trackedFields.includes('review_count') && trackedExtrasChanges.review_count) {
      const change = trackedExtrasChanges.review_count;
      decision = {
        important: true,
        category: 'reviews_change',
        importance_reason: `Zmiana liczby opinii (extras.review_count): ${change.before} → ${change.after}. Dowody: prev=[${formatEvidence(change.beforeEvidence)}], now=[${formatEvidence(change.afterEvidence)}].`,
        evidence_used: [...(change.beforeEvidence || []), ...(change.afterEvidence || [])],
        short_title: 'Zmiana liczby opinii',
        short_description: `Liczba opinii zmieniła się z ${change.before} na ${change.after}.`,
      };
    } else if (trackedFields.includes('rating') && trackedExtrasChanges.rating) {
      const change = trackedExtrasChanges.rating;
      decision = {
        important: true,
        category: 'rating_change',
        importance_reason: `Zmiana oceny (extras.rating): ${change.before} → ${change.after}. Dowody: prev=[${formatEvidence(change.beforeEvidence)}], now=[${formatEvidence(change.afterEvidence)}].`,
        evidence_used: [...(change.beforeEvidence || []), ...(change.afterEvidence || [])],
        short_title: 'Zmiana oceny',
        short_description: `Ocena zmieniła się z ${change.before} na ${change.after}.`,
      };
    } else {
      decision = {
        important: false,
        category: 'no_tracked_change',
        importance_reason: 'Nie wykryto zmian w śledzonych polach (extras).',
        short_title: 'Brak zmian w śledzonych polach',
        short_description: 'Zmieniły się tylko elementy nieobjęte śledzeniem.',
      };
    }

    if (trackedExtrasChanged && decision.important === true) {
      const judge = await judgeImportanceWithLLM(
        {
          userPrompt: effectivePrompt,
          prevSummary,
          newSummary,
          diffMetrics: diff?.metrics,
          diffReasons,
          diffTextEvidence,
        },
        { logger: log },
      );

      judgePrompt = judge.prompt;
      judgeRaw = judge.raw;
      judgeParsedJsonExtracted = judge.parsed_json_extracted === true;
      judgeParsedJsonDirect = judge.parsed_json_direct === true;
      judgeEvidenceValidationFailed = judge.evidence_validation_failed === true;
      judgeEvidenceFilteredCount = judge.evidence_filtered_count || 0;
      judgeFallbackReason = judge.llm_fallback_reason || null;
      usedMode = 'judge';
      usedModel = process.env.OLLAMA_TEXT_MODEL || process.env.LLM_MODEL || 'llama3';

      if (!judge.fallbackUsed) {
        if (judge.result?.reason) {
          decision.importance_reason = judge.result.reason;
        }
        if (Array.isArray(judge.result?.evidence_used)) {
          decision.evidence_used = judge.result.evidence_used;
        }
      } else {
        decision.llm_fallback_used = true;
        decision.llm_fallback_reason = judge.llm_fallback_reason || null;
      }
    }
  } else {
    const judge = await judgeImportanceWithLLM(
      {
        userPrompt: effectivePrompt,
        prevSummary,
        newSummary,
        diffMetrics: diff?.metrics,
        diffReasons,
        diffTextEvidence,
      },
      { logger: log },
    );

    judgePrompt = judge.prompt;
    judgeRaw = judge.raw;
    judgeParsedJsonExtracted = judge.parsed_json_extracted === true;
    judgeParsedJsonDirect = judge.parsed_json_direct === true;
    judgeEvidenceValidationFailed = judge.evidence_validation_failed === true;
    judgeEvidenceFilteredCount = judge.evidence_filtered_count || 0;
    judgeFallbackReason = judge.llm_fallback_reason || null;
    usedMode = 'judge';
    usedModel = process.env.OLLAMA_TEXT_MODEL || process.env.LLM_MODEL || 'llama3';

    decision = {
      important: !!judge.result?.important,
      category: judge.result?.category || 'minor_change',
      importance_reason: judge.result?.reason || 'Brak istotnych zmian w danych.',
      evidence_used: Array.isArray(judge.result?.evidence_used) ? judge.result.evidence_used : [],
      short_title: judge.result?.important ? 'Zmiana na monitorowanej stronie' : 'Brak istotnej zmiany',
      short_description: judge.result?.reason || 'Brak istotnych zmian w danych.',
      llm_fallback_used: judge.result?.llm_fallback_used === true,
      llm_fallback_reason: judge.result?.llm_fallback_reason || judgeFallbackReason,
    };
  }

  if (!decision) {
    decision = {
      important: false,
      category: 'minor_change',
      importance_reason: 'Brak istotnych zmian w danych.',
      short_title: 'Brak istotnej zmiany',
      short_description: 'Nie udało się potwierdzić istotnej zmiany na podstawie danych.',
    };
  }

  let usedPrompt = judgePrompt;
  let raw = judgeRaw;

  if (decision.important === true) {
    const summaryMode = usedMode === 'judge' ? 'judge' : 'summary_llm';
    const summaryModel = process.env.OLLAMA_TEXT_MODEL || process.env.LLM_MODEL || 'llama3';

    const userCriteriaSection = effectivePrompt
      ? `
Instrukcje użytkownika (tylko kontekst, nie dane wejściowe):
${effectivePrompt}
`
      : '';

    const summaryPrompt = `
Masz dane JSON: decision, diff.
Twoje zadanie: przygotuj krótki tytuł i opis powiadomienia.
NIE ZMIENIAJ ważności ani kategorii. Nie dodawaj nowych faktów.

Zwróć WYŁĄCZNIE JSON:
{
  "short_title": string,
  "short_description": string
}
${userCriteriaSection}

decision:
${JSON.stringify(decision ?? null)}

diff:
${JSON.stringify(diff ?? null)}
`.trim();

    try {
      const summaryRaw = await generateTextWithOllama({
        prompt: summaryPrompt,
        model: summaryModel,
        temperature: 0,
      });

      const parsedSummary = safeParseJsonFromLLM(summaryRaw);
      if (parsedSummary && typeof parsedSummary.short_title === 'string') {
        decision.short_title = parsedSummary.short_title;
      }
      if (parsedSummary && typeof parsedSummary.short_description === 'string') {
        decision.short_description = parsedSummary.short_description;
      }
    } catch (err) {
      decision.llm_fallback_used = true;
    }

    usedMode = summaryMode;
    usedModel = summaryModel;
  }

  const { insertedId } = await ocenyZmienCol.insertOne({
    createdAt: new Date(),
    monitorId,
    zadanieId,
    url,
    llm_mode: usedMode,
    model: usedModel,
    prompt_used: usedPrompt,
    raw_response: raw,
    parsed_json_extracted: judgeParsedJsonExtracted,
    parsed_json_direct: judgeParsedJsonDirect,
    judge_skipped_reason: judgeSkippedReason,
    evidence_validation_failed: judgeEvidenceValidationFailed,
    evidence_filtered_count: judgeEvidenceFilteredCount,
    llm_fallback_reason: judgeFallbackReason,
    vision_ocr: {
      prev: summarizeOcrForStorage(prevOcr),
      next: summarizeOcrForStorage(newOcr),
    },
    llm_decision: decision,
    error: null,
    durationMs: Math.round(performance.now() - tEval0),
  });

  log.info('llm_change_eval_success', {
    monitorId,
    zadanieId,
    mongoId: insertedId,
    important: !!decision?.important,
    category: decision?.category || null,
    usedMode,
    usedModel,
  });

  return { parsed: decision, raw, mongoId: insertedId };
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

    // jeśli nieistotne – bez powiadomienia
    if (llmDecision.important !== true) {
      await client.query('COMMIT');
      ok = true;
      return { detectionId };
    }

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
        llmDecision.short_description ||
          llmDecision.importance_reason ||
          'Wykryto istotną zmianę na monitorowanej stronie.',
        llmDecision.short_title || 'Zmiana na monitorowanej stronie',
      ],
    );

    await client.query('COMMIT');
    ok = true;

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
