// skrypt/llm/llmEvidence.js
// Evidence extraction v4 (prompt-adaptive + chunk-selection):
// - Build short verbatim candidate snippets deterministically (so we never "hallucinate" quotes).
// - Select the *most relevant* chunks across the whole text (not just the first N).
// - LLM only selects candidate IDs relevant to USER_PROMPT.
// - Returned quotes are always exact substrings of the chosen chunk text.
//
// Backward-compatible: ignores unknown options passed by callers.

import { generateTextWithOllama } from './ollamaClient.js';

// Defaults can be tuned via env.
const DEFAULT_MAX_CHUNKS = Number.parseInt(process.env.EVIDENCE_MAX_CHUNKS || '14', 10);
const DEFAULT_MAX_CANDIDATES_PER_CHUNK = Number.parseInt(
  process.env.EVIDENCE_MAX_CANDIDATES_PER_CHUNK || '14',
  10
);
const DEFAULT_MAX_QUOTES_PER_CHUNK = Number.parseInt(
  process.env.EVIDENCE_MAX_QUOTES_PER_CHUNK || '4',
  10
);
const DEFAULT_MAX_ITEMS_TOTAL = Number.parseInt(
  process.env.EVIDENCE_MAX_ITEMS_TOTAL || '10',
  10
);

// Deterministic selection for "new item" prompts (recommended ON to avoid nondeterministic evidence subsets).
const DEFAULT_DETERMINISTIC_NEW_ITEM =
  String(process.env.EVIDENCE_DETERMINISTIC_NEW_ITEM ?? 'true').trim().toLowerCase() === 'true';
const DEFAULT_MAX_ITEMS_TOTAL_NEW_ITEM = Number.parseInt(
  process.env.EVIDENCE_MAX_ITEMS_TOTAL_NEW_ITEM || '60',
  10
);

// Deterministic ranking extraction (ON by default).
// Enables stable evidence for "top-N / ranking / ranks" prompts without LLM selection.
// Disable via: EVIDENCE_DETERMINISTIC_RANKING=false
const DEFAULT_DETERMINISTIC_RANKING =
  String(process.env.EVIDENCE_DETERMINISTIC_RANKING ?? 'true').trim().toLowerCase() === 'true';

const DEFAULT_MAX_ITEMS_TOTAL_RANKING = Number.parseInt(
  process.env.EVIDENCE_MAX_ITEMS_TOTAL_RANKING || '60',
  10
);
// Deterministic reviews evidence (ON by default).
// Helps monitoring prompts like: "powiadom gdy pojawi się nowa opinia/recenzja albo zmieni się ocena".
// Disable via: EVIDENCE_DETERMINISTIC_REVIEWS=false
const DEFAULT_DETERMINISTIC_REVIEWS =
  String(process.env.EVIDENCE_DETERMINISTIC_REVIEWS ?? 'true').trim().toLowerCase() === 'true';

const DEFAULT_MAX_ITEMS_TOTAL_REVIEWS = Number.parseInt(
  process.env.EVIDENCE_MAX_ITEMS_TOTAL_REVIEWS || '14',
  10
);

// Deterministic evidence for explicit paragraph monitoring prompts.
// Example: "monitoruj paragrafy od 1 do 3" => return full blocks for [P001],[P002],[P003] (no LLM selection).
// Disable via: EVIDENCE_DETERMINISTIC_PARAGRAPHS=false
const DEFAULT_DETERMINISTIC_PARAGRAPHS =
  String(process.env.EVIDENCE_DETERMINISTIC_PARAGRAPHS ?? 'true').trim().toLowerCase() === 'true';

// Hard cap to avoid returning hundreds/thousands of paragraph blocks by accident.
const DEFAULT_MAX_ITEMS_TOTAL_PARAGRAPHS = Number.parseInt(
  process.env.EVIDENCE_MAX_ITEMS_TOTAL_PARAGRAPHS || '120',
  10
);



// --- Prompt routing (LLM -> labels) ---
// The router is used only to decide *which deterministic evidence mode* to run.
// If the router returns no labels, we fall back to classic LLM evidence selection.
const DEFAULT_LLM_ROUTER_ENABLED =
  String(process.env.EVIDENCE_LLM_ROUTER_ENABLED ?? 'true').trim().toLowerCase() === 'true';
const DEFAULT_LLM_ROUTER_TIMEOUT_MS = Number.parseInt(
  process.env.EVIDENCE_LLM_ROUTER_TIMEOUT_MS || '9000',
  10
);

// Deterministic evidence for item lists (stable, complete list rows with details).
// By default we only use this when router assigns ITEM_LIST.
const DEFAULT_DETERMINISTIC_ITEM_LIST =
  String(process.env.EVIDENCE_DETERMINISTIC_ITEM_LIST ?? 'true').trim().toLowerCase() === 'true';
const DEFAULT_MAX_ITEMS_TOTAL_ITEM_LIST = Number.parseInt(
  process.env.EVIDENCE_MAX_ITEMS_TOTAL_ITEM_LIST || '40',
  10
);
const DEFAULT_MAX_ITEMS_TOTAL_ITEM_LIST_DIFF = Number.parseInt(
  process.env.EVIDENCE_MAX_ITEMS_TOTAL_ITEM_LIST_DIFF || String(DEFAULT_MAX_ITEMS_TOTAL_NEW_ITEM),
  10
);

const DEFAULT_WINDOW_CHARS = Number.parseInt(process.env.EVIDENCE_WINDOW_CHARS || '48', 10);
const DEFAULT_MAX_QUOTE_LEN = Number.parseInt(process.env.EVIDENCE_MAX_QUOTE_LEN || '180', 10);
const DEFAULT_WINDOW_WORDS = Number.parseInt(process.env.EVIDENCE_WINDOW_WORDS || '3', 10);

// Optional heuristic noise filters (OFF by default).
// Enable via: LLM_EVIDENCE_HEURISTICS=true
const EVIDENCE_HEURISTICS_ENABLED =
  String(process.env.LLM_EVIDENCE_HEURISTICS || 'false').trim().toLowerCase() === 'true';

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function isWs(ch) {
  return (
    ch === ' ' ||
    ch === '\n' ||
    ch === '\t' ||
    ch === '\r' ||
    ch === '\f' ||
    ch === '\v'
  );
}

function trimToWsBoundaries(text, s, e) {
  let start = s;
  let end = e;

  // move start left to whitespace boundary if we are in the middle of a token
  while (start > 0 && !isWs(text[start - 1]) && !isWs(text[start])) start--;
  // move end right to whitespace boundary
  while (end < text.length && !isWs(text[end - 1]) && !isWs(text[end])) end++;

  start = clamp(start, 0, text.length);
  end = clamp(end, 0, text.length);
  return [start, end];
}

function extractWindowByChars(text, matchStart, matchEnd, opts = {}) {
  const win = Number.isFinite(opts.windowChars) ? opts.windowChars : DEFAULT_WINDOW_CHARS;
  const maxLen = Number.isFinite(opts.maxLen) ? opts.maxLen : DEFAULT_MAX_QUOTE_LEN;

  if (!text || typeof text !== 'string') return '';

  let s = clamp(matchStart - win, 0, text.length);
  let e = clamp(matchEnd + win, 0, text.length);
  [s, e] = trimToWsBoundaries(text, s, e);

  let snippet = text.slice(s, e).trim();
  if (snippet.length <= maxLen) return snippet;

  // shrink deterministically around the match
  const midWin = Math.max(18, Math.floor((maxLen - (matchEnd - matchStart)) / 2));
  s = clamp(matchStart - midWin, 0, text.length);
  e = clamp(matchEnd + midWin, 0, text.length);
  [s, e] = trimToWsBoundaries(text, s, e);
  snippet = text.slice(s, e).trim();

  if (snippet.length > maxLen) {
    // last resort: hard cut but still verbatim
    snippet = snippet.slice(0, maxLen).trim();
  }

  return snippet;
}

function extractWindowByWords(text, matchStart, matchEnd, opts = {}) {
  const words = Math.max(0, Number.isFinite(opts.windowWords) ? opts.windowWords : DEFAULT_WINDOW_WORDS);
  const maxLen = Number.isFinite(opts.maxLen) ? opts.maxLen : DEFAULT_MAX_QUOTE_LEN;
  if (!text || typeof text !== 'string') return '';
  if (words === 0) return extractWindowByChars(text, matchStart, matchEnd, opts);

  const spans = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) {
    spans.push([m.index, m.index + m[0].length]);
    if (spans.length > 6000) break;
  }
  if (!spans.length) return extractWindowByChars(text, matchStart, matchEnd, opts);

  let sIdx = 0;
  while (sIdx < spans.length && spans[sIdx][1] <= matchStart) sIdx++;
  if (sIdx >= spans.length) sIdx = spans.length - 1;

  let eIdx = sIdx;
  while (eIdx < spans.length && spans[eIdx][0] < matchEnd) eIdx++;
  eIdx = Math.max(sIdx, eIdx - 1);

  const startTok = clamp(sIdx - words, 0, spans.length - 1);
  const endTok = clamp(eIdx + words, 0, spans.length - 1);

  let s = spans[startTok][0];
  let e = spans[endTok][1];
  [s, e] = trimToWsBoundaries(text, s, e);

  let snippet = text.slice(s, e).trim();
  if (snippet.length <= maxLen) return snippet;

  // fallback: keep verbatim but shrink by char-window
  return extractWindowByChars(text, matchStart, matchEnd, { ...opts, maxLen });
}

function extractWindowByLines(text, matchStart, matchEnd, opts = {}) {
  const maxLen = Number.isFinite(opts.maxLen) ? opts.maxLen : DEFAULT_MAX_QUOTE_LEN;
  const before = clamp(Number.isFinite(opts.linesBefore) ? opts.linesBefore : 0, 0, 6);
  const after = clamp(Number.isFinite(opts.linesAfter) ? opts.linesAfter : 0, 0, 6);

  if (!text || typeof text !== 'string') return '';

  const hasNewlines = text.indexOf('\n') !== -1;
  if (!hasNewlines) return extractWindowByWords(text, matchStart, matchEnd, opts);

  // Find current line bounds
  let s = text.lastIndexOf('\n', Math.max(0, matchStart - 1));
  s = s === -1 ? 0 : s + 1;
  let e = text.indexOf('\n', matchEnd);
  e = e === -1 ? text.length : e;

  // Expand by N lines
  for (let i = 0; i < before; i++) {
    const prev = text.lastIndexOf('\n', Math.max(0, s - 2));
    if (prev === -1) {
      s = 0;
      break;
    }
    s = prev + 1;
  }
  for (let i = 0; i < after; i++) {
    const next = text.indexOf('\n', Math.min(text.length, e + 1));
    if (next === -1) {
      e = text.length;
      break;
    }
    e = next;
  }

  let snippet = text.slice(s, e).trim();
  if (!snippet) return '';

  if (snippet.length > maxLen) {
    // If line-window is too long, shrink around match
    return extractWindowByWords(text, matchStart, matchEnd, { ...opts, maxLen });
  }

  return snippet;
}

function extractWindowSmart(text, matchStart, matchEnd, opts = {}) {
  // Prefer line-based snippets when input is line-oriented (DOM clean_lines / OCR lines).
  // Keeps evidence stable & readable: usually one bullet / one line.
  // NOTE: We do NOT force linesAfter=1 here because it can create long 2-line snippets that then get truncated.
  const hasNewlines = typeof text === 'string' && text.indexOf('\n') !== -1;
  if (hasNewlines) return extractWindowByLines(text, matchStart, matchEnd, opts);
  return extractWindowByWords(text, matchStart, matchEnd, opts);
}

function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/["'`]/g, '')
    .trim();
}

