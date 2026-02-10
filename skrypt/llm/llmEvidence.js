import { generateTextWithOllama } from './ollamaClient.js';

const DEFAULT_MAX_CHUNKS = Number.parseInt(process.env.EVIDENCE_MAX_CHUNKS || '14', 10);
const DEFAULT_MAX_CANDIDATES_PER_CHUNK = Number.parseInt(process.env.EVIDENCE_MAX_CANDIDATES_PER_CHUNK || '14', 10);
const DEFAULT_MAX_QUOTES_PER_CHUNK = Number.parseInt(process.env.EVIDENCE_MAX_QUOTES_PER_CHUNK || '4', 10);
const DEFAULT_MAX_ITEMS_TOTAL = Number.parseInt(process.env.EVIDENCE_MAX_ITEMS_TOTAL || '10', 10);
const DEFAULT_MAX_PREVIEW_CHARS = 600;

const LABELS = [
  'PARAGRAPH_RANGE',
  'FX_RATE',
  'PRICE_MAIN',
  'PRICE_ANY',
  'AVAILABILITY',
  'RANKING_ORDER',
  'RANKING_SET',
  'ITEM_LIST',
  'REVIEWS',
  'RATING_SUMMARY',
  'ANNOUNCEMENT_NEWS',
];

const LABEL_PRIORITY = [
  'PARAGRAPH_RANGE',
  'FX_RATE',
  'PRICE_MAIN',
  'PRICE_ANY',
  'AVAILABILITY',
  'RANKING_ORDER',
  'RANKING_SET',
  'REVIEWS',
  'RATING_SUMMARY',
  'ITEM_LIST',
  'ANNOUNCEMENT_NEWS',
];

