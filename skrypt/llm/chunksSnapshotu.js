// skrypt/llm/chunksSnapshotu.js
// Snapshot-level chunk cache (text_chunks_v1) + deterministic chunking (default) + optional semantic (LLM) ranges.
//
// Cel: uniwersalne chunki z zakresami from/to (po liniach), bez heurystyk pod strony.
//
// Semantyczne chunkowanie jest OPCJONALNE (opt-in), bo bywa niestabilne.
// Włączanie semantycznego chunkera (explicit):
//   - LLM_CHUNK_MODE=semantic
//   - LLM_SEMANTIC_RANGES > 0  (np. 8)  => target ok. tyle chunków (model może zwrócić +/- kilka)
//   - LLM_SEMANTIC_MAX_LINES   => limit linii (ochrona przed zbyt dużym promptem)
//
// Cache:
//   - zapisujemy w snapshot.text_chunks_v1, reużywane gdy text_sha1 bez zmian.
//
// Backward-compat:
//   - eksport buildChunksSnapshotu jako alias do ensureSnapshotChunks (żeby nie wywalało importów).

import { mongoClient } from '../polaczenieMDB.js';
import { sha1, normalizeWhitespace, excerpt, slugifyKey } from './analysisUtils.js';
import { extractChunksByTemplate, scoreTemplateFit } from './llmChunker.js';
import { generateTextWithOllama } from './ollamaClient.js';

const db = mongoClient.db(process.env.MONGO_DB || 'inzynierka');
const snapshotsCol = db.collection('snapshots');

function envNum(name, fallback = 0) {
  const v = String(process.env[name] ?? '').trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name, fallback = null) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  const v = String(raw).trim();
  return v.length ? v : fallback;
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1','true','yes','y','on'].includes(v)) return true;
  if (['0','false','no','n','off'].includes(v)) return false;
  return fallback;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function ensureMongoConnected() {
  // bezpieczne dla różnych wersji drivera
  try {
    const connected =
      mongoClient?.topology?.isConnected?.() ||
      mongoClient?.topology?.s?.state === 'connected';
    if (connected) return Promise.resolve();
  } catch {
    // ignore
  }
  return mongoClient.connect();
}

function safeJsonParse(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // spróbuj wyciąć "pierwszy obiekt" (częste gdy model dopisze tekst)
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i >= 0 && j > i) {
      const sub = s.slice(i, j + 1);
      try {
        return JSON.parse(sub);
      } catch {
        return null;
      }
    }
    return null;
  }
}

const CFG = {
  // Bump internal version to force rebuild of cached chunks after changing rendering (paragraph markers).
  // Note: field name in Mongo remains snapshot.text_chunks_v1 for backward compatibility.
  VERSION: 'text_chunks_v3_merge_one_liners',
  MIN_FIT: Number(process.env.LLM_CHUNK_MIN_FIT_RATIO || 0.6),

  // mode: deterministic|semantic|auto
  // default: deterministic (żeby nie odpalać LLM do chunkowania jeśli nie trzeba)
  CHUNK_MODE: envStr('LLM_CHUNK_MODE', 'deterministic'),
  CHUNKS_FORCE_REBUILD: envBool('LLM_CHUNKS_FORCE_REBUILD', false),

  // deterministic fallback
  TARGET_LINES_MIN: 18,
  TARGET_LINES_MAX: 28,
  MAX_LINES: envNum('LLM_CHUNK_MAX_LINES', 35),
  DET_FIXED_LINES: envNum('LLM_DET_CHUNK_LINES', 0),
  DET_OVERLAP: envNum('LLM_DET_CHUNK_OVERLAP', 0),

  // deterministic: paragraph/list aware chunking built from clean_lines
  // ON by default because it improves paragraph integrity without any site-specific rules.
  STRUCTURAL_REFLOW: envBool('LLM_STRUCTURAL_REFLOW', true),
  // safety net if clean_meta.params.wrapAt is missing
  REFLOW_WRAP_AT_FALLBACK: envNum('LLM_REFLOW_WRAP_AT', 140),
  // Merge short, single-line pseudo-paragraphs (often titles) into the next paragraph.
  // Helps reduce noisy [Pxxx] markers for headings captured as one-liners.
  MERGE_ONE_LINER_INTO_NEXT: envBool('LLM_MERGE_ONE_LINER_INTO_NEXT', true),
  MERGE_ONE_LINER_MAX_CHARS: envNum('LLM_MERGE_ONE_LINER_MAX_CHARS', 110),
  MERGE_ONE_LINER_MAX_WORDS: envNum('LLM_MERGE_ONE_LINER_MAX_WORDS', 14),
  MERGE_ONE_LINER_NEXT_MIN_CHARS: envNum('LLM_MERGE_ONE_LINER_NEXT_MIN_CHARS', 160),
  // chunk size controls (applied in addition to DET_FIXED_LINES)
  DET_MAX_CHARS: envNum('LLM_DET_CHUNK_MAX_CHARS', 2200),
  DET_MIN_CHARS: envNum('LLM_DET_CHUNK_MIN_CHARS', 900),

  // semantic ranges (LLM)
  SEMANTIC_TARGET_RANGES: envNum('LLM_SEMANTIC_RANGES', 0),
  SEMANTIC_MAX_LINES: envNum('LLM_SEMANTIC_MAX_LINES', 420),
  SEMANTIC_MAX_PROMPT_CHARS: envNum('LLM_SEMANTIC_MAX_PROMPT_CHARS', 22000),
  SEMANTIC_RETRY: envNum('LLM_SEMANTIC_RETRY', 1),
  SEMANTIC_FORCE_REBUILD: envBool('LLM_SEMANTIC_FORCE_REBUILD', false),
  SEMANTIC_MODEL:
    process.env.OLLAMA_CHUNK_MODEL ||
    process.env.OLLAMA_TEXT_MODEL ||
    process.env.LLM_MODEL ||
    'SpeakLeash/bielik-11b-v3.0-instruct:Q4_K_M',
};

