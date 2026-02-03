// skrypt/llm/analysisUtils.js
// Utils used across pipeline: sanitization, hashing, stable keys, small text helpers.

import crypto from 'node:crypto';

export function sanitizeNullableString(value) {
  const s = (value ?? '').toString().trim();
  return s.length ? s : null;
}

// Backwards-compatible alias used across the codebase.
export function normalizeUserPrompt(value) {
  return sanitizeNullableString(value);
}


export function sanitizeRequiredString(value, fallback = '') {
  const s = (value ?? '').toString().trim();
  return s.length ? s : fallback;
}

export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function clampText(value, maxChars = 8000) {
  const s = String(value ?? '');
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n...[TRUNCATED]';
}

export function excerpt(value, maxChars = 220) {
  const s = normalizeWhitespace(value);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

export function sha1(value) {
  const s = String(value ?? '');
  if (!s) return null;
  return crypto.createHash('sha1').update(s).digest('hex');
}

export function hashUserPrompt(userPrompt) {
  const s = sanitizeNullableString(userPrompt);
  return s ? sha1(s) : null;
}

// Create stable keys for chunks / extracted fields.
export function slugifyKey(value, { maxLen = 48 } = {}) {
  const s = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '') // combining marks (if any)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  const out = s || 'chunk';
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}

export function stableJsonStringify(value) {
  // Deterministic JSON stringify (objects keys sorted).
  const seen = new WeakSet();
  const walk = (v) => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return null;
      seen.add(v);
      if (Array.isArray(v)) return v.map(walk);
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

// ---------------- Evidence snippet helpers ----------------

function uniqRanges(ranges) {
  const out = [];
  for (const r of ranges || []) {
    if (!r) continue;
    const start = Math.max(0, Number(r.start || 0));
    const end = Math.max(start, Number(r.end || 0));
    const overlaps = out.some((x) => !(end <= x.start || start >= x.end));
    if (!overlaps) out.push({ start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

function commonPrefixLen(a, b) {
  const A = String(a ?? '');
  const B = String(b ?? '');
  const n = Math.min(A.length, B.length);
  let i = 0;
  while (i < n && A.charCodeAt(i) === B.charCodeAt(i)) i++;
  return i;
}

function commonSuffixLen(a, b, prefixLen) {
  const A = String(a ?? '');
  const B = String(b ?? '');
  const max = Math.min(A.length, B.length);
  let i = 0;
  while (
    i < max - prefixLen &&
    A.charCodeAt(A.length - 1 - i) === B.charCodeAt(B.length - 1 - i)
  ) {
    i++;
  }
  return i;
}

function windowRange(text, center, { windowChars, maxChars }) {
  const s = String(text ?? '');
  if (!s) return { start: 0, end: 0 };
  const c = Math.max(0, Math.min(s.length, Math.floor(center)));

  let start = Math.max(0, c - windowChars);
  let end = Math.min(s.length, c + windowChars);

  // Hard cap
  if (end - start > maxChars) {
    const half = Math.floor(maxChars / 2);
    start = Math.max(0, c - half);
    end = Math.min(s.length, start + maxChars);
    if (end - start < maxChars && start > 0) start = Math.max(0, end - maxChars);
  }

  return { start, end };
}

function sliceByRange(text, range) {
  const s = String(text ?? '');
  if (!s) return '';
  const start = Math.max(0, Math.min(s.length, range.start));
  const end = Math.max(start, Math.min(s.length, range.end));
  return s.slice(start, end).trim();
}

function numberTokens(text) {
  const s = String(text ?? '');
  const hits = [];
  const re = /\d+(?:[.,]\d+)?/g;
  let m;
  while ((m = re.exec(s))) {
    hits.push({ token: m[0], index: m.index });
    if (hits.length > 1000) break;
  }
  return hits;
}

/**
 * Extract short, literal evidence snippets from BEFORE/AFTER.
 *
 * Purpose: guarantee the judge sees the *changing fragment* (often near the end),
 * instead of the first N chars of a chunk.
 */
export function extractEvidenceSnippetsFromPair(beforeText, afterText, opts = {}) {
  const before = String(beforeText ?? '');
  const after = String(afterText ?? '');

  const windowChars = Number(opts.windowChars ?? 140);
  const maxChars = Number(opts.maxChars ?? 320);
  const maxSnippets = Number(opts.maxSnippets ?? 2);
  const includeNumbers = opts.includeNumbers !== false;

  if (!before && !after) return { before_snippets: [], after_snippets: [] };

  if (before === after) {
    const single = before.length <= maxChars ? before.trim() : before.slice(0, maxChars).trim();
    return { before_snippets: [single], after_snippets: [single] };
  }

  const prefixLen = commonPrefixLen(before, after);
  const suffixLen = commonSuffixLen(before, after, prefixLen);

  const beforeDiffStart = prefixLen;
  const afterDiffStart = prefixLen;

  const beforeDiffEnd = Math.max(beforeDiffStart, before.length - suffixLen);
  const afterDiffEnd = Math.max(afterDiffStart, after.length - suffixLen);

  const centersBefore = new Set([beforeDiffStart, Math.max(0, beforeDiffEnd - 1)]);
  const centersAfter = new Set([afterDiffStart, Math.max(0, afterDiffEnd - 1)]);

  if (includeNumbers) {
    const numsA = numberTokens(before);
    const numsB = numberTokens(after);
    const setA = new Set(numsA.map((x) => x.token));
    const setB = new Set(numsB.map((x) => x.token));

    const changedNums = [];
    for (const t of setA) if (!setB.has(t)) changedNums.push(t);
    for (const t of setB) if (!setA.has(t)) changedNums.push(t);

    for (const token of changedNums.slice(0, 6)) {
      const ia = before.lastIndexOf(token);
      if (ia !== -1) centersBefore.add(ia);
      const ib = after.lastIndexOf(token);
      if (ib !== -1) centersAfter.add(ib);
    }
  }

  const rangesBefore = uniqRanges(
    [...centersBefore]
      .filter((x) => Number.isFinite(Number(x)))
      .map((c) => windowRange(before, c, { windowChars, maxChars })),
  ).slice(0, maxSnippets);

  const rangesAfter = uniqRanges(
    [...centersAfter]
      .filter((x) => Number.isFinite(Number(x)))
      .map((c) => windowRange(after, c, { windowChars, maxChars })),
  ).slice(0, maxSnippets);

  const before_snippets = rangesBefore.map((r) => sliceByRange(before, r)).filter(Boolean);
  const after_snippets = rangesAfter.map((r) => sliceByRange(after, r)).filter(Boolean);

  return { before_snippets, after_snippets };
}

/**
 * For single long texts (added/removed), return a small set of literal snippets
 * that covers both the beginning and the end.
 */
export function headTailSnippets(text, opts = {}) {
  const s = String(text ?? '');
  const maxChars = Number(opts.maxChars ?? 320);
  const headChars = Number(opts.headChars ?? Math.min(180, maxChars));
  const tailChars = Number(opts.tailChars ?? Math.min(180, maxChars));

  if (!s.trim()) return [];
  if (s.length <= maxChars) return [s.trim()];

  const head = s.slice(0, headChars).trim();
  const tail = s.slice(Math.max(0, s.length - tailChars)).trim();

  if (!tail || tail === head) return [head];
  if (head && tail && head.includes(tail)) return [head];

  return [head, tail];
}