const FX_CODES = ['USD', 'EUR', 'CHF', 'GBP', 'JPY', 'PLN'];
const AVAILABILITY_RE = /(dost[eę]pn|niedost[eę]pn|brak\s+w\s+magazynie|out\s+of\s+stock|in\s+stock|sold\s*out|wyprzedan)/i;
const PRICE_RE = /(?:\b\d{1,3}(?:[\s.,]\d{3})+(?:[.,]\d{2})?\s*(?:zł|zl|pln)\b)|(?:\b\d{4,}\s*(?:zł|zl|pln)\b)|(?:(?:zł|zl|pln)\s*\d{1,3}(?:[\s.,]\d{3})*(?:[.,]\d{2})?\b)/i;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function safeJson(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

function normalizeLabel(label) {
  const x = String(label || '').trim().toUpperCase();
  return LABELS.includes(x) ? x : null;
}

function parseParagraphSelectionFromPrompt(userPrompt) {
  const p = String(userPrompt || '');
  const selected = new Set();

  const single = [...p.matchAll(/(?:paragraf|akapit|\[?P)(?:\s*|\[)(\d{1,3})\]?/gi)];
  for (const m of single) selected.add(Number.parseInt(m[1], 10));

  const pTags = [...p.matchAll(/\[P(\d{3})\]/gi)];
  for (const m of pTags) selected.add(Number.parseInt(m[1], 10));

  const ranges = [...p.matchAll(/(?:paragrafy?|akapity?|P)(?:\s+od)?\s*(\d{1,3})\s*(?:-|do)\s*(\d{1,3})/gi)];
  for (const m of ranges) {
    const a = Number.parseInt(m[1], 10);
    const b = Number.parseInt(m[2], 10);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) selected.add(i);
  }

  const ids = [...selected].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  return {
    hasConstraint: ids.length > 0,
    requested: ids.map((n) => `P${String(n).padStart(3, '0')}`),
  };
}

function splitLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function makeCandidate(chunkId, line, idx, kind = 'line', score = 0) {
  return {
    id: `${chunkId}#L${idx}`,
    chunkId,
    quote: line,
    kind,
    score,
  };
}

function buildByChunk(chunks) {
  const out = {};
  for (const c of chunks) out[String(c?.id || '')] = { relevant: false, chosen: [] };
  return out;
}

function materialize(chosenCandidates, allChunks, byChunk, maxItemsTotal) {
  const items = [];
  const focusSet = new Set();
  const maxTotal = Math.max(1, Number.isFinite(maxItemsTotal) ? maxItemsTotal : DEFAULT_MAX_ITEMS_TOTAL);

  const seen = new Set();
  for (const c of chosenCandidates) {
    if (!c?.quote || seen.has(c.id) || items.length >= maxTotal) continue;
    seen.add(c.id);
    items.push({ id: `evidence#${c.id}`, chunk_id: c.chunkId, quote: c.quote });
    focusSet.add(c.chunkId);
    if (!byChunk[c.chunkId]) byChunk[c.chunkId] = { relevant: false, chosen: [] };
    byChunk[c.chunkId].relevant = true;
    byChunk[c.chunkId].chosen.push(c.id);
  }

  for (const chunk of allChunks) {
    const id = String(chunk?.id || '');
    if (!byChunk[id]) byChunk[id] = { relevant: false, chosen: [] };
  }

  return {
    items,
    focusChunkIds: [...focusSet],
    byChunk,
    chunk_relevance: byChunk,
  };
}

async function routePromptLabelsLLM(userPrompt, { model, timeoutMs, trace } = {}) {
  const format = {
    type: 'object',
    additionalProperties: false,
    required: ['labels'],
    properties: {
      labels: {
        type: 'array',
        items: { type: 'string', enum: LABELS },
        maxItems: LABELS.length,
      },
      confidence: { type: 'number' },
    },
  };

  const system = `Jesteś routerem etykiet dla monitoringu zmian.
Zwracasz WYŁĄCZNIE JSON: {"labels": string[], "confidence"?: number}.
Dobieraj etykiety z listy: ${LABELS.join(', ')}.

Kluczowe zasady:
- FX_RATE: kursy walut / USD/PLN / EUR/PLN / notowania walut / tabela kursów.
- PRICE_MAIN i PRICE_ANY dotyczą cen produktów/usług, NIE kursów walut.
- Jeśli prompt dotyczy kursów "1USD 3,5377" lub "1EUR 4,2148" => FX_RATE.
- Jeśli prompt dotyczy "główna cena produktu" => PRICE_MAIN.
- Jeśli prompt dotyczy "lista cen" => PRICE_ANY.
- Gdy brak pewnej etykiety, zwróć labels: [].`;

  try {
    const resp = await generateTextWithOllama({
      model,
      system,
      prompt: String(userPrompt || ''),
      format,
      temperature: 0,
      timeoutMs,
      logger: trace?.logger,
      label: trace?.label || 'evidence_router',
    });
    if (!resp?.ok) return { ok: false, labels: [] };
    const json = safeJson(resp?.json) || safeJson(resp?.text);
    const labels = Array.isArray(json?.labels)
      ? json.labels.map(normalizeLabel).filter(Boolean)
      : [];
    return { ok: true, labels: [...new Set(labels)], confidence: json?.confidence };
  } catch {
    return { ok: false, labels: [] };
  }
}

function pickBestLabel(labels) {
  if (!Array.isArray(labels) || !labels.length) return null;
  for (const lbl of LABEL_PRIORITY) {
    if (labels.includes(lbl)) return lbl;
  }
  return labels[0] || null;
}

function extractFxPairsFromPrompt(prompt) {
  const p = String(prompt || '').toUpperCase();
  const pairs = new Set();
  for (const code of FX_CODES) {
    if (new RegExp(`\\b${code}\\s*\\/?\\s*PLN\\b`).test(p)) pairs.add(code);
  }
  return [...pairs].filter((c) => c !== 'PLN');
}

function buildGenericCandidatesFromChunks(chunks, { maxCandidatesPerChunk, keywordRe } = {}) {
  const out = [];
  for (const chunk of chunks) {
    const chunkId = String(chunk?.id || '');
    const lines = splitLines(chunk?.text);
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (keywordRe && !keywordRe.test(line)) continue;
      out.push(makeCandidate(chunkId, line, i, 'line', 0));
      count++;
      if (count >= maxCandidatesPerChunk) break;
    }
  }
  return out;
}

