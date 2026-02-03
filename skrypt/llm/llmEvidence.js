// skrypt/llm/llmEvidence.js
// Evidence extraction v3 (prompt-adaptive + chunk-selection):
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
  // Keeps evidence stable & readable: usually "one bullet / one line".
  const hasNewlines = typeof text === 'string' && text.indexOf('\n') !== -1;
  if (hasNewlines) return extractWindowByLines(text, matchStart, matchEnd, { ...opts, linesBefore: 0, linesAfter: 1 });
  return extractWindowByWords(text, matchStart, matchEnd, opts);
}

function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/["'`]/g, '')
    .trim();
}

function pushCandidate(out, seen, id, quote, kind) {
  const q = String(quote || '').trim();
  if (!q) return;
  const key = normKey(q);
  if (!key || seen.has(key)) return;
  seen.add(key);
  out.push({ id, quote: q, kind });
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
  'oferta', 'oferte', 'strona', 'strony', 'elementy', 'pozostałe', 'pozostale',
  // platform generic
  'allegro', 'ceneo', 'amazon', 'ebay', 'booking', 'steam', 'zalando', 'decathlon',
  // very generic nouns
  'produkt', 'produktu', 'produkty', 'products', 'item', 'items',
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

function isPriceOrDeliveryNoiseLower(s) {
  return /(\bzł\b|\bzl\b|pln|smart|rat|dostaw|kup\s+do|zaplac|pay|\b\d{1,2}:\d{2}\b)/.test(s);
}

function detectPromptIntents(userPrompt) {
  const p = String(userPrompt || '').toLowerCase();

  const wants = {
    reviews: /(opin|recenz|review|rating|ocen|gwiazd|★|\/5|\/10)/.test(p),
    price: /(cena|price|koszt|pln|\bzł\b|\bzl\b|€|\$|usd|eur)/.test(p),
    availability: /(dostępn|dostepn|brak|nie\s*mamy|out\s*of\s*stock|sold\s*out|unavailable|in\s*stock|available)/.test(p),
    delivery: /(dostaw|wysył|wysyl|delivery|ship|shipping|kurier|odbi[oó]r|pickup)/.test(p),
    count: /(liczb|wynik|ofert|ogłosze|oglosze|results|items|pozycji|produkt|products|listing)/.test(p),
    list_items: /(nowe|dodane|usunię|usunie|removed|added|lista|pozycje|pozycja|top|ranking|rank)/.test(p),
    filters: /(filtr|marka|brand|rozmiar|size|kolor|color|kategoria|category)/.test(p),
    headline: /(nagł|naglo|headline|tytuł|tytul|title|podtytuł|podtytul|subheadline)/.test(p),
  };

  const exclude = {
    price: /(ignoruj|ignore).{0,30}(cen|price)|bez\s+ceny|nie.{0,25}(cena|price)/.test(p),
    delivery: /(ignoruj|ignore).{0,30}(dostaw|delivery|wysył|wysyl)/.test(p),
  };

  return { wants, exclude };
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

  if (intents?.wants?.list_items) {
    // bullets/numbered lines hint: list pages, rankings, etc.
    score += countMatches(t, /(^|\n)\s*(?:[-•]|(?:\d{1,3}[.)]))\s+/g) * 2;
  }

  // Tiny bump for very short chunks if headline is requested (often first lines).
  if (intents?.wants?.headline && t.length < 800) score += 2;

  return score;
}

