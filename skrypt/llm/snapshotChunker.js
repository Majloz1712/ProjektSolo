// skrypt/llm/snapshotChunker.js
// Deterministic (non-LLM) chunking on snapshot text + stable-id matching + per-chunk diff.

import crypto from 'node:crypto';

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function sha1Hex(value) {
  return crypto.createHash('sha1').update(String(value ?? '')).digest('hex');
}

function stableChunkId({ source, index, fingerprint }) {
  return `c_${sha1Hex(`${source}:${index}:${fingerprint}`).slice(0, 12)}`;
}

function normalizeWhitespace(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function excerpt(text, maxChars = 220) {
  const s = normalizeWhitespace(text);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

function safeSplitLines(text) {
  const raw = String(text ?? '');
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  return lines.map((l) => l.replace(/[ \t]+$/g, ''));
}

function splitVeryLongLine(line, maxLen) {
  const out = [];
  let i = 0;
  const s = String(line ?? '');
  while (i < s.length) {
    out.push(s.slice(i, i + maxLen));
    i += maxLen;
  }
  return out.length ? out : [''];
}

function tokenizeNonNumeric(text) {
  const s = String(text ?? '').toLowerCase();
  const re = /[\p{L}\p{N}]+/gu;
  const tokens = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const t = m[0];
    if (!t) continue;
    if (/^[\p{N}]+$/u.test(t)) continue;
    tokens.push(t);
  }
  return tokens;
}

function simhash64(tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);

  const weights = new Array(64).fill(0);

  for (const [tok, w] of counts.entries()) {
    const h = crypto.createHash('sha1').update(tok).digest();
    let x = 0n;
    for (let i = 0; i < 8; i++) {
      x = (x << 8n) | BigInt(h[i]);
    }
    for (let b = 0; b < 64; b++) {
      const bit = (x >> BigInt(63 - b)) & 1n;
      weights[b] += bit === 1n ? w : -w;
    }
  }

  let out = 0n;
  for (let b = 0; b < 64; b++) {
    if (weights[b] >= 0) out |= 1n << BigInt(63 - b);
  }
  return out;
}

function simhashToHex(sh) {
  const hex = sh.toString(16);
  return hex.padStart(16, '0');
}

function hexToBigInt64(hex) {
  const h = String(hex ?? '').replace(/^0x/i, '');
  if (!h) return 0n;
  return BigInt(`0x${h}`);
}

function popcountBigInt(x) {
  let v = x;
  let c = 0;
  while (v) {
    v &= v - 1n;
    c++;
  }
  return c;
}

function simhashSimilarity(fpHexA, fpHexB) {
  const a = hexToBigInt64(fpHexA);
  const b = hexToBigInt64(fpHexB);
  const dist = popcountBigInt(a ^ b);
  return 1 - dist / 64;
}

function extractNumbers(text) {
  const s = String(text ?? '');
  const out = [];
  const re = /-?\d{1,3}(?:[ \u00A0]\d{3})*(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/g;
  const matches = s.match(re) || [];
  for (let raw of matches) {
    raw = raw.replace(/[ \u00A0]/g, '');
    if (!raw) continue;

    const hasDot = raw.includes('.');
    const hasComma = raw.includes(',');
    if (hasDot && hasComma) {
      const lastDot = raw.lastIndexOf('.');
      const lastComma = raw.lastIndexOf(',');
      const decPos = Math.max(lastDot, lastComma);
      let intPart = raw.slice(0, decPos);
      let fracPart = raw.slice(decPos + 1);
      intPart = intPart.replace(/[.,]/g, '');
      raw = `${intPart}.${fracPart}`;
    } else if (hasComma && !hasDot) {
      raw = raw.replace(/,/g, '.');
    }

    const num = Number.parseFloat(raw);
    if (Number.isFinite(num)) out.push(num);
  }
  out.sort((a, b) => a - b);
  return out;
}

function multisetJaccard(aVals, bVals) {
  const round2 = (x) => Math.round(x * 100) / 100;
  const toKey = (x) => String(round2(x));

  const a = new Map();
  const b = new Map();
  for (const x of aVals || []) a.set(toKey(x), (a.get(toKey(x)) || 0) + 1);
  for (const x of bVals || []) b.set(toKey(x), (b.get(toKey(x)) || 0) + 1);

  let inter = 0;
  let uni = 0;

  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const ca = a.get(k) || 0;
    const cb = b.get(k) || 0;
    inter += Math.min(ca, cb);
    uni += Math.max(ca, cb);
  }
  if (uni === 0) return 1;
  return inter / uni;
}