function normalizeChunkMode(value) {
  const s = String(value || '').trim().toLowerCase();
  if (['det','deterministic','fixed'].includes(s)) return 'deterministic';
  if (['sem','semantic'].includes(s)) return 'semantic';
  return 'auto';
}

function chunkMode() {
  return normalizeChunkMode(CFG.CHUNK_MODE);
}

function semanticEnabledByConfig() {
  return Number.isFinite(CFG.SEMANTIC_TARGET_RANGES) && CFG.SEMANTIC_TARGET_RANGES > 0;
}

function semanticEnabled() {
  const m = chunkMode();
  if (m === 'deterministic') return false;
  if (m === 'semantic') return true;
  return semanticEnabledByConfig();
}

function chunksMethodFamily(method) {
  const m = String(method || '').trim().toLowerCase();
  if (m === 'deterministic') return 'deterministic';
  if (m === 'template') return 'template';
  if (m === 'semantic_ranges' || m === 'llm_ranges') return 'semantic';
  return 'other';
}

function shouldReuseCachedChunks(cached, textSha1) {
  if (!cached || typeof cached !== 'object') return false;
  if (!isValidChunksBlob(cached, textSha1)) return false;
  if (CFG.CHUNKS_FORCE_REBUILD || CFG.SEMANTIC_FORCE_REBUILD) return false;

  const mode = chunkMode();
  const fam = chunksMethodFamily(cached.method);

  if (mode === 'deterministic') return fam === 'deterministic';
  if (mode === 'semantic') return fam === 'semantic';

  // auto: if semantic disabled (LLM_SEMANTIC_RANGES=0), don't reuse old semantic caches
  if (!semanticEnabledByConfig()) return fam !== 'semantic';
  return true;
}

function pickSnapshotTextSource(snapshot) {
  // Treat DOM extraction similarly to OCR:
  // - prefer *clean_text* when available
  // - use *clean_lines* for stable line segmentation
  // Ordering (deterministic, no heuristics):
  //   extracted(clean) > ocr(clean) > extracted(raw) > ocr(raw)

  const domClean = String(snapshot?.extracted_v2?.clean_text || '').trim();
  if (domClean) return { source: 'extracted_v2_clean', text: domClean };

  // Fallback: if clean_lines exist but clean_text is missing for some reason.
  const domCleanLines = snapshot?.extracted_v2?.clean_lines;
  if (Array.isArray(domCleanLines) && domCleanLines.length) {
    const joined = domCleanLines.map((x) => String(x ?? '')).join('\n').trim();
    if (joined) return { source: 'extracted_v2_clean', text: joined };
  }

  const ocrClean = String(snapshot?.vision_ocr?.clean_text || '').trim();
  if (ocrClean) return { source: 'ocr_clean', text: ocrClean };

  const ocrCleanLines = snapshot?.vision_ocr?.clean_lines;
  if (Array.isArray(ocrCleanLines) && ocrCleanLines.length) {
    const joined = ocrCleanLines.map((x) => String(x ?? '')).join('\n').trim();
    if (joined) return { source: 'ocr_clean', text: joined };
  }

  const domRaw = String(snapshot?.extracted_v2?.text || '').trim();
  if (domRaw) return { source: 'extracted_v2', text: domRaw };

  const ocrRaw = String(snapshot?.vision_ocr?.text || '').trim();
  if (ocrRaw) return { source: 'ocr_raw', text: ocrRaw };

  return { source: null, text: '' };
}

function normalizeNewlinesToLines(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
}

function getCleanLines(snapshot, { source, text }) {
  // Prefer already cleaned line array if available (OCR or DOM).
  // This is crucial especially for DOM extractions where raw text may be a single huge line.

  const src = String(source || '').toLowerCase();

  let arr = null;
  if (src.startsWith('ocr')) {
    arr = snapshot?.vision_ocr?.clean_lines;
  } else if (src.startsWith('extracted_v2')) {
    arr = snapshot?.extracted_v2?.clean_lines;
  }

  let lines = Array.isArray(arr) && arr.length
    ? arr.map((x) => String(x ?? ''))
    : normalizeNewlinesToLines(text);

  // Trim only trailing empty lines for stable N.
  while (lines.length && String(lines[lines.length - 1]).trim() === '') lines.pop();
  return lines;
}