function pushCandidate(out, seen, id, quote, kind, extra = null) {
  const q = String(quote || '').trim();
  if (!q) return;
  const key = normKey(q);
  if (!key || seen.has(key)) return;
  seen.add(key);
  const more = extra && typeof extra === 'object' ? extra : null;
  out.push({ id, quote: q, kind, ...(more || {}) });
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PROMPT_STOPWORDS = new Set([
  // Polish / generic connectors
  'i', 'a', 'o', 'w', 'z', 'za', 'do', 'na', 'od', 'po', 'pod', 'nad', 'oraz', 'lub',
  'tylko', 'gdy', 'kiedy', 'że', 'ze', 'sie', 'się', 'nie', 'tak', 'jak', 'żeby', 'zeby', 'aby',
  // common prompt words
  'monitoruj', 'monitorować', 'monitorowac', 'powiadom', 'powiadomić', 'powiadomic', 'ignoruj', 'ignore',
  'jezeli', 'jeśli', 'jesli', 'pojawi', 'pojawić', 'pojawic', 'pojawia', 'pojawie', 'nowy', 'nowa', 'nowe', 'dodaj', 'dodane', 'dodany',
  'new', 'added', 'add', 'appears', 'appear', 'notify',
  'oferta', 'oferte', 'strona', 'strony', 'elementy', 'pozostałe', 'pozostale',
  // platform generic
  'allegro', 'ceneo', 'amazon', 'ebay', 'booking', 'steam', 'zalando', 'decathlon',
  // very generic nouns
  'produkt', 'produktu', 'produkty', 'products', 'item', 'items',
  'artykul', 'artykuł', 'artykuly', 'artykuły', 'wiadomosc', 'wiadomość', 'wiadomosci', 'wiadomości', 'news', 'wpis', 'wpisy', 'post', 'posty', 'ogloszenie', 'ogłoszenie', 'ogloszenia', 'ogłoszenia',
  'paragraf', 'paragrafy', 'akapit', 'akapity', 'ustep', 'ustęp', 'sekcja',
  'section', 'paragraph', 'para',
]);

function extractPromptKeywords(userPrompt, max = 12) {
  const p = String(userPrompt || '').toLowerCase();
  const words = p.match(/[\p{L}\p{N}]+/gu) || [];
  const uniq = [];
  for (const w of words) {
    if (w.length < 4) continue;
    if (PROMPT_STOPWORDS.has(w)) continue;
    if (!uniq.includes(w)) uniq.push(w);
    if (uniq.length >= max) break;
  }
  return uniq;
}

function promptWantsSellerInfo(userPromptLower) {
  return /sprzedaw/.test(userPromptLower) || /seller/.test(userPromptLower);
}

function hasReviewHintLower(s) {
  return /(opin|recenz|review|rating|ocen|gwiazd|★|\/5|\/10)/.test(s);
}

function isSellerPercentContextLower(s) {
  return /(sprzedaw|w ostatnich|miesiac|kupujacych\s+polec|polec\w*\s+tego\s+sprzedaw|firma\s+poleca)/.test(s);
}

function isFinanceContextLower(s) {
  // Installments / financing context (avoid treating these amounts as "price")
  return /\b(rata|raty|miesięcz|miesiecz|leasing|wpłata|wplata|kredyt|finansowan|okres|miesi[aą]c|max\.?|maks\.?)\b/.test(s);
}

function isPriceOrDeliveryNoiseLower(s) {
  return /(\bzł\b|\bzl\b|pln|smart|rat|dostaw|kup\s+do|zaplac|pay|\b\d{1,2}:\d{2}\b)/.test(s);
}


/**
 * Parse paragraph references from user prompt.
 * Examples supported:
 *  - "paragraf 3" => P003 (+ neighbours P002,P004)
 *  - "paragrafy 4-9" / "paragrafach od 4 do 9" => P004..P009 (+ neighbours)
 *  - "[P015]" => P015 (+ neighbours)
 */
function parseParagraphSelectionFromPrompt(userPrompt) {
  const raw = String(userPrompt || '');
  const p = raw.toLowerCase();
  const pNorm = p
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
  const requested = new Set();
  let hadExplicit = false;
  let hadOrdinal = false;

  // "between / pomiedzy / miedzy" forms: treat as inclusive range when two numbers are provided.
  // Examples: "pomiędzy paragrafem 5 i paragrafem 7", "between paragraph 5 and 7".
  const reBetween = /\b(?:pomiedzy|miedzy|between)\b[^\d]{0,40}(?:paragraf|akapit|ustep|ustęp|section|paragraph|para)[^\d]{0,20}(\d{1,4})[^\d]{0,40}(?:i|a|and|to|oraz|-)\s*(?:paragraf|akapit|ustep|ustęp|section|paragraph|para)?[^\d]{0,20}(\d{1,4})/gi;
  let bm;
  while ((bm = reBetween.exec(pNorm)) !== null) {
    const a = intFromMaybe(bm[1]);
    const b = intFromMaybe(bm[2]);
    if (a === null || b === null) continue;
    hadExplicit = true;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) requested.add(i);
  }

  // Explicit tags like [P003]
  const reBracket = /\[\s*p\s*(\d{1,4})\s*\]/gi;
  let m;
  while ((m = reBracket.exec(raw)) !== null) {
    const n = intFromMaybe(m[1]);
    if (n !== null && n >= 1) {
      requested.add(n);
      hadExplicit = true;
    }
  }

  // Explicit tags without brackets, like: P003, p3, P003-P005
  const rePlainPRange = /\bP\s*0*(\d{1,4})\s*(?:-|–|—|\.{2,}|\u2026|do|to)\s*P?\s*0*(\d{1,4})\b/gi;
  while ((m = rePlainPRange.exec(raw)) !== null) {
    const a = intFromMaybe(m[1]);
    const b = intFromMaybe(m[2]);
    if (a === null || b === null) continue;
    hadExplicit = true;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) requested.add(i);
  }

  const rePlainP = /\bP\s*0*(\d{1,4})\b/gi;
  while ((m = rePlainP.exec(raw)) !== null) {
    const n = intFromMaybe(m[1]);
    if (n !== null && n >= 1) {
      requested.add(n);
      hadExplicit = true;
    }
  }

  // Ordinals in Polish/English, e.g. "pierwszy akapit", "first paragraph".
  // Only treat them as paragraph references when they appear next to a paragraph keyword.
  const ordinalToNumber = (w) => {
    const s = String(w || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
    if (!s) return null;
    // English
    if (s === 'first') return 1;
    if (s === 'second') return 2;
    if (s === 'third') return 3;
    if (s === 'fourth') return 4;
    if (s === 'fifth') return 5;
    if (s === 'sixth') return 6;
    if (s === 'seventh') return 7;
    if (s === 'eighth') return 8;
    if (s === 'ninth') return 9;
    if (s === 'tenth') return 10;
    // Polish stems
    if (s.startsWith('pierwsz')) return 1;
    if (s.startsWith('drug')) return 2;
    if (s.startsWith('trzec')) return 3;
    if (s.startsWith('czwart')) return 4;
    if (s.startsWith('piat')) return 5;
    if (s.startsWith('szost')) return 6;
    if (s.startsWith('siodm')) return 7;
    if (s.startsWith('osm')) return 8;
    if (s.startsWith('dziewiat')) return 9;
    if (s.startsWith('dziesiat')) return 10;
    if (s.startsWith('jedenast')) return 11;
    if (s.startsWith('dwunast')) return 12;
    if (s.startsWith('trzynast')) return 13;
    if (s.startsWith('czternast')) return 14;
    if (s.startsWith('piatnast')) return 15;
    if (s.startsWith('szesnast')) return 16;
    if (s.startsWith('siedemnast')) return 17;
    if (s.startsWith('osiemnast')) return 18;
    if (s.startsWith('dziewietnast')) return 19;
    if (s.startsWith('dwudziest')) return 20;
    return null;
  };

  // We run ordinal parsing on normalized prompt for diacritics-tolerant matching.
  const kw = '(?:paragraf(?:ach|y|ie|u|ow|em|ami)?|akapit(?:ach|y|ie|u|ow|em|ami)?|ustep(?:ach|y|ie|u|ow|em|ami)?|section|paragraph|para)';
  const ord = '(?:pierwsz\\w*|drug\\w*|trzec\\w*|czwart\\w*|piat\\w*|szost\\w*|siodm\\w*|osm\\w*|dziewiat\\w*|dziesiat\\w*|jedenast\\w*|dwunast\\w*|trzynast\\w*|czternast\\w*|piatnast\\w*|szesnast\\w*|siedemnast\\w*|osiemnast\\w*|dziewietnast\\w*|dwudziest\\w*|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)';

  const reOrdBefore = new RegExp(`\\b(${ord})\\b\\s+(?:\\w+\\s+){0,2}?(${kw})\\b`, 'gi');
  while ((m = reOrdBefore.exec(pNorm)) !== null) {
    const n = ordinalToNumber(m[1]);
    if (n != null) {
      requested.add(n);
      hadOrdinal = true;
    }
  }
  const reOrdAfter = new RegExp(`\\b(${kw})\\b\\s*(?:nr\\.?\\s*)?(${ord})\\b`, 'gi');
  while ((m = reOrdAfter.exec(pNorm)) !== null) {
    const n = ordinalToNumber(m[2]);
    if (n != null) {
      requested.add(n);
      hadOrdinal = true;
    }
  }

  // Natural language: paragraf/akapit/ustęp/paragraph/section + number or range
  const reWord = /\b(?:paragraf(?:ach|y|ie|u|ów|em|ami)?|akapit(?:ach|y|ie|u|ów|em|ami)?|ust[eę]p(?:ach|y|ie|u|ów|em|ami)?|section|paragraph|para)\b\s*(?:nr\.?\s*)?(?:od\s*)?(\d{1,4})(?:\s*(?:-|–|—|do|to|aż)\s*(\d{1,4}))?/gi;
  while ((m = reWord.exec(p)) !== null) {
    const a = intFromMaybe(m[1]);
    const b = intFromMaybe(m[2]);
    if (a === null) continue;

    hadExplicit = true;

    if (b !== null) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let i = lo; i <= hi; i++) requested.add(i);
    } else {
      requested.add(a);
    }
  }

  // Ranges like: "paragrafach od 4 do 9" / "akapity od 4 do 9" / "paragraphs from 4 to 9"
  // (supports a small amount of non-digit noise between the keyword and "od/from").
  const reKwRange = new RegExp(
    `\\b(?:paragraf(?:y|u|ach|ow|em)?|akapit(?:y|u|ach|ow|em)?|paragraph(?:s)?)\\b[^\\d]{0,20}(?:od|from)\\s*(\\d{1,4})\\s*(?:do|to)\\s*(\\d{1,4})`,
    'gi'
  );
  while ((m = reKwRange.exec(pNorm)) !== null) {
    const a = intFromMaybe(m[1]);
    const b = intFromMaybe(m[2]);
    if (a === null || b === null) continue;
    hadExplicit = true;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) requested.add(i);
  }

  const requestedArr = Array.from(requested).filter((n) => n >= 1).sort((a, b) => a - b);
  // IMPORTANT: do NOT auto-expand by neighbouring paragraphs.
  // If user asks for a single paragraph, we return ONLY that paragraph.
  // If user asks for a range/list, we return EXACTLY that range/list.
  // We keep the "expanded" field for backward-compatibility, but it is identical to requested.
  const expandedArr = requestedArr.slice();
  return {
    requested: requestedArr,
    expanded: expandedArr,
    hasConstraint: requestedArr.length > 0,
    hadExplicit,
    hadOrdinal,
  };
}

function intFromMaybe(v) {
  if (v === undefined || v === null) return null;
  const n = Number.parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function extractParagraphNumbersFromText(text) {
  const t = String(text || '');
  const out = new Set();
  const re = /\[P\s*(\d{1,4})\]/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    const n = intFromMaybe(m[1]);
    if (n !== null && n >= 1) out.add(n);
  }
  return out;
}

/**
 * Normalize the "paragraph/akapit" selection.
 *
 * We support two internal shapes for backward compatibility:
 * - Set<number> (current)
 * - { requested?: number[], expanded?: number[] } (legacy / future)
 */
function normalizeParagraphSelection(paragraphsLike) {
  if (!paragraphsLike) return null;
  if (paragraphsLike instanceof Set) return paragraphsLike;

  // Legacy object form
  if (typeof paragraphsLike === 'object') {
    const expanded = Array.isArray(paragraphsLike.expanded)
      ? paragraphsLike.expanded
      : Array.isArray(paragraphsLike.requested)
        ? paragraphsLike.requested
        : null;
    if (expanded) {
      const s = new Set();
      for (const n of expanded) {
        const nn = intFromMaybe(n);
        if (nn !== null && nn >= 1) s.add(nn);
      }
      return s.size ? s : null;
    }
  }

  // Single number
  const one = intFromMaybe(paragraphsLike);
  if (one !== null && one >= 1) return new Set([one]);

  return null;
}

function countParagraphHits(text, allowedSet) {
  if (!allowedSet || allowedSet.size === 0) return 0;
  const nums = extractParagraphNumbersFromText(text);
  let hits = 0;
  for (const n of nums) {
    if (allowedSet.has(n)) hits += 1;
  }
  return hits;
}

/**
 * Keep only the paragraphs (and their following lines) whose [Pxxx] id is in allowedSet.
 * A paragraph span is defined as: from its [Pxxx] tag up to (but excluding) the next [Pyyy] tag.
 */