export function buildDeterministicChunksFromText(
  text,
  { source, maxCharsPerChunk, maxLinesPerChunk, overlapLines } = {},
) {
  const src = source === 'extracted' ? 'extracted' : 'ocr';
  const maxChars = Number(maxCharsPerChunk || process.env.DET_CHUNK_MAX_CHARS || 1800);
  const maxLines = Number(maxLinesPerChunk || process.env.DET_CHUNK_MAX_LINES || 35);
  const overlap = Number(overlapLines || process.env.DET_CHUNK_OVERLAP_LINES || 5);

  const raw = String(text ?? '');
  const lines0 = safeSplitLines(raw);
  const lines = [];
  for (const l of lines0) {
    if (l.length > maxChars) lines.push(...splitVeryLongLine(l, maxChars));
    else lines.push(l);
  }

  const chunks = [];
  let buf = [];
  let bufChars = 0;
  let index = 0;

  const flush = () => {
    const trimmed = buf.join('\n').trim();
    if (!trimmed) {
      buf = [];
      bufChars = 0;
      return;
    }
    const titleLine = buf.find((x) => String(x).trim().length > 0) || null;
    const title = titleLine ? String(titleLine).trim().slice(0, 60) : null;

    const tokens = tokenizeNonNumeric(trimmed);
    const fp = simhashToHex(simhash64(tokens));
    const numbers = extractNumbers(trimmed);

    chunks.push({
      id: stableChunkId({ source: src, index, fingerprint: fp }),
      source: src,
      index,
      title,
      text: trimmed,
      fingerprint: fp,
      numbers,
    });

    if (overlap > 0) {
      const keep = buf.slice(Math.max(0, buf.length - overlap));
      buf = keep;
      bufChars = keep.reduce((acc, l) => acc + String(l).length + 1, 0);
    } else {
      buf = [];
      bufChars = 0;
    }
    index++;
  };

  for (const line of lines) {
    const l = String(line ?? '');
    const projectedChars = bufChars + l.length + 1;
    const projectedLines = buf.length + 1;

    if (buf.length > 0 && (projectedChars > maxChars || projectedLines > maxLines)) {
      flush();
    }

    buf.push(l);
    bufChars += l.length + 1;

    if (bufChars > maxChars || buf.length >= maxLines) flush();
  }

  if (buf.length) flush();
  return chunks;
}

export function matchChunksStableIds(prevChunks, newChunks, { minSimilarity } = {}) {
  const minSim = Number(minSimilarity || process.env.DET_CHUNK_MATCH_MIN_SIM || 0.75);

  const prevBySource = new Map();
  for (const pc of prevChunks || []) {
    if (!pc || !pc.id) continue;
    const src = pc.source || 'ocr';
    if (!prevBySource.has(src)) prevBySource.set(src, []);
    prevBySource.get(src).push(pc);
  }

  const usedPrev = new Set();
  const mapping = {}; // oldId -> newId

  const matchedChunks = (newChunks || []).map((nc) => {
    const src = nc?.source || 'ocr';
    const candidates = prevBySource.get(src) || [];
    let best = null;
    let bestSim = -1;

    for (const pc of candidates) {
      if (!pc?.id || usedPrev.has(pc.id)) continue;
      const sim = simhashSimilarity(pc.fingerprint, nc.fingerprint);
      if (sim > bestSim) {
        bestSim = sim;
        best = pc;
      }
    }

    if (best && bestSim >= minSim) {
      const oldId = best.id;
      usedPrev.add(oldId);
      mapping[oldId] = oldId;
      return { ...nc, id: oldId };
    }

    const fallbackId =
      nc?.id || stableChunkId({ source: src, index: nc?.index ?? 0, fingerprint: nc?.fingerprint ?? '' });
    mapping[fallbackId] = fallbackId;
    return { ...nc, id: fallbackId };
  });

  return { matchedChunks, mapping };
}

export function computeChunkDiffScores(prevChunks, newChunks, { numericWeight, threshold, maxForJudge } = {}) {
  const w = Number(numericWeight || process.env.DET_CHUNK_NUMERIC_WEIGHT || 2.0);
  const th = Number(threshold || process.env.DET_CHUNK_DIFF_THRESHOLD || 0.10);
  const limit = Number(maxForJudge || process.env.DET_CHUNK_MAX_FOR_JUDGE || 8);

  const prevById = new Map();
  for (const c of prevChunks || []) if (c?.id) prevById.set(String(c.id), c);

  const newById = new Map();
  for (const c of newChunks || []) if (c?.id) newById.set(String(c.id), c);

  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, pc] of prevById.entries()) {
    if (!newById.has(id)) removed.push({ id, title: pc.title || null, before_preview: excerpt(pc.text, 220) });
  }

  for (const [id, nc] of newById.entries()) {
    const pc = prevById.get(id);
    if (!pc) {
      added.push({ id, title: nc.title || null, after_preview: excerpt(nc.text, 220) });
      continue;
    }

const sim = simhashSimilarity(pc.fingerprint, nc.fingerprint);
const delta = clamp01(1 - sim);


    const numSim = multisetJaccard(pc.numbers || [], nc.numbers || []);
    const numericDelta = clamp01(1 - numSim);

    const diffScore = clamp01(Math.max(delta, clamp01(numericDelta * w)));

    if (diffScore >= th) {
      changed.push({
        id,
        title: nc.title || pc.title || null,
        similarity: sim,
        delta,
        numericDelta,
        diffScore,
        before_preview: excerpt(pc.text, 220),
        after_preview: excerpt(nc.text, 220),
      });
    }
  }

  changed.sort((a, b) => (b.diffScore ?? 0) - (a.diffScore ?? 0));
  const changed_for_judge = changed.slice(0, limit);

  return {
    mode: 'deterministic_v1',
    changedChunks: changed.length,
    nowChunks: (newChunks || []).length,
    significant: changed.length > 0 || added.length > 0 || removed.length > 0,
    changed,
    added,
    removed,
    changed_for_judge,
  };
}