function buildCandidatesForLabel(label, chunks, userPrompt, maxCandidatesPerChunk) {
  const candidates = [];
  const fxPairs = extractFxPairsFromPrompt(userPrompt);

  for (const chunk of chunks) {
    const chunkId = String(chunk?.id || '');
    const lines = splitLines(chunk?.text);
    let count = 0;

    for (let i = 0; i < lines.length; i++) {
      if (count >= maxCandidatesPerChunk) break;
      const line = lines[i];
      const upper = line.toUpperCase();
      let ok = false;
      let kind = label.toLowerCase();
      let score = 1;

      if (label === 'FX_RATE') {
        const hasCode = FX_CODES.some((c) => new RegExp(`(?:^|\\s)1?\\s*${c}(?:\\s|$)`, 'i').test(line));
        const hasRate = /\b\d{1,4}[.,]\d{2,6}\b/.test(line);
        const hasPercent = /%/.test(line);
        const pairMatch = fxPairs.length === 0 || fxPairs.some((c) => new RegExp(`(?:^|\\s)1?\\s*${c}(?:\\s|$)`, 'i').test(line));
        ok = hasCode && hasRate && pairMatch;
        if (ok && hasPercent) score -= 0.5;
      } else if (label === 'PRICE_MAIN' || label === 'PRICE_ANY') {
        ok = PRICE_RE.test(line);
        if (ok && /%/.test(line)) score -= 0.25;
      } else if (label === 'AVAILABILITY') {
        ok = AVAILABILITY_RE.test(line);
      } else if (label === 'RANKING_ORDER') {
        ok = /^(?:#?\d{1,2}[).:-]?\s+).+/.test(line) || /\btop\s*\d+/i.test(line);
      } else if (label === 'RANKING_SET') {
        ok = /^(?:#?\d{1,2}[).:-]?\s+).+/.test(line) || /\btop\s*\d+/i.test(line);
        if (ok) {
          const stripped = line.replace(/^#?\d{1,2}[).:-]?\s+/, '').trim();
          if (stripped) {
            candidates.push(makeCandidate(chunkId, stripped, i, 'ranking_set_item', score));
            count++;
            continue;
          }
        }
      } else if (label === 'ITEM_LIST') {
        ok = /^[-•*]\s+/.test(line) || /\b(oferta|produkt|wariant|item|items?)\b/i.test(line);
      } else if (label === 'REVIEWS') {
        ok = /(opini|recenz|review)/i.test(line);
      } else if (label === 'RATING_SUMMARY') {
        ok = /(\b\d(?:[.,]\d)?\s*\/\s*5\b|gwiaz|ocen\w*\s*\d+|\d+\s*opini)/i.test(line);
      } else if (label === 'ANNOUNCEMENT_NEWS') {
        ok = /(aktualno|komunikat|ogłosz|news|wpis|post)/i.test(line);
      } else if (label === 'PARAGRAPH_RANGE') {
        ok = /\[P\d{3}\]/i.test(line);
      }

      if (!ok) continue;
      candidates.push(makeCandidate(chunkId, line, i, kind, score));
      count++;
    }
  }

  return candidates;
}

function selectDeterministically(candidates, label, maxItemsTotal, maxQuotesPerChunk) {
  const grouped = new Map();
  for (const c of candidates) {
    if (!grouped.has(c.chunkId)) grouped.set(c.chunkId, []);
    grouped.get(c.chunkId).push(c);
  }

  const out = [];
  for (const arr of grouped.values()) {
    arr.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    let perChunk = 0;
    for (const c of arr) {
      if (perChunk >= maxQuotesPerChunk || out.length >= maxItemsTotal) break;
      if (label === 'PRICE_MAIN' && perChunk >= 1) break;
      out.push(c);
      perChunk++;
    }
    if (out.length >= maxItemsTotal) break;
  }

  return out;
}

function parseRequestedParagraphIds(userPrompt) {
  return parseParagraphSelectionFromPrompt(userPrompt).requested;
}

function selectParagraphEvidence(chunks, requestedParagraphs, maxItemsTotal) {
  if (!requestedParagraphs.length) return [];
  const wanted = new Set(requestedParagraphs);
  const out = [];

  for (const chunk of chunks) {
    const chunkId = String(chunk?.id || '');
    const text = String(chunk?.text || '');
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/\[(P\d{3})\]/i);
      if (!m) continue;
      const pid = m[1].toUpperCase();
      if (!wanted.has(pid)) continue;
      out.push(makeCandidate(chunkId, line, i, 'paragraph_range', 10));
      if (out.length >= maxItemsTotal) return out;
    }
  }

  return out;
}

function buildChunkPreviews(chunks, maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS) {
  return chunks.map((c) => {
    const lines = splitLines(c?.text).slice(0, 10).join('\n');
    return {
      id: String(c?.id || ''),
      title: String(c?.title || ''),
      preview: lines.slice(0, maxPreviewChars),
    };
  });
}

async function llmSelectFocusChunks(userPrompt, chunks, { model, timeoutMs, trace } = {}) {
  const format = {
    type: 'object',
    additionalProperties: false,
    required: ['focusChunkIds'],
    properties: {
      focusChunkIds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    },
  };

  const system = `Wybierz tylko ID chunków istotnych dla USER_PROMPT. Zwróć WYŁĄCZNIE JSON: {"focusChunkIds": string[]}.`; 

  try {
    const resp = await generateTextWithOllama({
      model,
      system,
      prompt: JSON.stringify({ userPrompt, chunks: buildChunkPreviews(chunks) }),
      format,
      temperature: 0,
      timeoutMs,
      logger: trace?.logger,
      label: trace?.label || 'evidence_chunk_selector',
    });
    if (!resp?.ok) return [];
    const json = safeJson(resp?.json) || safeJson(resp?.text);
    const ids = Array.isArray(json?.focusChunkIds) ? json.focusChunkIds.map((x) => String(x || '')) : [];
    const allowed = new Set(chunks.map((c) => String(c?.id || '')));
    return [...new Set(ids.filter((id) => allowed.has(id)))];
  } catch {
    return [];
  }
}

async function llmSelectEvidenceIds(userPrompt, candidates, { model, timeoutMs, trace, maxChosen } = {}) {
  const format = {
    type: 'object',
    additionalProperties: false,
    required: ['chosenIds'],
    properties: {
      chosenIds: { type: 'array', items: { type: 'string' }, maxItems: Math.max(1, maxChosen || 10) },
    },
  };

  const system = `Wybierz tylko ID dowodów pasujące do USER_PROMPT.
Uwaga: dowody to dosłowne cytaty, możesz wybrać tylko istniejące ID.
Zwróć WYŁĄCZNIE JSON: {"chosenIds": string[]}.`;

  try {
    const resp = await generateTextWithOllama({
      model,
      system,
      prompt: JSON.stringify({
        userPrompt,
        candidates: candidates.map((c) => ({ id: c.id, chunkId: c.chunkId, text: c.quote })),
      }),
      format,
      temperature: 0,
      timeoutMs,
      logger: trace?.logger,
      label: trace?.label || 'evidence_selector',
    });
    if (!resp?.ok) return [];
    const json = safeJson(resp?.json) || safeJson(resp?.text);
    const ids = Array.isArray(json?.chosenIds) ? json.chosenIds.map((x) => String(x || '')) : [];
    const allowed = new Set(candidates.map((c) => c.id));
    return [...new Set(ids.filter((id) => allowed.has(id)))];
  } catch {
    return [];
  }
}

function fallbackFocusChunks(chunks) {
  const sorted = [...chunks].sort((a, b) => String(b?.text || '').length - String(a?.text || '').length);
  return sorted.slice(0, clamp(Math.min(4, chunks.length), 1, 4)).map((c) => String(c?.id || ''));
}

function fallbackChosenCandidates(candidates, maxChosen) {
  return [...candidates]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, maxChosen))
    .map((c) => c.id);
}