function filterTextToParagraphs(text, allowedSet) {
  if (!allowedSet || allowedSet.size === 0) return String(text || '');
  const t = String(text || '');
  if (!t) return '';

  const re = /\[P\s*(\d{1,4})\]/gi;
  const matches = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const n = intFromMaybe(m[1]);
    if (n !== null) matches.push({ idx: m.index, n });
  }

  if (matches.length === 0) return '';

  const parts = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].idx;
    const end = i + 1 < matches.length ? matches[i + 1].idx : t.length;
    if (allowedSet.has(matches[i].n)) {
      parts.push(t.slice(start, end).trimEnd());
    }
  }

  return parts.join('\n').trim();
}

function padParagraphNumber(n) {
  const nn = intFromMaybe(n);
  if (nn === null) return null;
  return String(nn).padStart(3, '0');
}

/**
 * Extract a full paragraph block for a given paragraph number N.
 * A block is defined as: from its [Pxxx] tag up to (but excluding) the next [Pyyy] tag.
 * Returns null when not found.
 */
function extractParagraphBlock(text, n) {
  const t = String(text || '');
  if (!t) return null;

  const target = intFromMaybe(n);
  if (target === null || target < 1) return null;

  const re = /\[P\s*(\d{1,4})\]/gi;
  const matches = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const num = intFromMaybe(m[1]);
    if (num !== null) matches.push({ idx: m.index, n: num });
  }
  if (!matches.length) return null;

  for (let i = 0; i < matches.length; i++) {
    if (matches[i].n !== target) continue;
    const start = matches[i].idx;
    const end = i + 1 < matches.length ? matches[i + 1].idx : t.length;
    const block = t.slice(start, end).trimEnd();
    return block.trim() ? block.trim() : null;
  }

  return null;
}

function deterministicSelectParagraphEvidenceFromChunks(allChunks, paragraphs, { maxItemsTotal } = {}) {
  const list = Array.isArray(allChunks) ? allChunks : [];

  const requested = Array.isArray(paragraphs) ? paragraphs : [];
  const requestedOrdered = requested
    .map((x) => intFromMaybe(x))
    .filter((n) => n !== null && n >= 1)
    .sort((a, b) => a - b);

  if (!requestedOrdered.length || !list.length) {
    return { items: [], focusChunkIds: [], byChunk: {} };
  }

  // Allow returning all explicitly requested paragraphs (ignore small defaults like 10).
  const desired = requestedOrdered.length;
  const cap = Number.isFinite(maxItemsTotal)
    ? Math.max(maxItemsTotal, desired)
    : Math.min(desired, DEFAULT_MAX_ITEMS_TOTAL_PARAGRAPHS);
  const totalMax = clamp(cap, 1, DEFAULT_MAX_ITEMS_TOTAL_PARAGRAPHS);

  const byChunk = {};
  for (const c of list) {
    const cid = String(c?.id || '');
    if (!cid) continue;
    byChunk[cid] = { relevant: false, chosen: [] };
  }

  // For each requested paragraph number, pick the best (longest) occurrence across all chunks.
  const focusChunkIds = [];
  const items = [];

  for (const n of requestedOrdered) {
    if (items.length >= totalMax) break;

    let best = null;

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const chunkId = String(c?.id || '');
      if (!chunkId) continue;

      const block = extractParagraphBlock(c?.text, n);
      if (!block) continue;

      if (!best || block.length > best.block.length) {
        best = { chunkId, block };
      }
    }

    if (!best) continue;

    const pad = padParagraphNumber(n);
    const pid = pad ? `P${pad}` : `P${n}`;
    const evidId = `evidence#${pid}`;

    items.push({ id: evidId, chunk_id: best.chunkId, quote: best.block });

    if (!byChunk[best.chunkId]) byChunk[best.chunkId] = { relevant: false, chosen: [] };
    byChunk[best.chunkId].relevant = true;
    byChunk[best.chunkId].chosen.push(pid);
    if (!focusChunkIds.includes(best.chunkId)) focusChunkIds.push(best.chunkId);
  }

  // Stable order: P001, P002, ...
  items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { items, focusChunkIds, byChunk };
}


function parseRankLimitFromPrompt(userPrompt) {
  const raw = String(userPrompt || '');
  if (!raw.trim()) return null;

  const pNorm = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

  // Typical ranking markers: "top 5", "top5", "top-10", "pierwsze 3", "first 10", "najlepsze 5"
  const patterns = [
    /\btop\s*[-–—]?\s*(\d{1,3})\b/i,
    /\btop(\d{1,3})\b/i,
    /\bfirst\s*(\d{1,3})\b/i,
    /\b(pierwsze|pierwszych)\s*(\d{1,3})\b/i,
    /\b(\d{1,3})\s*(najlepszych|najlepsze|najdrozszych|najtanszych|najtańszych)\b/i,
    /\b(najlepszych|najlepsze|najdrozszych|najtanszych|najtańszych)\s*(\d{1,3})\b/i,
    /\btop\s*(\d{1,3})\s*(wynikow|wyniki|produktow|produkty|ofert|pozycji|pozycje)\b/i,
  ];

  for (const re of patterns) {
    const m = re.exec(pNorm);
    if (!m) continue;
    const numStr = m[1] && /^\d/.test(m[1]) ? m[1] : m[2];
    const n = intFromMaybe(numStr);
    if (n !== null) return clamp(n, 1, 200);
  }

  return null;
}


function detectPromptIntents(userPrompt) {
  const p = (userPrompt || '').toLowerCase();

  // IMPORTANT: treat "nowa opinia/recenzja" as reviews intent, not "new item" list intent.
  const hasReviewIntent =
  /\b(?:opini\w*|recenz\w*|ocen\w*|gwiazd\w*|review\w*|rating\w*|★|\d+(?:[.,]\d+)?\/(?:5|10))\b/i
    .test(p);


  const rankLimit = parseRankLimitFromPrompt(userPrompt);

  // Ranking/list intent (top-N, positions, best-sellers etc.).
  // This powers deterministic extraction; be permissive to avoid missing obvious "top-10" prompts.
  const wantsRanking = (
    // explicit ranking words
    /\b(ranking|rank|pozycj|position|top|najlepsze|najlepszy|best|bestseller|best\s*sellers)\b/.test(p) &&
    /\b(lista|pozycj|ofert|produkt|produkty|wynik|wyniki|item|items|product|products)\b/.test(p)
  ) || (
    // implicit: user specifies a top-N limit
    rankLimit != null && /\b(top|pozycj|position|rank|ranking|najlepsze|best)\b/.test(p)
  );

  const wants = {
    // Accept Polish inflections: cena/ceny/cenie/cenę etc.
    price: /\b(cen\w*|price|koszt\w*|pln|zł|zl|€|\$)\b/.test(p),
    reviews: hasReviewIntent,
    first_paragraph: /\b(pierwszy\s+akapit|1\.?\s+akapit|first\s+paragraph)\b/.test(p),
    list_items: /\b(lista|pozycj|elementy\s+listy|produkty|wyniki|katalog|asortyment)\b/.test(p),
    only: /\b(tylko|only)\b/.test(p),

    // Allow "title only" style prompts.
    title_only: /\b(tytuł|tytul|title)\b/.test(p) && /\b(tylko|only)\b/.test(p),

    // "new item" is for new results/products/posts etc. Exclude review-only phrasing.
    new_item: /(pojawi|pojaw(?:i|ię)|pojawic|nowy|nowa|nowe|dodaj|dodane|dodany|added|new|appear|appears)\b/.test(p) && !hasReviewIntent,

    // Ranking intent is explicit.
    ranking: wantsRanking,

    // Optional: hints for focused extraction
    color_or_category: /(kolor|color|kategoria|category)/.test(p),
    headline: /(nagł|naglo|headline|tytuł|tytul|title|podtytuł|podtytul|subheadline)/.test(p),
    news_list: /\b(artykul|artykuł|artykuly|artykuły|wiadomosc|wiadomość|wiadomosci|wiadomości|news|wpis|wpisy|entry|entries|ogloszenie|ogłoszenie|ogloszenia|ogłoszenia|pozycja|pozycje)\b/.test(p),
  };

  const exclude = {
    price: /(ignoruj|ignore).{0,30}(cen|price)|bez\s+ceny|nie.{0,25}(cena|price)/.test(p),
    delivery: /(ignoruj|ignore).{0,30}(dostaw|delivery|wysył|wysyl)/.test(p),
  };
  const paragraphs = parseParagraphSelectionFromPrompt(userPrompt);

  return { wants, exclude, rankLimit, paragraphs };
}

  // --- LLM router: classify prompt into labels (multi-label) ---
  // Labels are English constants to keep them stable across languages.
  // When router returns no labels, we DO NOT run deterministic shortcuts (ranking/new-item/list),
  // and we fall back to classic LLM evidence selection.
  const ROUTER_LABELS = [
    'ITEM_LIST',          // user wants full list / all items / all variants
    'RANKING',            // top-N / ranking / sorted list
    'LIST',               // alias / future-proof (some models output a generic "LIST")
    'PRICE',              // price as a field (not necessarily diff)
    'REVIEWS',            // rating / reviews / stars
    'TITLE_ONLY',         // title only
    'FIRST_PARAGRAPH',    // first paragraph only
    'PARAGRAPHS',         // user asks to monitor specific paragraph(s) / akapit(s) by number or [Pxxx]
    'SUMMARY',            // summary / overview
    'DIFF_MODE',          // user asks "what changed" / "what's new" / baseline compare
    'PRICE_CHANGE_MODE',  // user asks "did it get cheaper/more expensive" (implies diff)
    'UNKNOWN',
  ];

  const ROUTER_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['labels'],
    properties: {
      labels: {
        type: 'array',
        maxItems: 10,
        items: { type: 'string', enum: ROUTER_LABELS },
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  };

  function uniqOrdered(arr) {
    const out = [];
    const seen = new Set();
    for (const x of Array.isArray(arr) ? arr : []) {
      const s = String(x || '').trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  async function routePromptLabelsLLM(prompt, { model, timeoutMs, trace } = {}) {
    const p = String(prompt || '').trim();
    if (!p) return { ok: true, labels: [], confidence: 0 };

    const system = `Jesteś routerem intencji dla systemu wyciągania EVIDENCE.
Masz przeczytać prompt użytkownika i zwrócić listę ETYKIET (multi-label), które NAJLEPIEJ opisują intencję.

Zasady:
- Zwracaj tylko etykiety z listy ROUTER_LABELS.
- Jeśli nie masz pewności, zwróć [] (pustą listę) lub ["UNKNOWN"].
- Nie tłumacz, nie komentuj, nie dodawaj tekstu poza JSON.
- Etykiety DIFF_MODE oraz PRICE_CHANGE_MODE dotyczą porównania między snapshotami (użytkownik pyta "co się zmieniło", "czy potaniało" itp.).

Przykłady:
- "Wypisz wszystkie smaki i ceny" -> ["ITEM_LIST","PRICE"]
- "Top 5 najtańszych" -> ["RANKING","PRICE"]
- "Detect any change in the top-10 items and their ranks" -> ["RANKING"]
- "Wykryj zmiany w TOP-10 produktach i ich pozycjach" -> ["RANKING"]
- "Co nowego doszło na liście i czy coś potaniało?" -> ["ITEM_LIST","PRICE_CHANGE_MODE"]
- "Jaka ocena i ile opinii?" -> ["REVIEWS"]
- "Streść stronę" -> ["SUMMARY"]
- "Podaj tylko tytuł" -> ["TITLE_ONLY"]
- "Monitoruj paragrafy od 1 do 3" -> ["PARAGRAPHS"]
- Niejasne -> []`;

    try {
      const resp = await generateTextWithOllama({
        model,
        system,
        prompt: JSON.stringify({ userPrompt: p }),
        format: ROUTER_SCHEMA,
        temperature: 0,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_LLM_ROUTER_TIMEOUT_MS,
        logger: trace?.logger,
        label: trace?.label ? `${trace.label}:evidence_router` : 'evidence_router',
      });

      if (!resp?.ok) throw new Error(resp?.error || 'ollama_failed');

      const parsed = resp?.json || {};
      const labelsRaw = Array.isArray(parsed.labels) ? parsed.labels : [];
      let labels = uniqOrdered(labelsRaw).filter((x) => ROUTER_LABELS.includes(x));

      // Normalize UNKNOWN handling: treat it as no labels (so we fallback to LLM evidence selection).
      labels = labels.filter((x) => x !== 'UNKNOWN');

      const confidence = Number.isFinite(parsed.confidence) ? parsed.confidence : undefined;
      return { ok: true, labels, confidence };
    } catch (e) {
      return { ok: false, labels: [], error: String(e?.message || e) };
    }
  }

  function applyRouterLabelsToIntents(intents, labels) {
    if (!intents || typeof intents !== 'object') return intents;
    if (!intents.wants || typeof intents.wants !== 'object') intents.wants = {};

    const set = new Set(Array.isArray(labels) ? labels : []);

    if (set.has('ITEM_LIST')) intents.wants.list_items = true;
    if (set.has('RANKING')) intents.wants.ranking = true;
    if (set.has('PRICE')) intents.wants.price = true;
    if (set.has('REVIEWS')) intents.wants.reviews = true;
    if (set.has('TITLE_ONLY')) {
      intents.wants.title_only = true;
      intents.wants.only = true;
    }
    if (set.has('FIRST_PARAGRAPH')) intents.wants.first_paragraph = true;
    if (set.has('PARAGRAPHS')) intents.wants.paragraphs = true;

    // Diff-oriented modes: we want a broad pool of list rows so the judge can compare snapshots.
    if (set.has('DIFF_MODE') || set.has('PRICE_CHANGE_MODE')) {
      intents.wants.new_item = true;
      intents.wants.list_items = true; // extract list rows with details
      intents.wants.price = intents.wants.price || set.has('PRICE_CHANGE_MODE');
    }

    // Attach for debugging (harmless extra field).
    intents.router = { labels: Array.from(set) };
    return intents;
  }

function countMatches(text, re) {
  if (!text) return 0;
  re.lastIndex = 0;
  let n = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    n++;
    if (m.index === re.lastIndex) re.lastIndex++;
    if (n > 999) break;
  }
  return n;
}

function countRankLinesUpTo(text, rankLimit) {
  const limit = Number.isFinite(rankLimit) ? rankLimit : 10;
  const t = String(text || '');
  if (!t) return 0;
  const re = /(?:^|\n)\s*-\s*#\s*(\d{1,3})\b/g;
  let n = 0;
  let m;
  while ((m = re.exec(t)) !== null) {
    const r = Number.parseInt(m[1], 10);
    if (Number.isFinite(r) && r > 0 && r <= limit) n++;
    if (m.index === re.lastIndex) re.lastIndex++;
    if (n > 999) break;
  }
  return n;
}

function buildRankCandidatesFromText(text, chunkId, { rankLimit, maxCandidates, maxLen } = {}) {
  const limit = Number.isFinite(rankLimit) ? rankLimit : 10;
  const maxC = Math.max(1, Number.isFinite(maxCandidates) ? maxCandidates : DEFAULT_MAX_CANDIDATES_PER_CHUNK);
  const maxQ = Math.max(40, Number.isFinite(maxLen) ? maxLen : DEFAULT_MAX_QUOTE_LEN);

  const t = String(text || '');
  if (!t) return [];

  // Find all rank starts.
  // IMPORTANT: don't rely only on (?:^|\n) because some chunkers/wrappers can place "- #11" after
  // whitespace without a newline. We accept starts where the '-' is at beginning OR preceded by whitespace.
  const re = /-\s*#\s*(\d{1,3})\b/g;
  const starts = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const rank = Number.parseInt(m[1], 10);
    const start = m.index;
    const prev = start > 0 ? t[start - 1] : '';
    if (start === 0 || prev === '\n' || prev === '\r' || /\s/.test(prev)) {
      starts.push({ rank, start });
    }
    if (m.index === re.lastIndex) re.lastIndex++;
    if (starts.length > 2000) break;
  }
  if (!starts.length) return [];

  const out = [];
  const seen = new Set();
  let idx = 0;

  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i];
    const nextStart = i + 1 < starts.length ? starts[i + 1].start : t.length;
    const quoteRaw = t.slice(cur.start, nextStart).trim();
    if (!quoteRaw) continue;

    if (Number.isFinite(cur.rank) && cur.rank > 0 && cur.rank <= limit) {
      const quote = quoteRaw.length > maxQ ? quoteRaw.slice(0, maxQ).trim() : quoteRaw;
      pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, quote, 'rank_item', { rank: cur.rank });
      if (out.length >= maxC) break;
    }
  }

  return out;
}