// ---------------- Paragraph markers --------------------------------------------------
// Goal: make paragraph boundaries explicit for downstream LLM tasks (e.g., "monitor paragraph 15").
// We treat paragraph boundaries deterministically based on clean_lines separators:
//   - empty line OR '<PARA>' => paragraph boundary

const PARA_TOKEN = '<PARA>';

function paraTag(n) {
  const v = Number(n);
  const s = Number.isFinite(v) && v > 0 ? String(Math.floor(v)) : '0';
  // minimum width 3, but allow growth (P1000...)
  return `[P${s.padStart(3, '0')}]`;
}

function computeParagraphIndexByLine(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const out = new Array(list.length).fill(null);
  let p = 0;
  let boundary = true;

  for (let i = 0; i < list.length; i++) {
    const raw = String(list[i] ?? '');
    const t = raw.trim();
    if (!t || t === PARA_TOKEN) {
      boundary = true;
      continue;
    }
    if (boundary) {
      p++;
      boundary = false;
    }
    out[i] = p;
  }
  return out;
}

function renderMarkedTextFromLinesRange(lines, paraByLine, from, to) {
  const list = Array.isArray(lines) ? lines : [];
  const N = list.length;
  if (!N) return '';

  const a = clamp(Number(from ?? 0), 0, N - 1);
  const b = clamp(Number(to ?? (N - 1)), 0, N - 1);
  if (b < a) return '';

  const out = [];
  for (let i = a; i <= b; i++) {
    const p = paraByLine?.[i];
    if (!p) continue;

    const raw = String(list[i] ?? '');
    const t = raw.trim();
    if (!t || t === PARA_TOKEN) continue;

    const prevP = i > 0 ? paraByLine?.[i - 1] : null;
    const needMarker = i === a || p !== prevP;
    out.push(needMarker ? `${paraTag(p)} ${t}` : t);
  }

  return out.join('\n').trim();
}

function renderMarkedTextFromText(text) {
  const lines = normalizeNewlinesToLines(text);
  const paraByLine = computeParagraphIndexByLine(lines);
  return renderMarkedTextFromLinesRange(lines, paraByLine, 0, lines.length - 1);
}

function deterministicLineChunksFromLines(lines, { maxLines = CFG.MAX_LINES, source = null } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const N = list.length;
  if (N === 0) return [];

  // Global paragraph numbering (1-based) across the whole lines array.
  const paraByLine = computeParagraphIndexByLine(list);

  // Fixed-size deterministic chunking (preferred when LLM_CHUNK_MODE=deterministic).
  // If LLM_DET_CHUNK_LINES>0, we ALWAYS use that exact chunk size (no content heuristics).
  const fixed = Number.isFinite(CFG.DET_FIXED_LINES) && CFG.DET_FIXED_LINES > 0 ? Math.floor(CFG.DET_FIXED_LINES) : null;
  const overlap = Number.isFinite(CFG.DET_OVERLAP) && CFG.DET_OVERLAP > 0 ? Math.floor(CFG.DET_OVERLAP) : 0;

  let target = fixed;
  if (!target) {
    // Backward-compatible auto sizing when fixed is not provided
    const approx = Math.ceil(N / Math.max(1, Math.round(N / 22)));
    target = clamp(approx, CFG.TARGET_LINES_MIN, CFG.TARGET_LINES_MAX);
  }

  target = clamp(target, 5, Math.max(5, maxLines));

  const chunks = [];
  let i = 0;
  while (i < N) {
    const from = i;
    const to = Math.min(N - 1, from + target - 1);
    const textPart = renderMarkedTextFromLinesRange(list, paraByLine, from, to);
    const id = 'c_lines_' + String(chunks.length).padStart(2, '0');
    chunks.push({
      id,
      key: null,
      title: 'Lines ' + (from + 1) + '-' + (to + 1),
      order: chunks.length,
      from,
      to,
      sha1: sha1(textPart),
      text: textPart,
      len: textPart.length,
      source,
    });
    const next = (to + 1) - overlap;
    i = next > from ? next : (to + 1);
  }
  return chunks;
}

// --- Structural paragraph/list reflow for clean_lines ---------------------------------
// Goal: deterministically merge "wrapAt"-wrapped lines back into pseudo-paragraphs,
// while keeping headings/lists as hard boundaries.

function isHeadingLine(t) {
  return /^#{1,6}\s+\S/.test(t);
}

function isListItemLine(t) {
  return /^(?:[-*•]|\d+\.|\d+\))\s+\S/.test(t);
}

function isStandaloneTokenLine(t) {
  const x = t.trim().toLowerCase();
  return x === '[toc]' || x === 'toc';
}