function logDiag(logger, payload) {
  const line = `[llmEvidence] ${JSON.stringify(payload)}`;
  if (logger?.info) logger.info(line);
  else if (logger?.log) logger.log(line);
  else console.info(line);
}

export async function extractEvidenceFromChunksLLM({
  chunks,
  userPrompt,
  model,
  maxChunks = DEFAULT_MAX_CHUNKS,
  maxCandidatesPerChunk,
  maxQuotesPerChunk,
  maxItemsTotal,
  timeoutMs,
  trace,
} = {}) {
  const prompt = String(userPrompt || '').trim();
  const list = (Array.isArray(chunks) ? chunks : [])
    .slice(0, Math.max(1, maxChunks))
    .map((c, idx) => ({ ...c, order: Number.isFinite(c?.order) ? c.order : idx }));

  const byChunk = buildByChunk(list);
  if (!prompt || list.length === 0) {
    return { items: [], focusChunkIds: [], byChunk, chunk_relevance: byChunk };
  }

  const perChunkMax = Math.max(1, Number.isFinite(maxQuotesPerChunk) ? maxQuotesPerChunk : DEFAULT_MAX_QUOTES_PER_CHUNK);
  const candidatesPerChunk = Math.max(1, Number.isFinite(maxCandidatesPerChunk) ? maxCandidatesPerChunk : DEFAULT_MAX_CANDIDATES_PER_CHUNK);
  const maxTotal = Math.max(1, Number.isFinite(maxItemsTotal) ? maxItemsTotal : DEFAULT_MAX_ITEMS_TOTAL);

  const paragraphInfo = parseParagraphSelectionFromPrompt(prompt);
  if (paragraphInfo.hasConstraint) {
    const paragraphCandidates = selectParagraphEvidence(list, paragraphInfo.requested, maxTotal);
    const result = materialize(paragraphCandidates, list, byChunk, maxTotal);
    logDiag(trace?.logger, {
      mode: 'label:PARAGRAPH_RANGE',
      labels: ['PARAGRAPH_RANGE'],
      focusChunkIdsCount: result.focusChunkIds.length,
      candidatesCount: paragraphCandidates.length,
      chosenCount: result.items.length,
    });
    return result;
  }

  const routed = await routePromptLabelsLLM(prompt, {
    model,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    trace,
  });
  const labels = Array.isArray(routed?.labels) ? routed.labels : [];

  if (labels.length > 0) {
    const label = pickBestLabel(labels);
    const candidates = buildCandidatesForLabel(label, list, prompt, candidatesPerChunk);
    const chosen = selectDeterministically(candidates, label, maxTotal, perChunkMax);
    const result = materialize(chosen, list, byChunk, maxTotal);
    logDiag(trace?.logger, {
      mode: `label:${label}`,
      labels,
      focusChunkIdsCount: result.focusChunkIds.length,
      candidatesCount: candidates.length,
      chosenCount: result.items.length,
    });
    return result;
  }

  const focusChunkIds = await llmSelectFocusChunks(prompt, list, {
    model,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    trace,
  });

  const validFocus = focusChunkIds.length > 0 ? focusChunkIds : fallbackFocusChunks(list);
  const focusSet = new Set(validFocus);
  const focusChunks = list.filter((c) => focusSet.has(String(c?.id || '')));

  const promptWords = prompt.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  const keywordRe = promptWords.length > 0 ? new RegExp(`\\b(${promptWords.slice(0, 12).join('|')})`, 'i') : null;
  const candidates = buildGenericCandidatesFromChunks(focusChunks, {
    maxCandidatesPerChunk: candidatesPerChunk,
    keywordRe,
  });

  const chosenIds = await llmSelectEvidenceIds(prompt, candidates, {
    model,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    trace,
    maxChosen: maxTotal,
  });

  const finalIds = chosenIds.length > 0 ? chosenIds : fallbackChosenCandidates(candidates, maxTotal);
  const chosenSet = new Set(finalIds);
  const chosen = candidates.filter((c) => chosenSet.has(c.id)).slice(0, maxTotal);
  const result = materialize(chosen, list, byChunk, maxTotal);

  logDiag(trace?.logger, {
    mode: 'fallback:llm_chunk_select',
    labels,
    focusChunkIdsCount: validFocus.length,
    candidatesCount: candidates.length,
    chosenCount: result.items.length,
  });

  return result;
}

export { parseRequestedParagraphIds };