// Common patterns
const RE_RATING_FRAC = /\b\d{1,2}(?:[.,]\d{1,2})?\s*\/\s*(?:5|10)\b/g;
const RE_RATING_STARS_NUM = /\b\d{1,2}(?:[.,]\d{1,2})?\s*[★☆]{1,6}\b/g;
const RE_STARS = /[★☆]{3,}/g;
const RE_PERCENT = /\b\d{1,3}(?:[.,]\d{1,2})?\s*%/g;
const RE_REVIEW_COUNT = /\b\d+\s*(?:opin|opini|ocen|oceny|review|reviews|recenz|rating|ratings)\w*/gi;

const RE_CURRENCY = /\b\d{1,3}(?:[ .]\d{3})*(?:[.,]\d{2})?\s*(?:zł|zl|pln|€|eur|usd|\$)\b/gi;
const RE_AVAIL = /\b(?:w\s*tej\s*chwili\s*nie\s*mamy|brak|niedost[eę]pn\w*|out\s*of\s*stock|sold\s*out|unavailable|in\s*stock|available|dost[eę]pn\w*)\b/gi;
const RE_DELIVERY = /\b(?:dostaw\w*|wysył\w*|wysyl\w*|delivery|shipping|ship(?:ping)?|kurier|odbi[oó]r\w*|pickup)\b/gi;
const RE_DATE = /\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/g;
const RE_COUNT_RESULTS = /\b\d{1,3}(?:[ .]\d{3})*\s*(?:wynik\w*|ofert\w*|produkt\w*|items?|results?|listing\w*)\b/gi;

function scoreChunkForEvidence(text, { promptKeywords, intents }) {
  const t = String(text || '');
  if (!t) return 0;
  const lower = t.toLowerCase();

  let score = 0;

  // Keyword overlap is a strong signal of prompt relevance.
  for (const kw of promptKeywords || []) {
    if (!kw) continue;
    if (lower.includes(kw)) score += 3;
  }

  // Intent-specific signals
  if (intents?.wants?.reviews) {
    score += countMatches(t, RE_RATING_FRAC) * 9;
    score += countMatches(t, RE_RATING_STARS_NUM) * 7;
    score += countMatches(t, RE_STARS) * 6;
    score += countMatches(t, RE_REVIEW_COUNT) * 6;
    score += countMatches(lower, /(opin|recenz|review|rating|ocen|gwiazd)/g) * 2;
  }

  if (intents?.wants?.price && !intents?.exclude?.price) {
    score += countMatches(t, RE_CURRENCY) * 8;
    score += countMatches(t, RE_PERCENT) * 2; // promotions often include %
  }

  if (intents?.wants?.availability) {
    score += countMatches(t, RE_AVAIL) * 7;
  }

  if (intents?.wants?.delivery && !intents?.exclude?.delivery) {
    score += countMatches(t, RE_DELIVERY) * 4;
    score += countMatches(t, RE_DATE) * 3;
  }

  if (intents?.wants?.count) {
    score += countMatches(t, RE_COUNT_RESULTS) * 6;
  }

  if (intents?.wants?.filters) {
    score += countMatches(lower, /(filtr|marka:|brand:|rozmiar|size|kolor|color|kategoria|category)/g) * 3;
  }

  if (intents?.wants?.ranking) {
    const limit = Number.isFinite(intents?.rankLimit) ? intents.rankLimit : 10;
    const topRanks = countRankLinesUpTo(t, limit);
    // Ranking lines are the strongest signal for "top-N / ranks" prompts.
    score += topRanks * 28;
    // Any rank lines still matter (even if >limit).
    score += countMatches(t, /(?:^|\n)\s*-\s*#\s*\d{1,3}\b/g) * 6;
  }

  if (intents?.wants?.list_items && !intents?.wants?.ranking) {
    // bullets/numbered lines hint: list pages, rankings, etc.
    score += countMatches(t, /(^|\n)\s*(?:[-•]|(?:\d{1,3}[.)]))\s+/g) * 2;
  }

  if (intents?.wants?.new_item && !intents?.wants?.ranking) {
    // New/added-item prompts typically need broad coverage of list rows.
    score += countMatches(t, /(^|\n)\s*[-•]\s+/g) * 3;
    score += countMatches(t, RE_CURRENCY) * 2;
  }

  // Tiny bump for very short chunks if headline is requested (often first lines).
  if (intents?.wants?.headline && t.length < 800) score += 2;

  return score;
}

function selectChunksForEvidence(allChunks, { maxChunks, promptKeywords, intents }) {
  let list = Array.isArray(allChunks) ? allChunks.slice() : [];
  const k = Math.max(1, Number.isFinite(maxChunks) ? maxChunks : DEFAULT_MAX_CHUNKS);

  // If the user explicitly asked for paragraph(s)/akapit(s), prefer chunks containing
  // those paragraph markers (P###). This selection is deterministic (regex), not LLM.
  const wanted = normalizeParagraphSelection(intents?.paragraphs);
  if (wanted && wanted.size > 0 && list.length > 0) {

    const scoredByParas = list
      .map((c, idx) => {
        const text = String(c?.text || '');
        const paras = extractParagraphNumbersFromText(text);
        let hits = 0;
        for (const p of paras) if (wanted.has(p)) hits += 1;
        const order = Number.isFinite(c?.order) ? c.order : idx;
        return { c, idx, order, paras, hits };
      })
      .filter((x) => x.hits > 0);

    if (scoredByParas.length > 0) {
      // Keep original order, but try to cover as many requested paragraphs as possible.
      scoredByParas.sort((a, b) => a.order - b.order);

      const chosen = [];
      const covered = new Set();
      const coversAll = () => covered.size >= wanted.size;

      for (const item of scoredByParas) {
        if (chosen.length >= k) break;

        let addsCoverage = false;
        for (const p of item.paras) {
          if (wanted.has(p) && !covered.has(p)) {
            addsCoverage = true;
            break;
          }
        }

        if (addsCoverage || chosen.length === 0) {
          chosen.push(item);
          for (const p of item.paras) if (wanted.has(p)) covered.add(p);
          if (coversAll()) break;
        }
      }

      // If we still have room, fill with remaining paragraph-hit chunks by hit count.
      if (chosen.length < k) {
        const chosenIds = new Set(chosen.map((x) => x.c?.id));
        const remaining = scoredByParas.filter((x) => !chosenIds.has(x.c?.id));
        remaining.sort((a, b) => b.hits - a.hits || a.order - b.order);
        for (const item of remaining) {
          if (chosen.length >= k) break;
          chosen.push(item);
        }
        chosen.sort((a, b) => a.order - b.order);
      }

      list = chosen.map((x) => x.c);
    }
  }

  // Ranking mode: keep list rows that look like a rank/# list.
  if (intents?.wants?.ranking) {
    const limit = Number.isFinite(intents?.rankLimit) ? intents.rankLimit : 10;
    const ranked = list.filter((c) => countRankLinesUpTo(String(c?.text || ''), limit) > 0);
    if (ranked.length) {
      ranked.sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0));
      return ranked.slice(0, Math.min(k, ranked.length));
    }
  }

  if (list.length <= k) return list;

  const scored = list.map((c, idx) => {
    const text = String(c?.text || '');
    const score = scoreChunkForEvidence(text, { promptKeywords, intents });
    const order = Number.isFinite(c?.order) ? c.order : idx;
    return { c, idx, order, score };
  });

  const maxScore = scored.reduce((m, x) => Math.max(m, x.score), 0);
  if (!maxScore) {
    // No signals anywhere: keep the first N like before.
    return list.slice(0, k);
  }

  // pick top-k by score, then re-sort by original order for readability/stability
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.order - b.order;
  });

  const picked = scored.slice(0, k).map((x) => x.c);
  picked.sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0));
  return picked;
}