function endsWithSentencePunct(t) {
  // Treat only strong sentence endings as hard stops (avoid over-splitting on commas).
  return /[.!?][\"'”’\)]?$/.test(t);
}

function joinSoft(a, b) {
  const left = String(a || '').trimEnd();
  const right = String(b || '').trimStart();
  if (!left) return right;
  if (!right) return left;

  // hyphenation at line end: "architek-" + "tura" => "architektura"
  if (/-$/.test(left) && !/\s-$/.test(left)) return left.replace(/-$/, '') + right;
  return left + ' ' + right;
}

function shouldJoinWrappedLine(prev, curr, wrapAt) {
  const p = String(prev || '').trimEnd();
  const c = String(curr || '').trim();
  if (!p || !c) return false;
  if (isHeadingLine(c) || isListItemLine(c) || isStandaloneTokenLine(c)) return false;
  if (endsWithSentencePunct(p)) return false;

  // Join if prev line looks like it was wrapped (near wrapAt), or ends with a soft-continuation symbol.
  const softEnd = /[,;:\/\(\[“„"'–—…]$/.test(p);
  if (softEnd) return true;

  const wa = Number.isFinite(wrapAt) && wrapAt > 0 ? wrapAt : 140;
  const threshold = Math.max(40, Math.floor(wa * 0.60));
  return p.length >= threshold;
}

function buildStructuralSegmentsFromLines(lines, { wrapAt = 140 } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const segs = [];

  const PARA = '<PARA>';

  let cur = null; // { type, from, to, text }

  function flush() {
    if (!cur) return;
    const text = String(cur.text || '').trim();
    if (text) segs.push({ from: cur.from, to: cur.to, text, type: cur.type || 'p' });
    cur = null;
  }

  for (let i = 0; i < list.length; i++) {
    const raw = String(list[i] ?? '');
    const t = raw.trim();
    if (!t || t === PARA) {
      flush();
      continue;
    }

    // Hard boundaries
    if (isHeadingLine(t) || isStandaloneTokenLine(t)) {
      flush();
      segs.push({ from: i, to: i, text: t, type: isHeadingLine(t) ? 'h' : 't' });
      continue;
    }

    // Lists: group consecutive list items as one segment (keeps list semantics, reduces noise)
    if (isListItemLine(t)) {
      if (!cur || cur.type !== 'list') {
        flush();
        cur = { type: 'list', from: i, to: i, text: t };
      } else {
        cur.to = i;
        cur.text = String(cur.text || '').trimEnd() + '\n' + t;
      }
      continue;
    }

    // Normal paragraph text
    if (!cur) {
      cur = { type: 'p', from: i, to: i, text: t };
      continue;
    }

    if (cur.type === 'p' && shouldJoinWrappedLine(cur.text, t, wrapAt)) {
      cur.to = i;
      cur.text = joinSoft(cur.text, t);
      continue;
    }

    // Otherwise start a new paragraph
    flush();
    cur = { type: 'p', from: i, to: i, text: t };
  }

  flush();
  return segs;
}


function mergeOneLinersIntoNext(segs, cfg = CFG) {
  // Improved merge strategy:
  // - Buffer consecutive short, single-line segments (including headings/tokens).
  // - Merge the whole buffer into the NEXT segment that looks like a real paragraph
  //   (multi-line OR length >= MERGE_ONE_LINER_NEXT_MIN_CHARS).
  // This prevents '1-liner + 1-liner => 2-liner' artifacts.

  const maxChars = cfg.MERGE_ONE_LINER_MAX_CHARS;
  const maxWords = cfg.MERGE_ONE_LINER_MAX_WORDS;
  const nextMinChars = cfg.MERGE_ONE_LINER_NEXT_MIN_CHARS;

  const normalize = (t) => String(t ?? '').trim();
  const wordCount = (t) => normalize(t).split(/\s+/).filter(Boolean).length;

  const isSingleLine = (t) => !t.includes('\n');

  // We buffer anything that would become a "meaningless" one-liner paragraph.
  // For paragraphs/lists: treat as "short" if it's single-line and below nextMinChars.
  // For headings/tokens: always buffer.
  const shouldBuffer = (seg) => {
    const text = normalize(seg.text);
    if (!text) return false;

    if (seg.type === 'h' || seg.type === 't') return true;

    if (!isSingleLine(text)) return false;

    if (seg.type === 'p' || seg.type === 'list') {
      // Keep legacy guardrails: only buffer very small one-liners, OR anything below nextMinChars.
      // (nextMinChars is the "find a real paragraph" threshold.)
      const wc = wordCount(text);
      const isVerySmall = text.length <= maxChars && wc <= maxWords;
      const isBelowAnchor = text.length < nextMinChars;
      return isVerySmall || isBelowAnchor;
    }

    return false;
  };

  const isAnchor = (seg) => {
    const text = normalize(seg.text);
    if (!text) return false;

    // Multi-line (lists, wrapped paragraphs) is always a safe anchor.
    if (!isSingleLine(text)) return true;

    // Long enough single-line paragraph/list.
    if (seg.type === 'p' || seg.type === 'list') {
      return text.length >= nextMinChars;
    }

    // Other types: treat as anchor to avoid buffering forever.
    return true;
  };

  const out = [];
  let pending = [];
  let pendingFrom = null;
  let pendingTo = null;

  const pendingText = () => pending.map((p) => normalize(p.text)).filter(Boolean).join('\n');
  const resetPending = () => {
    pending = [];
    pendingFrom = null;
    pendingTo = null;
  };

  for (const seg of segs) {
    if (shouldBuffer(seg)) {
      pending.push(seg);
      if (pendingFrom === null) pendingFrom = seg.from;
      pendingTo = seg.to;
      continue;
    }

    if (pending.length) {
      // If we still haven't reached an anchor, keep buffering even "medium" segments.
      // This matches the intention: merge small paragraphs only into a real paragraph.
      if (!isAnchor(seg)) {
        pending.push(seg);
        if (pendingFrom === null) pendingFrom = seg.from;
        pendingTo = seg.to;
        continue;
      }

      const prefix = pendingText();
      out.push({
        ...seg,
        from: pendingFrom ?? seg.from,
        to: seg.to,
        text: prefix ? `${prefix}\n${normalize(seg.text)}` : normalize(seg.text),
      });
      resetPending();
      continue;
    }

    out.push(seg);
  }

  // Trailing pending: append to previous anchor to avoid leaving one-liners at the end.
  if (pending.length) {
    const t = pendingText();
    if (t) {
      if (!out.length) {
        out.push({
          ...pending[pending.length - 1],
          type: 'p',
          from: pendingFrom ?? 0,
          to: pendingTo ?? pending[pending.length - 1].to,
          text: t,
        });
      } else {
        // Prefer appending to the last non-token segment.
        let idx = out.length - 1;
        if (out[idx].type === 't' && out.length >= 2) idx = out.length - 2;

        const last = out[idx];
        out[idx] = {
          ...last,
          to: pendingTo ?? last.to,
          text: `${normalize(last.text)}\n${t}`.trim(),
        };

        // If we skipped a trailing token, fold it in too (so it doesn't remain a one-liner).
        if (idx === out.length - 2 && out[out.length - 1].type === 't') {
          const tok = out.pop();
          out[idx] = {
            ...out[idx],
            to: tok.to,
            text: `${normalize(out[idx].text)}\n${normalize(tok.text)}`.trim(),
          };
        }
      }
    }
  }

  return out;
}

function deterministicStructuredChunksFromLines(
  lines,
  {
    maxLines = CFG.MAX_LINES,
    source = null,
    wrapAt = 140,
  } = {}
) {
  const list = Array.isArray(lines) ? lines : [];
  const N = list.length;
  if (N === 0) return [];

  let segs = buildStructuralSegmentsFromLines(list, { wrapAt });
  segs = mergeOneLinersIntoNext(segs);
  if (!segs.length) return deterministicLineChunksFromLines(list, { maxLines, source });

  // Assign global (document-level) paragraph indices to segments.
  const segsWithPara = segs.map((s, idx) => ({ ...s, _p: idx + 1 }));

  // Packing policy: aim for ~DET_MAX_CHARS per chunk, but never exceed maxLines (safety).
  const maxChars = clamp(Math.floor(CFG.DET_MAX_CHARS || 2200), 600, 10000);
  const minChars = clamp(Math.floor(CFG.DET_MIN_CHARS || 900), 0, maxChars);
  const overlap = Number.isFinite(CFG.DET_OVERLAP) && CFG.DET_OVERLAP > 0 ? Math.floor(CFG.DET_OVERLAP) : 0;
  const fixedSegs = Number.isFinite(CFG.DET_FIXED_LINES) && CFG.DET_FIXED_LINES > 0 ? Math.floor(CFG.DET_FIXED_LINES) : null;

  const totalChars = segsWithPara.reduce((sum, s) => sum + String(s.text || '').length + 2, 0);
  const desiredChunks = clamp(Math.ceil(totalChars / maxChars), 1, 50);
  const targetChars = desiredChunks > 0 ? Math.ceil(totalChars / desiredChunks) : maxChars;

  const chunks = [];
  let i = 0;

  while (i < segsWithPara.length) {
    const start = i;
    let end = i;
    let curChars = 0;
    let segCount = 0;

    while (end < segsWithPara.length) {
      const add = String(segsWithPara[end].text || '');
      const addLen = add.length + (segCount ? 2 : 0);
      const nextChars = curChars + addLen;

      const wouldExceedChars = segCount > 0 && nextChars > maxChars;
      const wouldExceedSegs = fixedSegs ? (segCount >= fixedSegs) : (segCount >= maxLines);

      if (wouldExceedSegs) break;
      if (wouldExceedChars) break;

      curChars = nextChars;
      segCount++;
      end++;

      // soft stop: if we're past target (and not too small), stop at boundary
      if (curChars >= targetChars && curChars >= minChars) break;
    }

    // Ensure progress
    if (end <= start) end = start + 1;

    const segSlice = segsWithPara.slice(start, end);
    // Render paragraphs explicitly: each segment starts with [Pxxx].
    const textPart = segSlice.map((s) => `${paraTag(s._p)} ${s.text}`).join('\n');
    const from = segSlice[0].from;
    const to = segSlice[segSlice.length - 1].to;
    const id = 'c_lines_' + String(chunks.length).padStart(2, '0');

    chunks.push({
      id,
      key: null,
      title: 'Lines ' + (from + 1) + '-' + (to + 1),
      order: chunks.length,
      from,
      to,
      sha1: sha1(textPart),
      text: textPart,
      len: textPart.length,
      source,
    });

    // advance with overlap in *segments*
    const nextStart = Math.max(start + 1, end - overlap);
    i = nextStart;
  }

  return chunks;
}

function isValidChunksBlob(blob, textSha1) {
  if (!blob || typeof blob !== 'object') return false;
  if (blob.version !== CFG.VERSION) return false;
  if (!blob.text_sha1 || blob.text_sha1 !== textSha1) return false;
  if (!Array.isArray(blob.chunks) || blob.chunks.length < 1) return false;
  for (const c of blob.chunks) {
    if (!c || typeof c !== 'object') return false;
    if (!c.id || typeof c.id !== 'string') return false;
    if (typeof c.order !== 'number') return false;
    if (!c.sha1 || typeof c.sha1 !== 'string') return false;
    if (typeof c.text !== 'string') return false;
  }
  return true;
}

function normalizeLinesForFallback(text) {
  const t = String(text || '');
  let lines = t.split(/\r?\n/);

  // If it's basically one long line (common in extracted_v2), make "pseudo-lines" deterministically.
  if (lines.length <= 2) {
    lines = t
      .split(/\s*\|\s*|(?<=[.!?])\s+/g)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  // Keep original ordering; drop only fully-empty trailing noise
  return lines.map((x) => String(x));
}

// Backward-compatible wrapper (text -> lines)
function deterministicLineChunks(text, { maxLines = CFG.MAX_LINES, source = null } = {}) {
  const lines = normalizeNewlinesToLines(text);
  return deterministicLineChunksFromLines(lines, { maxLines, source });
}

function validateRanges(chunks, N) {
  const errors = [];
  if (!Array.isArray(chunks) || !chunks.length) return { ok: false, errors: ['chunks_empty'] };

  const norm = chunks
    .map((c) => ({
      id: c?.id,
      title: c?.title,
      from: Number(c?.from),
      to: Number(c?.to),
    }))
    .filter((c) => Number.isInteger(c.from) && Number.isInteger(c.to));

  if (!norm.length) return { ok: false, errors: ['chunks_no_valid_ranges'] };

  norm.sort((a, b) => a.from - b.from);

  if (norm[0].from !== 0) errors.push(`first_from_not_0:${norm[0].from}`);
  if (norm[norm.length - 1].to !== N - 1) errors.push(`last_to_not_Nminus1:${norm[norm.length - 1].to}!=${N - 1}`);

  let expectedFrom = 0;
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c.from < 0 || c.to < 0 || c.from > c.to || c.to >= N) errors.push(`range_out_of_bounds:${c.from}-${c.to}`);
    if (c.from !== expectedFrom) {
      if (c.from > expectedFrom) errors.push(`hole:${expectedFrom}..${c.from - 1}`);
      else errors.push(`overlap_or_unsorted:expected_from=${expectedFrom}, got=${c.from}`);
    }
    expectedFrom = c.to + 1;
  }
  if (expectedFrom !== N) errors.push(`coverage_end_mismatch:expected_end=${expectedFrom}, N=${N}`);

  return { ok: errors.length === 0, errors, norm };
}

function buildSemanticSystemPrompt({ targetChunks, N }) {
  const minC = clamp(targetChunks - 2, 2, 64);
  const maxC = clamp(targetChunks + 2, minC, 64);
  return [
    'You are a strict semantic chunker.',
    'You receive lines of text with integer indices from 0..N-1.',
    'Return ONLY valid JSON (no markdown, no commentary).',
    '',
    'You MUST output chunks covering ALL lines with NO holes and NO overlaps.',
    'Rules:',
    '- from/to are INCLUSIVE.',
    '- First chunk must have from=0.',
    `- Last chunk must have to=${N - 1}.`,
    '- Chunks must be sorted by from ascending.',
    '- No gaps: next.from must equal prev.to+1.',
    '- No overlaps: a line cannot belong to two chunks.',
    '- title must describe the chunk and be derived from its content (do not invent).',
    '',
    `Try to produce around ${targetChunks} chunks (allowed range: ${minC}..${maxC}).`,
    '',
    'Output schema:',
    '{ "chunks": [ { "id": string, "title": string, "from": number, "to": number } ] }',
  ].join('\n');
}

function buildSemanticPrompt(lines) {
  const list = lines.map((t, i) => ({ i, t: String(t ?? '') }));
  return [`N=${lines.length}`, 'LINES:', JSON.stringify(list)].join('\n');
}

function buildSemanticRepairPrompt(lines, errors) {
  return [
    `N=${lines.length}`,
    'LINES:',
    JSON.stringify(lines.map((t, i) => ({ i, t: String(t ?? '') }))),
    '',
    'Your previous JSON was invalid.',
    `VALIDATION_ERRORS: ${JSON.stringify(errors)}`,
    '',
    'Fix it and return ONLY valid JSON with schema:',
    '{ "chunks": [ { "id": string, "title": string, "from": number, "to": number } ] }',
  ].join('\n');
}

function rebuildChunksFromRanges(lines, ranges, source) {
  const paraByLine = computeParagraphIndexByLine(lines);
  const usedKeys = new Map();
  const out = [];

  for (let order = 0; order < ranges.length; order++) {
    const r = ranges[order];
    const slice = lines.slice(r.from, r.to + 1);
    const raw = renderMarkedTextFromLinesRange(lines, paraByLine, r.from, r.to);

    const firstNonEmpty = slice.find((l) => {
      const t = String(l || '').trim();
      return t && t !== PARA_TOKEN;
    }) || '';
    const baseTitle = String(r.title || '').trim() || excerpt(firstNonEmpty, 72) || `Chunk ${order + 1}`;
    const keyBase = slugifyKey(baseTitle, { maxLen: 32 });
    const n = (usedKeys.get(keyBase) || 0) + 1;
    usedKeys.set(keyBase, n);

    const key = n === 1 ? keyBase : `${keyBase}_${n}`;
    const id = `c_${key}_${String(order).padStart(2, '0')}`;

    out.push({
      id,
      key,
      title: baseTitle,
      order,
      from: r.from,
      to: r.to,
      sha1: sha1(raw),
      text: raw,
      len: raw.length,
      source,
    });
  }

  return out;
}

async function semanticLineRangeChunks(snapshot, { logger, source, text }) {
  const log = logger || console;
  const lines = getCleanLines(snapshot, { source, text });
  const N = lines.length;
  if (!N) return { ok: false, reason: 'no_lines', chunks: [] };

  if (N > CFG.SEMANTIC_MAX_LINES) {
    return { ok: false, reason: `too_many_lines:${N}>${CFG.SEMANTIC_MAX_LINES}`, chunks: [] };
  }

  const targetChunks = clamp(Math.round(CFG.SEMANTIC_TARGET_RANGES || 8), 2, 32);
  const system = buildSemanticSystemPrompt({ targetChunks, N });
  const prompt = buildSemanticPrompt(lines);
  if (prompt.length > CFG.SEMANTIC_MAX_PROMPT_CHARS) {
    return { ok: false, reason: `prompt_too_big:${prompt.length}>${CFG.SEMANTIC_MAX_PROMPT_CHARS}`, chunks: [] };
  }

  const call = async (p) => generateTextWithOllama({
    model: CFG.SEMANTIC_MODEL,
    system,
    prompt: p,
    format: 'json',
    temperature: 0,
    options: { top_k: 1, top_p: 1, seed: 42 },
    stream: false,
    logger: log,
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS_CHUNKER || process.env.OLLAMA_TIMEOUT_MS || 180000),
  });

  let raw = await call(prompt);
  let parsed = safeJsonParse(raw);
  let ranges = parsed?.chunks;

  let v = validateRanges(ranges, N);
  if (!v.ok && CFG.SEMANTIC_RETRY > 0) {
    const repairPrompt = buildSemanticRepairPrompt(lines, v.errors);
    raw = await call(repairPrompt);
    parsed = safeJsonParse(raw);
    ranges = parsed?.chunks;
    v = validateRanges(ranges, N);
  }

  if (!v.ok) {
    log?.warn?.('semantic_chunker_invalid', {
      snapshotId: snapshot?._id?.toString?.() || null,
      source,
      N,
      errors: v.errors,
      model: CFG.SEMANTIC_MODEL,
    });
    return { ok: false, reason: 'invalid_ranges', chunks: [] };
  }

  
  // If the model returns a single range for a large input, we fallback to deterministic chunking.
  const multiThreshold = Math.max(CFG.MAX_LINES * 2, 60);
  if (Array.isArray(v.norm) && v.norm.length === 1 && N >= multiThreshold) {
    log?.warn?.('semantic_chunker_single_chunk_fallback', {
      snapshotId: snapshot?._id?.toString?.() || null,
      source,
      N,
      multiThreshold,
      model: CFG.SEMANTIC_MODEL,
    });
    return { ok: false, reason: 'single_range_for_large_input', chunks: [] };
  }
  const chunks = rebuildChunksFromRanges(lines, v.norm, source);
  return { ok: true, reason: null, chunks };
}

/**
 * ensureSnapshotChunks(snapshot, opts)
 * - chooses source text (extracted_v2_clean > ocr_clean > extracted_v2 > ocr_raw)
 * - caches as snapshot.text_chunks_v1 in Mongo
 * - semantic ranges if enabled, else template-based if fits, else deterministic fallback
 */
export async function ensureSnapshotChunks(snapshot, opts = {}) {
  const {
    logger,
    chunkTemplate = null,
    updateMongo = true,
    minFit = CFG.MIN_FIT,
  } = opts;

  const log = logger || console;

  if (!snapshot || typeof snapshot !== 'object' || !snapshot._id) {
    throw new Error('ensureSnapshotChunks: snapshot missing _id');
  }

  const picked = pickSnapshotTextSource(snapshot);
  const source = picked?.source || null;
  const baseText = picked?.text || '';

  // Always build a canonical "chunking text" from clean_lines when available.
  // This makes DOM behave like OCR (stable segmentation by lines).
  const lines = getCleanLines(snapshot, { source, text: baseText });
  const canonicalText = lines.join('\n');
  const canonicalTrim = canonicalText.trim();

  if (!canonicalTrim) {
    return {
      version: CFG.VERSION,
      source,
      text_sha1: null,
      createdAt: new Date(),
      method: 'empty',
      template_fit_ratio: null,
      chunks: [],
    };
  }

  const textForChunking = canonicalText;
  const textSha1 = sha1(canonicalTrim);

  // cache hit (o ile nie wymuszasz rebuild)
  const cached = snapshot?.text_chunks_v1;
  if (shouldReuseCachedChunks(cached, textSha1)) {
    log?.info?.('snapshot_chunks_cache_hit', {
      snapshotId: snapshot._id?.toString?.() || null,
      source,
      chunks: cached.chunks.length,
      text_sha1: String(textSha1 || '').slice(0, 8),
      method: cached.method || null,
    });
    return { ...cached, _cache: { hit: true } };
  }

  let method = 'deterministic';
  let fitRatio = null;
  let chunked = null;

  const mode = chunkMode();

  // 0) semantic ranges (LLM) if enabled
  if (mode !== 'deterministic' && semanticEnabled()) {
    const sem = await semanticLineRangeChunks(snapshot, { logger: log, source, text: textForChunking });
    if (sem.ok && Array.isArray(sem.chunks) && sem.chunks.length) {
      method = 'llm_ranges';
      chunked = sem.chunks;
    } else {
      log?.info?.('semantic_chunker_skip_or_fail', {
        snapshotId: snapshot._id?.toString?.() || null,
        source,
        reason: sem.reason,
        enabled: true,
      });
    }
  }

  // 1) template-based if fits (only if semantic not used)
  if (mode !== 'deterministic' && !chunked && chunkTemplate) {
    try {
      fitRatio = scoreTemplateFit(textForChunking, chunkTemplate);
      if (typeof fitRatio === 'number' && fitRatio >= minFit) {
        const t = extractChunksByTemplate(textForChunking, chunkTemplate);
        if (t?.ok && Array.isArray(t.chunks) && t.chunks.length) {
          method = 'template';
          chunked = t.chunks.map((c, idx) => {
            const key = String(c.key || c.id || '').trim() || null;
            const stableId = key ? `c_${key}` : `c_tpl_${String(idx).padStart(2, '0')}`;
            const markedText = renderMarkedTextFromText(String(c.text || ''));
            return {
              id: stableId,
              key,
              title: c.title || key || `Chunk ${idx + 1}`,
              order: idx,
              from: null,
              to: null,
              sha1: c.sha1 || sha1(markedText || ''),
              text: markedText,
              len: Number(c.len || (markedText || '').length || 0),
              source,
            };
          });
        }
      } else {
        log?.info?.('snapshot_chunks_template_skip', {
          snapshotId: snapshot._id?.toString?.() || null,
          source,
          fitRatio: typeof fitRatio === 'number' ? Number(fitRatio.toFixed(3)) : null,
          minFit,
        });
      }
    } catch (e) {
      log?.warn?.('snapshot_chunks_template_failed', {
        snapshotId: snapshot._id?.toString?.() || null,
        source,
        error: e?.message || String(e),
      });
    }
  }

  // 2) deterministic fallback
  if (!chunked) {
    const wrapAt = snapshot?.clean_meta?.params?.wrapAt || CFG.REFLOW_WRAP_AT_FALLBACK;
    chunked = CFG.STRUCTURAL_REFLOW
      ? deterministicStructuredChunksFromLines(lines, {
          source,
          wrapAt,
          maxLines: CFG.MAX_LINES,
        })
      : deterministicLineChunksFromLines(lines, { maxLines: CFG.MAX_LINES, source });
    method = 'deterministic';
  }

  const doc = {
    version: CFG.VERSION,
    source,
    text_sha1: textSha1,
    createdAt: new Date(),
    method,
    template_fit_ratio: fitRatio,
    chunks: chunked,
  };

  if (updateMongo) {
    try {
      await ensureMongoConnected();
      await snapshotsCol.updateOne({ _id: snapshot._id }, { $set: { text_chunks_v1: doc } });
      snapshot.text_chunks_v1 = doc;
    } catch (err) {
      log?.warn?.('snapshot_chunks_mongo_update_failed', {
        snapshotId: snapshot._id?.toString?.() || null,
        error: String(err?.message || err),
      });
    }
  }

  log?.info?.('snapshot_chunks_ready', {
    snapshotId: snapshot._id?.toString?.() || null,
    source,
    method,
    chunks: Array.isArray(doc.chunks) ? doc.chunks.length : 0,
    char_count: textForChunking.length,
    text_sha1: String(textSha1 || '').slice(0, 8),
  });

  return { ...doc, _cache: { hit: false } };
}

export function getSnapshotChunks(snapshot) {
  const blob = snapshot?.text_chunks_v1;
  if (!blob || typeof blob !== 'object') return null;
  if (!Array.isArray(blob.chunks) || blob.chunks.length < 1) return null;
  return blob;
}

// Backward compatibility (część kodu miała import buildChunksSnapshotu)
export const buildChunksSnapshotu = ensureSnapshotChunks;