function selectChunksForEvidence(allChunks, { maxChunks, promptKeywords, intents }) {
  const list = Array.isArray(allChunks) ? allChunks : [];
  const k = Math.max(1, Number.isFinite(maxChunks) ? maxChunks : DEFAULT_MAX_CHUNKS);

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

function buildCandidatesForChunk(chunkText, chunkId, opts = {}) {
  const text = String(chunkText || '');
  const maxCandidates = Number.isFinite(opts.maxCandidates)
    ? opts.maxCandidates
    : DEFAULT_MAX_CANDIDATES_PER_CHUNK;

  const userPrompt = String(opts.userPrompt || '');
  const userPromptLower = userPrompt.toLowerCase();
  const promptKeywords = Array.isArray(opts.promptKeywords) ? opts.promptKeywords : [];
  const intents = opts.intents || detectPromptIntents(userPrompt);

  const maxLen = Number.isFinite(opts.maxQuoteChars) ? opts.maxQuoteChars : DEFAULT_MAX_QUOTE_LEN;

  const seen = new Set();
  const out = [];
  let idx = 0;

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
      const quote = extractWindowSmart(text, start, end, { maxLen });
      pushCandidate(out, seen, `cand#${chunkId}#${idx++}`, quote, p.kind);
      if (out.length >= maxCandidates) return out;
      if (m.index === p.re.lastIndex) p.re.lastIndex++;
    }
  }

  // Keyword anchors for reviews
  if (intents?.wants?.reviews && out.length < maxCandidates) {
    const keywordRe = /\b(?:opinie|opinia|ocena|oceny|recenzja|recenzje|review|reviews|rating|ratings)\b/gi;
    keywordRe.lastIndex = 0;
    let km;
    while ((km = keywordRe.exec(text)) !== null) {
      const start = km.index;
      const end = start + km[0].length;
      const quote = extractWindowSmart(text, start, end, { maxLen });
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
        pr: candidatePriority(cand.kind, intents),
        qlen: String(cand.quote || '').length,
        order: Number.isFinite(c.order) ? c.order : 0,
      });
    }
  }

  pool.sort((a, b) => {
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

  const intents = detectPromptIntents(prompt);
  const promptKeywords = extractPromptKeywords(prompt);

  const list = Array.isArray(chunks) ? chunks : [];
  const pickedChunks = selectChunksForEvidence(list, { maxChunks, promptKeywords, intents });

  const maxCandidates = Number.isFinite(maxCandidatesPerChunk)
    ? maxCandidatesPerChunk
    : DEFAULT_MAX_CANDIDATES_PER_CHUNK;

  const perChunkMax = Math.max(
    1,
    Number.isFinite(maxQuotesPerChunk) ? maxQuotesPerChunk : DEFAULT_MAX_QUOTES_PER_CHUNK
  );

  const totalMax = Math.max(1, Number.isFinite(maxItemsTotal) ? maxItemsTotal : DEFAULT_MAX_ITEMS_TOTAL);
  const maxLen = Number.isFinite(maxQuoteChars) ? maxQuoteChars : DEFAULT_MAX_QUOTE_LEN;

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

    return { id, title, order, candidates };
  });

  const totalCandidates = chunksWithCandidates.reduce((acc, c) => acc + (c.candidates ? c.candidates.length : 0), 0);

  const byChunk = {};
  for (const c of chunksWithCandidates) byChunk[c.id] = { relevant: false, chosen: [] };

  if (!prompt || totalCandidates === 0) {
    return { items: [], focusChunkIds: [], byChunk };
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
      candIndex.set(x.id, { chunkId: c.id, quote: x.quote });
    }
  }

  const focusChunkIds = [];
  const items = [];
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
    const already = selectedPerChunk.get(chunkId) || 0;
    for (const cid of validChosen) {
      if (items.length >= totalMax) break;
      if ((selectedPerChunk.get(chunkId) || 0) >= perChunkMax) break;

      const info = candIndex.get(cid);
      if (info?.quote) {
        items.push({ id: `evidence#${cid}`, chunk_id: chunkId, quote: info.quote });
        selectedPerChunk.set(chunkId, already + 1);
      }
    }
  }

  // Fill missing chunks (if LLM skipped some) as irrelevant
  for (const c of chunksWithCandidates) {
    if (!byChunk[c.id]) byChunk[c.id] = { relevant: false, chosen: [] };
  }

  // Ensure stable order
  items.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  return { items, focusChunkIds, byChunk };
}