function deterministicSelectRankingEvidence(chunksWithCandidates, { intents, maxItemsTotal } = {}) {
  const limit = clamp(Number.isFinite(intents?.rankLimit) ? intents.rankLimit : 10, 1, 50);
  const totalMaxRaw = Number.isFinite(maxItemsTotal) ? maxItemsTotal : Math.min(limit, DEFAULT_MAX_ITEMS_TOTAL_RANKING);
  const totalMax = clamp(totalMaxRaw, 1, DEFAULT_MAX_ITEMS_TOTAL_RANKING);

  const pool = [];
  for (const c of chunksWithCandidates || []) {
    for (const cand of c.candidates || []) {
      if (cand.kind !== 'rank_item') continue;
      const r = Number.isFinite(cand.rank) ? cand.rank : null;
      if (!r || r < 1 || r > limit) continue;
      pool.push({
        chunkId: c.id,
        order: Number.isFinite(c.order) ? c.order : 0,
        candId: cand.id,
        quote: cand.quote,
        rank: r,
      });
    }
  }

  // Sort by rank, then by chunk order for stability.
  pool.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.order - b.order));

  const byChunk = {};
  for (const c of chunksWithCandidates || []) byChunk[c.id] = { relevant: false, chosen: [] };

  const focusChunkIds = [];
  const items = [];
  const seenRanks = new Set();

  for (const it of pool) {
    if (items.length >= totalMax) break;
    if (seenRanks.has(it.rank)) continue;
    seenRanks.add(it.rank);

    if (!byChunk[it.chunkId]) byChunk[it.chunkId] = { relevant: false, chosen: [] };
    byChunk[it.chunkId].relevant = true;
    byChunk[it.chunkId].chosen.push(it.candId);

    if (!focusChunkIds.includes(it.chunkId)) focusChunkIds.push(it.chunkId);

    items.push({ id: `evidence#${it.candId}`, chunk_id: it.chunkId, quote: it.quote });
  }

  // Ensure deterministic order: already rank-sorted.
  return { items, focusChunkIds, byChunk, llmFailed: false };
}


function deterministicSelectReviewsEvidence(chunksWithCandidates, { intents, maxItemsTotal } = {}) {
  const totalMaxRaw = Number.isFinite(maxItemsTotal) ? maxItemsTotal : DEFAULT_MAX_ITEMS_TOTAL_REVIEWS;
  const totalMax = clamp(totalMaxRaw, 2, DEFAULT_MAX_ITEMS_TOTAL_REVIEWS);

  // Prioritize: rating (fraction), rating (num stars), counts mentioning reviews/ratings, generic stars.
  const pool = [];
  const reReviewKw = /\b(ocen|ocena|opin|opini|recenz|review|rating|gwiazd|gwiazdk)\b/i;

  for (const c of chunksWithCandidates || []) {
    for (const cand of c.candidates || []) {
      const kind = cand.kind;
      if (kind === 'rating_frac') {
        pool.push({ chunkId: c.id, order: c.order || 0, candId: cand.id, quote: cand.quote, pr: 1 });
      } else if (kind === 'rating_num_stars') {
        pool.push({ chunkId: c.id, order: c.order || 0, candId: cand.id, quote: cand.quote, pr: 2 });
      } else if (kind === 'count_with_keyword' && reReviewKw.test(String(cand.quote || ''))) {
        pool.push({ chunkId: c.id, order: c.order || 0, candId: cand.id, quote: cand.quote, pr: 3 });
      } else if (kind === 'stars') {
        pool.push({ chunkId: c.id, order: c.order || 0, candId: cand.id, quote: cand.quote, pr: 4 });
      }
    }
  }

  // Stable order: priority, then chunk order, then shorter quotes first (less OCR noise).
  pool.sort((a, b) => (a.pr !== b.pr ? a.pr - b.pr : a.order !== b.order ? a.order - b.order : a.quote.length - b.quote.length));

  const byChunk = {};
  for (const c of chunksWithCandidates || []) byChunk[c.id] = { relevant: false, chosen: [] };

  const focusChunkIds = [];
  const items = [];
  const seen = new Set();

  for (const it of pool) {
    if (items.length >= totalMax) break;
    const key = String(it.quote || '').trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!byChunk[it.chunkId]) byChunk[it.chunkId] = { relevant: false, chosen: [] };
    byChunk[it.chunkId].relevant = true;
    byChunk[it.chunkId].chosen.push(it.candId);

    if (!focusChunkIds.includes(it.chunkId)) focusChunkIds.push(it.chunkId);
    items.push({ id: `evidence#${it.candId}`, chunk_id: it.chunkId, quote: it.quote });
  }

  // If we still got nothing (rare OCR weirdness), fall back to generic deterministic selection.
  if (!items.length) {
    return fallbackSelectCandidatesDeterministic(chunksWithCandidates, {
      intents: intents || { wants: { reviews: true } },
      maxItemsTotal: totalMax,
      maxQuotesPerChunk: 6,
    });
  }

  return { items, focusChunkIds, byChunk, llmFailed: false };
}


function buildCandidatesForChunk(chunkText, chunkId, opts = {}) {
  let text = String(chunkText || '');
  const maxCandidates = Number.isFinite(opts.maxCandidates)
    ? opts.maxCandidates
    : DEFAULT_MAX_CANDIDATES_PER_CHUNK;

  const userPrompt = String(opts.userPrompt || '');
  const userPromptLower = userPrompt.toLowerCase();
  const promptKeywords = Array.isArray(opts.promptKeywords) ? opts.promptKeywords : [];
  const intents = opts.intents || detectPromptIntents(userPrompt);
  const priceOnly = !!(intents?.wants?.price && intents?.wants?.only && !intents?.wants?.reviews);
  const wantsNewsList = !!intents?.wants?.news_list;

  // If the user asked for specific paragraph(s)/akapit(y), reduce noise by keeping
  // only those paragraph blocks (neighbor expansion handled in parsing).
  const allowedParagraphs = normalizeParagraphSelection(intents?.paragraphs);
  if (allowedParagraphs && allowedParagraphs.size > 0) {
    const filtered = filterTextToParagraphs(text, allowedParagraphs);
    // If a chunk doesn't contain any of the requested paragraphs, we produce no
    // candidates. This prevents the LLM from citing unrelated [Pxxx] blocks.
    if (!filtered.trim()) return [];
    text = filtered;
  }

  const maxLen = Number.isFinite(opts.maxQuoteChars) ? opts.maxQuoteChars : DEFAULT_MAX_QUOTE_LEN;

  // Ranking prompts: prefer exact "#N ..." entries (bounded by rankLimit).
  // This prevents picking navigation bullets (e.g. categories) as evidence.
  if (intents?.wants?.ranking) {
    const limit = Number.isFinite(intents?.rankLimit) ? intents.rankLimit : 10;
    const anyRankStarts = countMatches(text, /(?:^|\n)\s*-\s*#\s*\d{1,3}\b/g);

    const rankCands = buildRankCandidatesFromText(text, chunkId, {
      rankLimit: limit,
      maxCandidates,
      maxLen,
    });

    if (rankCands.length) return rankCands.slice(0, maxCandidates);

    // If the chunk contains ranks but only above the limit (e.g. #11+), keep it empty
    // so we don't accidentally pick prices/categories as "top-N" evidence.
    if (anyRankStarts > 0) return [];
  }

  const seen = new Set();
  const out = [];
  let idx = 0;

  // New-item prompts: prefer product/list rows and avoid navigation bullets.
  // We don't know (yet) what is NEW between snapshots, so we provide a broad, representative pool
  // of item lines so the judge can compare BEFORE vs AFTER.
    if (intents?.wants?.new_item && !intents?.wants?.ranking) {
    const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
    const newsSectionRe = /\b(?:najnowsze|najważniejsze|najwazniejsze|polska|swiat|świat|biznes|sport|kultura|technologia|tech|gospodarka|ekonomia|polityka|region|regionalne|opinie|zdrowie|moto|podróże|podroze|rozrywka)\b/i;
    const reRelTime = /\b\d+\s*(?:min(?:\.|ut(?:y|ę)?)|godz\.?|godzin(?:y)?|hours?|minutes?|mins?)\b(?:\s*(?:temu|ago))?\b/i;
    const reDateHint = /\b(?:dzisiaj|dziś|wczoraj|today|yesterday)\b/i;
    const reClock = /\b\d{1,2}:\d{2}\b/;
    const reDateNum = /\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/;

    // If the user provided specific entity keywords (e.g., a brand/product/person),
    // we require at least one of them to appear in the selected line.
    // For generic prompts like "pojawi się nowy artykuł/produkt/wpis", we DO NOT require keyword match,
    // otherwise we'd accidentally return 0 evidence on many pages.
    const rawKw = (promptKeywords || [])
      .map((x) => String(x || '').toLowerCase())
      .filter((x) => x.length >= 4);

    const GENERIC_NEW_ITEM_KW = new Set([
      'artykul', 'artykuł', 'artykuly', 'artykuły', 'wiadomosc', 'wiadomość', 'wiadomosci', 'wiadomości',
      'news', 'article', 'articles', 'post', 'posty', 'wpis', 'wpisy', 'entry', 'entries',
      'produkt', 'produkty', 'product', 'products', 'item', 'items', 'oferta', 'oferty', 'listing', 'listings',
      'pozycja', 'pozycje', 'element', 'elementy', 'lista', 'listy', 'strona', 'strony',
    ]);

    const entityKw = rawKw.filter(
      (x) =>
        !GENERIC_NEW_ITEM_KW.has(x) &&
        !/^(nowy|nowa|nowe|dodane|dodany|dodaj|pojawi|pojawic|pojaw|jezeli|jesli|jeśli|notify|new|added|add|appear|appears)$/.test(x)
    );
    const requireEntityMatch = entityKw.length > 0;

    const navRe = /^(?:filtry?\b|filtry?\s*\d+|marka:|brand:|kategoria\b|category\b|sortuj\b|sort\b|szukaj\b|search\b|menu\b|home\b|kontakt\b|help\b|about\b)/i;

    const cleanLineForMatch = (ln) => ln.replace(/^\[P\d+\]\s*/i, '').trim();

    for (const ln of lines) {
      if (out.length >= maxCandidates) break;
      const cleaned = cleanLineForMatch(ln);
      const isBullet = /^([-•]|(\d{1,3}[.)]))\s+/.test(cleaned);
      const noBullet = cleaned.replace(/^([-•]|(\d{1,3}[.)]))\s+/, '').trim();
      if (noBullet.length < 12) continue;
      if (navRe.test(noBullet)) continue;

      if (wantsNewsList) {
        const hasTimeOrDate = reRelTime.test(noBullet) || reDateHint.test(noBullet) || reClock.test(noBullet) || reDateNum.test(noBullet);
        const hasSection = newsSectionRe.test(noBullet);
        const isHeader =
          hasSection &&
          noBullet.length <= 40 &&
          !/[.!?]/.test(noBullet) &&
          !/\d/.test(noBullet);

        if (isHeader) {
          pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, ln.slice(0, maxLen), 'news_header');
          continue;
        }

        if (isBullet || hasTimeOrDate || hasSection) {
          pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, ln.slice(0, maxLen), 'news_line');
          continue;
        }
      }

      if (!isBullet) continue;

      const tokens = noBullet.split(/\s+/).filter(Boolean);
      const isShortCategory =
        tokens.length <= 2 &&
        noBullet.length < 18 &&
        !/\d/.test(noBullet) &&
        !/[.,;:()]/.test(noBullet);

      // Also skip very short ALL-CAPS nav labels (common on news / portals).
      const isAllCapsLabel =
        /^[A-ZĄĆĘŁŃÓŚŹŻ0-9\s-]{3,}$/.test(noBullet) &&
        tokens.length <= 5 &&
        !/[.,;:()]/.test(noBullet);

      if (isShortCategory || isAllCapsLabel) continue;

      const lower = noBullet.toLowerCase();

      // If the user specified entities, require at least one match.
      if (requireEntityMatch) {
        let ok = false;
        for (const kw of entityKw) {
          if (kw && lower.includes(kw)) {
            ok = true;
            break;
          }
        }
        if (!ok) continue;
      }

      const hasAnyTime = reRelTime.test(noBullet) || reDateHint.test(noBullet) || reClock.test(noBullet) || reDateNum.test(noBullet);
      const looksLikeProduct =
        /(\b\d+\s*(?:ml|g|l|kg)\b|\bpln\b|\bzł\b|\bzl\b|€|\$|\(|\)|,)/i.test(noBullet) ||
        /\b\d{3,}\b/.test(noBullet);

      const looksLikeRow =
        hasAnyTime ||
        looksLikeProduct ||
        noBullet.length >= 40 ||
        tokens.length >= 8 ||
        (tokens.length >= 6 && /[.!?"]/u.test(noBullet));

      // For generic new-item monitoring, we only keep list-like rows.
      if (!requireEntityMatch && !looksLikeRow) continue;

      // Keep verbatim substring.
      pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, ln.slice(0, maxLen), 'product_line');
    }

    // If we found nothing and prompt was generic, do a relaxed pass (still list-ish, still no nav).
    if (out.length === 0 && !requireEntityMatch) {
      for (const ln of lines) {
        if (out.length >= maxCandidates) break;
        const cleaned = cleanLineForMatch(ln);
        if (!/^([-•]|(\d{1,3}[.)]))\s+/.test(cleaned)) continue;

        const noBullet = cleaned.replace(/^([-•]|(\d{1,3}[.)]))\s+/, '').trim();
        if (noBullet.length < 20) continue;
        if (navRe.test(noBullet)) continue;

        const tokens = noBullet.split(/\s+/).filter(Boolean);
        if (tokens.length < 4) continue;

        pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, ln.slice(0, maxLen), 'product_line');
      }
    }

    // Add a brand/filter anchor if present (useful grounding for the judge).
    if (out.length < maxCandidates) {
      const anchor = lines.find((l) => /(?:^[-•]\s*)?(?:marka:|brand:)/i.test(l));
      if (anchor) {
        pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, anchor.slice(0, maxLen), 'brand_line');
      }
    }
  }

// List prompts: prefer product/list rows (with details) and avoid navigation bullets.
// This improves completeness for "wypisz wszystkie..." / "wszystkie smaki..." prompts.
if (intents?.wants?.list_items && !intents?.wants?.ranking && out.length < maxCandidates) {
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
  const navRe = /^(?:filtry?\b|filtry?\s*\d+|marka:|brand:|kategoria\b|category\b|sortuj\b|sort\b|szukaj\b|search\b|menu\b|home\b|kontakt\b|help\b|about\b)/i;

  for (const ln of lines) {
    if (out.length >= maxCandidates) break;
    if (!/^([-•]|(\d{1,3}[.)]))\s+/.test(ln)) continue;

    const noBullet = ln.replace(/^([-•]|(\d{1,3}[.)]))\s+/, '').trim();
    if (noBullet.length < 10) continue;
    if (navRe.test(noBullet)) continue;

    // Prefer rows that look like real items/variants (often contain size/currency/parentheses)
    const looksLikeRow =
      /(\b\d+\s*(ml|g|l|kg)\b|pln|\bzł\b|\bzl\b|€|\$|\(|\)|,)/i.test(noBullet) ||
      noBullet.length >= 22;

    if (!looksLikeRow) continue;

    // Keep the FULL line (verbatim).
    pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, ln.slice(0, maxLen), 'list_item');
  }

  // Add a brand/filter anchor if present (useful grounding for the judge).
  if (out.length < maxCandidates) {
    const anchor = lines.find((l) => /(?:^[-•]\s*)?(?:marka:|brand:)/i.test(l));
    if (anchor) {
      pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, anchor.slice(0, maxLen), 'brand_line');
    }
  }
}

  // --- Build prompt-adaptive pattern list (ordered by intent)
  /** @type {{kind:string, re:RegExp}[]} */
  const patterns = [];

  if (intents?.wants?.price && !intents?.exclude?.price) {
    patterns.push({ kind: 'price_currency', re: RE_CURRENCY });
    patterns.push({ kind: 'percent', re: RE_PERCENT }); // discounts
  }
  if (intents?.wants?.availability) {
    patterns.push({ kind: 'availability', re: RE_AVAIL });
  }
  if (intents?.wants?.delivery && !intents?.exclude?.delivery) {
    patterns.push({ kind: 'delivery_keyword', re: RE_DELIVERY });
    patterns.push({ kind: 'date', re: RE_DATE });
  }
  if (intents?.wants?.count) {
    patterns.push({ kind: 'count_results', re: RE_COUNT_RESULTS });
  }
  if (intents?.wants?.reviews) {
    patterns.push({ kind: 'rating_frac', re: RE_RATING_FRAC });
    patterns.push({ kind: 'rating_num_stars', re: RE_RATING_STARS_NUM });
    patterns.push({ kind: 'stars', re: RE_STARS });
    patterns.push({ kind: 'percent', re: RE_PERCENT });
    patterns.push({ kind: 'count_with_keyword', re: RE_REVIEW_COUNT });
  }

  // Always keep a small generic set: percents & dates are often meaningful (but low priority if not requested).
  if (!patterns.length) {
    patterns.push({ kind: 'percent', re: RE_PERCENT });
    patterns.push({ kind: 'date', re: RE_DATE });
  }

  // Apply patterns in order.
  for (const p of patterns) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const afterLines =
        p.kind === 'rating_frac' ||
        p.kind === 'rating_num_stars' ||
        p.kind === 'delivery_keyword' ||
        p.kind === 'date' ||
        p.kind === 'count_results' ||
        p.kind === 'price_currency'
          ? 1
          : 0;
      const quote = extractWindowSmart(text, start, end, { maxLen, linesBefore: 0, linesAfter: afterLines });
      const quoteLower = quote.toLowerCase();
      const financeNoise =
        (intents?.wants?.price && !intents?.exclude?.price && (p.kind === 'price_currency' || p.kind === 'percent'))
          ? isFinanceContextLower(quoteLower)
          : false;
      if (!financeNoise) {
        pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, quote, p.kind);
        if (out.length >= maxCandidates) return out;
      }
      if (m.index === p.re.lastIndex) p.re.lastIndex++;
    }
  }


  // If user asked to track ONLY price, do not fall back to non-price evidence.
  if (priceOnly) {
    const hasPrice = out.some((c) => c.kind === 'price_currency');
    if (!hasPrice) return [];
  }

  // Keyword anchors for reviews
  if (intents?.wants?.reviews && out.length < maxCandidates) {
    const keywordRe = /\b(?:opinie|opinia|ocena|oceny|recenzja|recenzje|review|reviews|rating|ratings)\b/gi;
    keywordRe.lastIndex = 0;
    let km;
    while ((km = keywordRe.exec(text)) !== null) {
      const start = km.index;
      const end = start + km[0].length;
      // Reviews often wrap (e.g., '4.6 out of 5' then 'stars ...'), so allow one continuation line.
      const quote = extractWindowSmart(text, start, end, { maxLen, linesBefore: 0, linesAfter: 1 });
      pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, quote, 'review_keyword');
      if (out.length >= maxCandidates) return out;
      if (km.index === keywordRe.lastIndex) keywordRe.lastIndex++;
    }
  }

  // Filter anchors
  if (intents?.wants?.filters && out.length < maxCandidates) {
    const re = /\b(?:filtry?\s*\d*|marka:|brand:|rozmiar:|size:|kolor:|color:|kategoria:|category:)\b/gi;
    re.lastIndex = 0;
    let fm;
    while ((fm = re.exec(text)) !== null) {
      const quote = extractWindowByLines(text, fm.index, fm.index + fm[0].length, { maxLen, linesBefore: 0, linesAfter: 2 });
      pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, quote, 'filter_keyword');
      if (out.length >= maxCandidates) return out;
      if (fm.index === re.lastIndex) re.lastIndex++;
    }
  }

  // Headline candidates (only for early chunk): first meaningful lines
  if (intents?.wants?.headline && Number(opts.chunkOrder || 0) === 0 && out.length < maxCandidates) {
    const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
    for (const ln of lines.slice(0, 6)) {
      if (out.length >= maxCandidates) break;
      // skip pure bullets if headline requested
      if (/^[-•]/.test(ln)) continue;
      if (ln.length < 6) continue;
      pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, ln.slice(0, maxLen), 'headline_line');
    }
  }

  // List item candidates when prompt talks about added/removed items / ranking
  if (intents?.wants?.list_items && out.length < maxCandidates) {
    const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
    for (const ln of lines) {
      if (out.length >= maxCandidates) break;
      if (!/^([-•]|(\d{1,3}[.)]))\s+/.test(ln)) continue;
      if (ln.length < 10) continue;
      if (ln.length > 240) continue;
      pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, ln.slice(0, maxLen), 'list_item');
    }
  }

  // Prompt-keyword candidates: anchor on significant words from USER_PROMPT.
  if (promptKeywords.length && out.length < maxCandidates) {
    for (const kw of promptKeywords) {
      if (out.length >= maxCandidates) break;
      const re = new RegExp(escapeRegExp(kw), 'ig');
      let m;
      while ((m = re.exec(text))) {
        const quote = extractWindowSmart(text, m.index, m.index + m[0].length, { windowWords: 3, maxLen });
        pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, quote, 'prompt_kw');
        if (out.length >= maxCandidates) break;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }

  // Optional heuristic noise filter (OFF by default).
  if (!EVIDENCE_HEURISTICS_ENABLED) return out.slice(0, maxCandidates);

  // Filter common seller-% noise unless prompt explicitly asks about seller.
  const wantsSeller = promptWantsSellerInfo(userPromptLower);
  const filtered = [];
  for (const c of out) {
    const ql = String(c.quote || '').toLowerCase();
    if (c.kind === 'percent' && !wantsSeller) {
      if (isSellerPercentContextLower(ql)) continue;
      if (isPriceOrDeliveryNoiseLower(ql) && !hasReviewHintLower(ql)) continue;
    }
    filtered.push(c);
  }

  return filtered.slice(0, maxCandidates);
}

function candidatePriority(kind, intents) {
  const wants = intents?.wants || {};
  if (wants.new_item && !wants.ranking) {
    if (kind === 'product_line') return 1;
    if (kind === 'brand_line') return 2;
    if (kind === 'list_item') return 3;
  }
  if (wants.ranking) {
    if (kind === 'rank_item') return 1;
  }
  if (wants.price && !intents?.exclude?.price) {
    if (kind === 'price_currency') return 1;
    if (kind === 'percent') return 4;
  }
  if (wants.availability) {
    if (kind === 'availability') return 1;
  }
  if (wants.delivery && !intents?.exclude?.delivery) {
    if (kind === 'delivery_keyword') return 2;
    if (kind === 'date') return 3;
  }
  if (wants.count) {
    if (kind === 'count_results') return 2;
  }
  if (wants.reviews) {
    if (kind === 'rating_frac') return 1;
    if (kind === 'rating_num_stars') return 2;
    if (kind === 'stars') return 3;
    if (kind === 'count_with_keyword') return 4;
    if (kind === 'review_keyword') return 6;
    if (kind === 'percent') return 7;
  }
  if (wants.filters) {
    if (kind === 'filter_keyword') return 3;
  }
  if (wants.headline) {
    if (kind === 'headline_line') return 3;
  }
  if (wants.list_items) {
    if (kind === 'list_item') return 4;
  }
  if (kind === 'prompt_kw') return 8;
  return 9;
}

function fallbackSelectCandidatesDeterministic(chunksWithCandidates, { intents, maxItemsTotal, maxQuotesPerChunk } = {}) {
  const perChunkMax = Math.max(1, Number.isFinite(maxQuotesPerChunk) ? maxQuotesPerChunk : DEFAULT_MAX_QUOTES_PER_CHUNK);
  const totalMax = Math.max(1, Number.isFinite(maxItemsTotal) ? maxItemsTotal : DEFAULT_MAX_ITEMS_TOTAL);

  // flatten candidates with priorities
  const pool = [];
  for (const c of chunksWithCandidates) {
    for (const cand of c.candidates || []) {
      pool.push({
        chunkId: c.id,
        candId: cand.id,
        quote: cand.quote,
        kind: cand.kind,
        rank: Number.isFinite(cand.rank) ? cand.rank : null,
        pr: candidatePriority(cand.kind, intents),
        qlen: String(cand.quote || '').length,
        order: Number.isFinite(c.order) ? c.order : 0,
      });
    }
  }

  pool.sort((a, b) => {
    if (intents?.wants?.ranking) {
      const ra = Number.isFinite(a.rank) ? a.rank : 999999;
      const rb = Number.isFinite(b.rank) ? b.rank : 999999;
      if (ra !== rb) return ra - rb;
      if (a.order !== b.order) return a.order - b.order;
      if (a.pr !== b.pr) return a.pr - b.pr;
      return a.qlen - b.qlen;
    }
    if (a.pr !== b.pr) return a.pr - b.pr;
    if (a.order !== b.order) return a.order - b.order;
    return a.qlen - b.qlen;
  });

  const byChunk = {};
  const chosenCount = new Map();
  const items = [];
  const focusChunkIds = [];

  for (const c of chunksWithCandidates) byChunk[c.id] = { relevant: false, chosen: [] };

  for (const it of pool) {
    if (items.length >= totalMax) break;
    const n = chosenCount.get(it.chunkId) || 0;
    if (n >= perChunkMax) continue;

    chosenCount.set(it.chunkId, n + 1);
    byChunk[it.chunkId].relevant = true;
    byChunk[it.chunkId].chosen.push(it.candId);

    if (!focusChunkIds.includes(it.chunkId)) focusChunkIds.push(it.chunkId);
    items.push({ id: `evidence#${it.candId}`, chunk_id: it.chunkId, quote: it.quote });
  }

  return { items, focusChunkIds, byChunk, llmFailed: true };
}

function stableProductKeyForEvidence(line) {
  let s = String(line || '');

  // Drop bullets / leading markers
  s = s.replace(/^\s*[-•*]\s+/, '');

  // Remove common availability / noise suffixes
  s = s.replace(/\bw tej chwili nie mamy\b.*$/i, '');
  s = s.replace(/\bbrak\b.*$/i, '');

  // Remove relative time phrases
  s = s.replace(/\b\d+\s*(?:min(?:\.|ut(?:y|ę)?)|minutes?|mins?)\s*(?:temu|ago)\b/gi, ' ');
  s = s.replace(
    /\b\d+\s*(?:godz\.?|godzin(?:y)?|hours?|hrs?)\s*(?:\d+\s*(?:min(?:\.|ut(?:y|ę)?)|minutes?|mins?)\s*)?(?:temu|ago)\b/gi,
    ' '
  );

  // Remove day markers & common date formats (PL + EN)
  s = s.replace(/\b(?:dziś|dzisiaj|wczoraj|today|yesterday)\b[, ]*/gi, ' ');
  s = s.replace(
    /\b(?:poniedziałek|poniedzialek|wtorek|środa|sroda|czwartek|piątek|piatek|sobota|niedziela)\b[, ]*/gi,
    ' '
  );
  s = s.replace(
    /\b\d{1,2}\s+(?:stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|wrzesnia|października|pazdziernika|listopada|grudnia)\b/gi,
    ' '
  );

  // Remove times
  s = s.replace(/\(\s*\d{1,2}:\d{2}\s*\)/g, ' ');
  s = s.replace(/\b\d{1,2}:\d{2}\b/g, ' ');

  // Strip common sizes & prices to stabilize keys across product pages
  s = s.replace(/\b\d+\s*(?:ml|l|g|kg|oz|pcs|szt|pack|opak)\b/gi, ' ');
  s = s.replace(/\b\d{1,3}(?:[ .]\d{3})*(?:[.,]\d{2})?\s*(?:zł|zl|pln|€|eur|usd|\$|£)\b/gi, ' ');

  // Normalize separators / quotes / whitespace
  s = s.replace(/["“”„]/g, '');
  s = s.replace(/\s*[|•·–—-]\s*/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // Remove duplicated leading token (e.g. "Kraków Kraków")
  let out = s.toLowerCase();
  out = out.replace(/^([\p{L}-]{3,})\s+\1\b/u, '$1');
  return out;
}

function deterministicSelectNewsListEvidence(chunksWithCandidates, { maxItemsTotal, logger } = {}) {
  const totalMax = clamp(Number.isFinite(maxItemsTotal) ? maxItemsTotal : 8, 3, 8);
  const byChunk = {};
  const focusChunkIds = [];

  for (const ch of chunksWithCandidates || []) {
    const chunkId = String(ch?.id || '');
    if (!byChunk[chunkId]) byChunk[chunkId] = { relevant: false, chosen: [] };
  }

  const chunkScores = (chunksWithCandidates || [])
    .map((ch) => {
      const newsCands = (ch.candidates || []).filter(
        (c) => c.kind === 'news_line' || c.kind === 'news_header'
      );
      const density = newsCands.reduce((acc, c) => acc + (c.kind === 'news_header' ? 0.6 : 1), 0);
      return {
        id: String(ch?.id || ''),
        order: Number.isFinite(ch?.order) ? ch.order : 0,
        candidates: newsCands,
        density,
      };
    })
    .filter((c) => c.density > 0);

  if (!chunkScores.length) return null;

  chunkScores.sort((a, b) => {
    if (b.density !== a.density) return b.density - a.density;
    return a.order - b.order;
  });

  const chosenChunks = chunkScores.slice(0, 2);

  const parseCandIdx = (id) => {
    const m = /#(\d+)$/.exec(String(id || ''));
    return m ? Number.parseInt(m[1], 10) : 999999;
  };

  const items = [];
  for (const ch of chosenChunks) {
    if (items.length >= totalMax) break;
    const ordered = [...ch.candidates].sort((a, b) => parseCandIdx(a.id) - parseCandIdx(b.id));
    for (const cand of ordered) {
      if (items.length >= totalMax) break;
      const evidId = `evidence#${cand.id}`;
      items.push({ id: evidId, chunk_id: ch.id, quote: cand.quote });
      byChunk[ch.id].relevant = true;
      byChunk[ch.id].chosen.push(cand.id);
      if (!focusChunkIds.includes(ch.id)) focusChunkIds.push(ch.id);
    }
  }

  if (items.length === 0 && logger?.info) {
    const counts = (chunksWithCandidates || []).map((c) => ({
      chunkId: c.id,
      candidates: (c.candidates || []).length,
      newsCandidates: (c.candidates || []).filter((x) => x.kind === 'news_line' || x.kind === 'news_header').length,
    }));
    logger.info('evidence_empty', { reason: 'news_list_no_items', counts });
  }

  return { items, focusChunkIds, byChunk };
}

function deterministicSelectNewItemEvidence(chunksWithCandidates, { maxItemsTotal, intents, logger } = {}) {
  const totalMax = clamp(
    Number.isFinite(maxItemsTotal) ? maxItemsTotal : DEFAULT_MAX_ITEMS_TOTAL_NEW_ITEM,
    6,
    DEFAULT_MAX_ITEMS_TOTAL_NEW_ITEM
  );

  const byChunk = {};
  const focusChunkIds = [];
  const brandPool = [];
  const prodPool = [];

  const normalizeNewItemEvidenceQuote = (q) => {
    let s = String(q || '');
    s = s.replace(/^\s*[-*•]\s+/, '');

    // De-dupe leading word duplicates (e.g., "Kraków Kraków ...")
    s = s.replace(/^([\p{L}-]{3,})\s+\1\b/ui, '$1');

    // Normalize whitespace
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  };

  if (intents?.wants?.news_list) {
    const news = deterministicSelectNewsListEvidence(chunksWithCandidates, {
      maxItemsTotal: 8,
      logger,
    });
    if (news && news.items.length) return news;
  }

  // Collect candidates across chunks.
  for (const ch of chunksWithCandidates || []) {
    const chunkId = String(ch?.id || '');
    const order = Number.isFinite(ch?.order) ? ch.order : 0;
    if (!byChunk[chunkId]) byChunk[chunkId] = { relevant: false, chosen: [] };

    for (const cand of ch.candidates || []) {
      const quoteRaw = String(cand?.quote || '').trim();
      const quote = normalizeNewItemEvidenceQuote(quoteRaw);
      if (!quote) continue;

      const kind = String(cand?.kind || '');
      if (kind === 'brand_line' || /(?:^[-•]\s*)?(?:marka:|brand:)/i.test(quote)) {
        brandPool.push({ chunkId, candId: cand.id, quote, order });
        continue;
      }

      if (kind === 'product_line' || kind === 'list_item') {
        // Prefer list rows that look like actual products (often have size/price or parentheses).
        const q = quote;
      const qTrim = q.trim();
      const qRaw = quoteRaw;
      const qRawTrim = qRaw.trim();

      // Drop obvious navigation / footer / pager entries
      if (
        /^(?:poprzednie|następne|next|previous|page|strona|\.{3}|\d{1,4})$/i.test(qTrim) ||
        /\b(?:facebook|instagram|youtube|rss|kontakt|regulamin|cookies|privacy|terms)\b/i.test(qTrim)
      ) {
        continue;
      }

      const hasTimeHint =
        /\b\d{1,2}:\d{2}\b/i.test(qRawTrim) ||
        /\b\d+\s*(?:minut(?:y)?|min|minutes?|mins?)\b/i.test(qRawTrim) ||
        /\b\d+\s*(?:godz\.?|godzin(?:y)?|hours?|hrs?)\b/i.test(qRawTrim) ||
        /\b(?:dziś|dzisiaj|wczoraj|today|yesterday)\b/i.test(qRawTrim);

      const looksLikeProduct =
        /(\b\d+\s*(?:ml|g|l|kg)\b|pln|\bzł\b|\bzl\b|€|\$|\(|\)|,)/i.test(qRawTrim) ||
        hasTimeHint ||
        qTrim.length >= 35;

      if (!looksLikeProduct) continue;
        prodPool.push({
          chunkId,
          candId: cand.id,
          quote,
          order,
          key: stableProductKeyForEvidence(quote),
          timeHint: hasTimeHint,
        });
      }
    }
  }

  // If we have multiple rows with clear time/date hints, prefer them (news/article lists).
  const _timeRows = prodPool.filter((p) => p.timeHint);
  if (_timeRows.length >= 3) {
    prodPool.splice(0, prodPool.length, ..._timeRows);
  }

  // Stable sort: key -> chunk order -> quote
  prodPool.sort((a, b) => {
    if (a.key !== b.key) return a.key.localeCompare(b.key);
    if (a.order !== b.order) return a.order - b.order;
    return a.quote.localeCompare(b.quote);
  });

  // Keep only first brand anchor (if any), then fill with products.
  const items = [];
  if (brandPool.length) {
    // pick earliest brand line
    brandPool.sort((a, b) => a.order - b.order);
    const b0 = brandPool[0];
    const evidId = `evidence#${b0.candId}`;
    items.push({ id: evidId, chunk_id: b0.chunkId, quote: b0.quote });
    byChunk[b0.chunkId].relevant = true;
    byChunk[b0.chunkId].chosen.push(b0.candId);
    if (!focusChunkIds.includes(b0.chunkId)) focusChunkIds.push(b0.chunkId);
  }

  for (const p of prodPool) {
    if (items.length >= totalMax) break;
    const evidId = `evidence#${p.candId}`;
    // de-dupe by exact quote (stable)
    if (items.some((x) => x.quote === p.quote)) continue;

    items.push({ id: evidId, chunk_id: p.chunkId, quote: p.quote });
    byChunk[p.chunkId].relevant = true;
    byChunk[p.chunkId].chosen.push(p.candId);
    if (!focusChunkIds.includes(p.chunkId)) focusChunkIds.push(p.chunkId);
  }

  if (items.length === 0 && logger?.info) {
    const counts = (chunksWithCandidates || []).map((c) => ({
      chunkId: c.id,
      candidates: (c.candidates || []).length,
    }));
    logger.info('evidence_empty', { reason: 'new_item_no_items', counts });
  }

  return { items, focusChunkIds, byChunk };
}

function logEmptyEvidence(logger, reason, chunksWithCandidates = []) {
  if (!logger?.info) return;
  const counts = (chunksWithCandidates || []).map((c) => ({
    chunkId: c.id,
    candidates: (c.candidates || []).length,
  }));
  logger.info('evidence_empty', { reason, counts });
}

export async function extractEvidenceFromChunksLLM({
  chunks,
  userPrompt,
  model,
  maxChunks = DEFAULT_MAX_CHUNKS,

  // Optional tuning (callers may already pass these):
  maxCandidatesPerChunk,
  maxQuotesPerChunk,
  maxItemsTotal,
  maxQuoteChars,
  timeoutMs,
  trace,
} = {}) {
  const prompt = String(userPrompt || '').trim();

let intents = detectPromptIntents(prompt);
const promptKeywords = extractPromptKeywords(prompt);

// Optional: use LLM router to assign labels to the prompt.
// If router returns labels, we may run deterministic evidence modes (ranking/item-list/new-item).
// If router returns NO labels, we intentionally skip deterministic shortcuts and fallback to classic LLM evidence selection.
let routerUsed = false;
let routerLabels = [];
let routerOk = false;
if (DEFAULT_LLM_ROUTER_ENABLED && prompt) {
  routerUsed = true;
  const routed = await routePromptLabelsLLM(prompt, {
    model,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    trace,
  });
  routerOk = !!routed?.ok;
  routerLabels = Array.isArray(routed?.labels) ? routed.labels : [];
  if (routerOk && routerLabels.length) {
    intents = applyRouterLabelsToIntents(intents, routerLabels);
  }
}


  const list = Array.isArray(chunks) ? chunks : [];

  // --- Deterministic paragraph evidence (explicit [Pxxx] constraints) ---
  // If the user explicitly asks to monitor specific paragraph(s), return full paragraph blocks
  // deterministically (no LLM selection, no snippet truncation).
  if (DEFAULT_DETERMINISTIC_PARAGRAPHS && intents?.paragraphs?.hasConstraint) {
    const out = deterministicSelectParagraphEvidenceFromChunks(list, intents?.paragraphs?.requested, {
      maxItemsTotal,
    });
    if (out?.items?.length) return out;
    // If we couldn't find any [Pxxx] blocks (unexpected), fall back to normal flow.
  }

  const pickedChunks = selectChunksForEvidence(list, { maxChunks, promptKeywords, intents });

  let maxCandidates = Number.isFinite(maxCandidatesPerChunk)
    ? maxCandidatesPerChunk
    : DEFAULT_MAX_CANDIDATES_PER_CHUNK;

  let perChunkMax = Math.max(
    1,
    Number.isFinite(maxQuotesPerChunk) ? maxQuotesPerChunk : DEFAULT_MAX_QUOTES_PER_CHUNK
  );

  let totalMax = Math.max(1, Number.isFinite(maxItemsTotal) ? maxItemsTotal : DEFAULT_MAX_ITEMS_TOTAL);
  const baseMaxLen = Number.isFinite(maxQuoteChars) ? maxQuoteChars : DEFAULT_MAX_QUOTE_LEN;
  const maxLen = intents?.wants?.ranking
    ? Math.max(baseMaxLen, 240)
    : intents?.wants?.new_item
      ? Math.max(baseMaxLen, 220)
      : baseMaxLen;

  // Ranking prompts often need MANY quotes from a single chunk (e.g. top-10 list in one block).
  if (intents?.wants?.ranking) {
    const limit = Number.isFinite(intents?.rankLimit) ? intents.rankLimit : 10;
    const capped = clamp(limit, 1, 25);
    perChunkMax = Math.max(perChunkMax, capped);
    totalMax = Math.min(totalMax, capped);
    maxCandidates = Math.max(maxCandidates, Math.min(capped + 6, 60));
  }

  // New-item prompts benefit from a broader pool of item lines (so judge can compare sets).
  if (intents?.wants?.new_item && !intents?.wants?.ranking) {
    perChunkMax = Math.max(perChunkMax, 12);
    totalMax = Math.min(Math.max(totalMax, 12), 25);
    maxCandidates = Math.max(maxCandidates, 40);
  }

  // 1) Deterministically build candidates per selected chunk.
  const chunksWithCandidates = pickedChunks.map((c, idx) => {
    const id = String(c?.id || '');
    const title = String(c?.title || '').slice(0, 140);
    const text = String(c?.text || '');
    const order = Number.isFinite(c?.order) ? c.order : idx;

    const candidates = buildCandidatesForChunk(text, id, {
      userPrompt: prompt,
      promptKeywords,
      intents,
      maxCandidates,
      maxQuoteChars: maxLen,
      chunkOrder: order,
    });

    // NOTE: keep `text` for paragraph-specific deterministic evidence.
    return { id, title, order, text, candidates };
  });

  const totalCandidates = chunksWithCandidates.reduce((acc, c) => acc + (c.candidates ? c.candidates.length : 0), 0);

  const byChunk = {};
  for (const c of chunksWithCandidates) byChunk[c.id] = { relevant: false, chosen: [] };

  if (!prompt || totalCandidates === 0) {
    if (prompt && totalCandidates === 0) {
      logEmptyEvidence(trace?.logger, 'no_candidates', chunksWithCandidates);
    }
    return { items: [], focusChunkIds: [], byChunk };
  }

// --- Deterministic shortcuts (router-gated) ---
// If router is enabled and returned NO labels -> we do NOT run deterministic shortcuts.
// This matches: "LLM wybiera etykiety; jeśli nie znajdzie żadnej -> LLM wybiera evidence".
const routerHasLabels = routerUsed && routerOk && Array.isArray(routerLabels) && routerLabels.length > 0;

// Decide determinism mode:
// - router enabled + labels: use router labels
// - router enabled + no labels: fall back to prompt heuristics (prevents empty/random selections)
// - router disabled: keep heuristic behavior
const detMode = DEFAULT_LLM_ROUTER_ENABLED ? (routerHasLabels ? 'router' : 'heuristic') : 'heuristic';

// In router mode rely on labels, but accept a generic LIST alias too.
const detWantsRanking = detMode === 'router'
  ? (routerLabels.includes('RANKING') || routerLabels.includes('LIST'))
  : intents?.wants?.ranking;
const detWantsItemList = detMode === 'router' ? routerLabels.includes('ITEM_LIST') : false; // only via router
const detWantsReviews = detMode === 'router' ? routerLabels.includes('REVIEWS') : false; // only via router

const detWantsDiff =
  ((detMode === 'router')
    ? (routerLabels.includes('DIFF_MODE') || routerLabels.includes('PRICE_CHANGE_MODE'))
    : false)
  || intents?.wants?.new_item;

// Ranking prompts: stable evidence without LLM selection.
if (DEFAULT_DETERMINISTIC_RANKING && detWantsRanking) {
  return deterministicSelectRankingEvidence(chunksWithCandidates, {
    intents,
    maxItemsTotal: Number.isFinite(maxItemsTotal) ? maxItemsTotal : undefined,
  });
}

// Full item list evidence (stable, complete rows with details).
// Used when router assigned ITEM_LIST.
if (DEFAULT_DETERMINISTIC_ITEM_LIST && detWantsItemList && !detWantsRanking) {
  const maxTotal = Number.isFinite(maxItemsTotal)
    ? maxItemsTotal
    : (detWantsDiff ? DEFAULT_MAX_ITEMS_TOTAL_ITEM_LIST_DIFF : DEFAULT_MAX_ITEMS_TOTAL_ITEM_LIST);
  return deterministicSelectNewItemEvidence(chunksWithCandidates, {
    maxItemsTotal: maxTotal,
    intents,
    logger: trace?.logger,
  });
}

// Reviews/ratings monitoring prompts: stable evidence lines with rating + counts.
// Used when router assigned REVIEWS.
if (DEFAULT_DETERMINISTIC_REVIEWS && detWantsReviews) {
  const maxTotal = Number.isFinite(maxItemsTotal) ? maxItemsTotal : DEFAULT_MAX_ITEMS_TOTAL_REVIEWS;
  return deterministicSelectReviewsEvidence(chunksWithCandidates, { intents, maxItemsTotal: maxTotal });
}

// Provide a broad, stable pool of product rows so the judge can compare snapshots.

// Diff-oriented prompts ("co nowego", "co się zmieniło", "czy potaniało"):
// Provide a broad, stable pool of product rows so the judge can compare snapshots.

if (DEFAULT_DETERMINISTIC_NEW_ITEM && detWantsDiff && !detWantsRanking && !detWantsItemList) {
  const maxTotal = Number.isFinite(maxItemsTotal) ? maxItemsTotal : DEFAULT_MAX_ITEMS_TOTAL_NEW_ITEM;
  return deterministicSelectNewItemEvidence(chunksWithCandidates, {
    maxItemsTotal: maxTotal,
    intents,
    logger: trace?.logger,
  });
}

// 2) Ask LLM to select candidate IDs.

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['chunks'],
    properties: {
      chunks: {
        type: 'array',
        minItems: 1,
        maxItems: Math.max(1, chunksWithCandidates.length),
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'relevant', 'chosen'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
            relevant: { type: 'boolean' },
            chosen: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 128 },
              maxItems: perChunkMax,
            },
          },
        },
      },
    },
  };

  const system = `Jesteś ekstraktorem dowodów (evidence) dla monitoringu zmian na stronie.
Dostajesz USER_PROMPT oraz listę chunków. W każdym chunku jest lista KANDYDATÓW: krótkie, DOSŁOWNE fragmenty tekstu ze strony.
Twoje zadanie: wybrać ID kandydatów, które są BEZPOŚREDNIO związane z USER_PROMPT.

Zasady:
- Wybieraj tylko kandydaty, które są jednoznacznym "dowodem" pod prompt (np. cena, dostępność, data/dostawa, liczba wyników, ocena/recenzje, konkretne pozycje listy, filtry).
- Jeśli USER_PROMPT dotyczy NOWYCH/DODANYCH/USUNIĘTYCH pozycji (np. "pojawi się nowy produkt"), preferuj cytaty, które są WERSAMI produktów/pozycji listy (a nie menu/nawigacją).
- Jeśli USER_PROMPT zawiera prośbę typu "ignoruj cenę / dostawę" — NIE wybieraj kandydatów o tej kategorii.
- Nie wybieraj luźnych opisów bez konkretu (liczb, dat, fraz dostępności), jeśli prompt oczekuje konkretu.
- Jeśli nie masz pewności, NIE wybieraj.

Wynik: WYŁĄCZNIE JSON zgodny ze schematem. Dla KAŻDEGO podanego chunka zwróć obiekt {id, relevant, chosen}. chosen może zawierać tylko ID z candidates dla danego chunka.`;

  const llmInput = {
    userPrompt: prompt,
    intents: intents,
    chunks: chunksWithCandidates.map((c) => ({
      id: c.id,
      title: c.title,
      candidates: (c.candidates || []).map((x) => ({ id: x.id, kind: x.kind, text: x.quote })),
    })),
  };

  let parsed;
  try {
    const resp = await generateTextWithOllama({
      model,
      system,
      prompt: JSON.stringify(llmInput),
      format: schema,
      temperature: 0,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      logger: trace?.logger,
      label: trace?.label || 'evidence',
    });

    if (!resp?.ok) throw new Error(resp?.error || 'ollama_failed');

    parsed = resp?.json;
    if (!parsed || !Array.isArray(parsed.chunks)) throw new Error('bad_json');
  } catch (e) {
    return fallbackSelectCandidatesDeterministic(chunksWithCandidates, {
      intents,
      maxItemsTotal: totalMax,
      maxQuotesPerChunk: perChunkMax,
    });
  }

  // 3) Validate & materialize evidence items.
  const candIndex = new Map();
  for (const c of chunksWithCandidates) {
    for (const x of c.candidates || []) {
      candIndex.set(x.id, { chunkId: c.id, quote: x.quote, rank: x.rank });
    }
  }

  const focusChunkIds = [];
  const items = [];
  const evidenceRank = new Map();
  const selectedPerChunk = new Map();

  for (const ch of parsed.chunks || []) {
    const chunkId = String(ch?.id || '');
    const relevant = Boolean(ch?.relevant);
    const chosen = Array.isArray(ch?.chosen) ? ch.chosen : [];

    const validChosen = chosen
      .map((id) => String(id || ''))
      .filter(Boolean)
      .filter((id) => {
        const info = candIndex.get(id);
        return info && info.chunkId === chunkId;
      })
      .slice(0, perChunkMax);

    const finalRelevant = relevant && validChosen.length > 0;
    if (!byChunk[chunkId]) byChunk[chunkId] = { relevant: false, chosen: [] };
    byChunk[chunkId] = { relevant: finalRelevant, chosen: validChosen };

    if (finalRelevant && !focusChunkIds.includes(chunkId)) focusChunkIds.push(chunkId);

    // Enforce total max items + per-chunk max again (defensive)
    let already = selectedPerChunk.get(chunkId) || 0;
    for (const cid of validChosen) {
      if (items.length >= totalMax) break;
      if ((selectedPerChunk.get(chunkId) || 0) >= perChunkMax) break;

      const info = candIndex.get(cid);
      if (info?.quote) {
        const evidId = `evidence#${cid}`;
        items.push({ id: evidId, chunk_id: chunkId, quote: info.quote });
        if (Number.isFinite(info.rank)) evidenceRank.set(evidId, info.rank);
        selectedPerChunk.set(chunkId, ++already);
      }
    }
  }

  // Fill missing chunks (if LLM skipped some) as irrelevant
  for (const c of chunksWithCandidates) {
    if (!byChunk[c.id]) byChunk[c.id] = { relevant: false, chosen: [] };
  }

  // Ensure stable order (and rank order for ranking prompts).
  if (intents?.wants?.ranking) {
    items.sort((a, b) => {
      const ra = evidenceRank.has(a.id) ? evidenceRank.get(a.id) : 999999;
      const rb = evidenceRank.has(b.id) ? evidenceRank.get(b.id) : 999999;
      if (ra !== rb) return ra - rb;
      // fallback: chunk order + id for stability
      if (String(a.chunk_id) !== String(b.chunk_id)) return String(a.chunk_id).localeCompare(String(b.chunk_id));
      return String(a.id).localeCompare(String(b.id));
    });
  } else {
    items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  if (items.length === 0) {
    logEmptyEvidence(trace?.logger, 'llm_no_items', chunksWithCandidates);
  }

  return { items, focusChunkIds, byChunk };
}
