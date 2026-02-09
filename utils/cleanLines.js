// utils/cleanLines.js
// Deterministic text -> clean_lines / clean_text (OCR-style), but usable for ANY text source
// (DOM extraction, OCR, API text, etc.).
//
// Goals:
// - stable under diff
// - minimal domain heuristics
// - preserves line structure when possible

// NOTE: This module intentionally contains no project-specific imports.

// Structural markers that should survive dedupe/boilerplate filters (used by DOM->clean_lines).
const STRUCTURAL_MARKERS = new Set(['<PARA>']);

function isStructuralMarker(line) {
  const v = String(line || '').trim();
  return STRUCTURAL_MARKERS.has(v);
}


/**
 * Aggressively remove non-content blobs that break LLM analysis:
 * - HTML tags (if raw HTML accidentally slips through)
 * - framework hydration / serialized state (large JSON-like blocks)
 * - very long base64 / minified tokens
 * - URLs (keep only human text + numbers by default)
 *
 * This is intentionally generic (framework-agnostic) and relies on structural signals
 * (brackets/quotes/colons density, length) instead of site-specific rules.
 */
function sanitizeRawText(input) {
  let s = String(input || '');
  if (!s) return '';

  // Normalize newlines early
  s = s.replace(/\r\n?/g, '\n');

  // If raw HTML accidentally arrives here, strip tags & script/style blocks.
  if (s.includes('<') && s.includes('>')) {
    s = s
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '\n')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '\n')
      .replace(/<!--[\s\S]*?-->/g, '\n')
      .replace(/<\/?[^>]+>/g, '\n');
  }

  // Remove very long base64/minified chunks (rarely useful as visible content).
  s = s.replace(/[A-Za-z0-9+/]{250,}={0,2}/g, ' ');

  // Remove common framework markers (keeps surrounding text).
  s = s.replace(/\b(__NEXT_DATA__|__NEXT__|__NUXT__DATA__|__NUXT__|window\.__NUXT__|window\.__NEXT_DATA__)\b/g, ' ');

  // Remove large serialized JSON-ish blobs (hydration, json-ld, state, configs).
  s = stripSerializedStateBlocks(s);

  // Remove URLs (noise for LLM diffing). Keep plain text & numbers.
  s = s
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ');

  // Remove API endpoint-ish fragments specifically.
  s = s.replace(/\b\/api\/v?\s*\d+(?:\.\d+)?\/[^\s]+/gi, ' ');

  // Normalize whitespace but keep newlines
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  return s;
}

function stripSerializedStateBlocks(text, {
  minLen = 300,
  maxBlockLen = 120_000,
  maxScan = 250_000,
} = {}) {
  let s = String(text || '');
  if (!s) return '';
  if (!/[{\[]/.test(s)) return s;

  // Avoid pathological inputs
  if (s.length > maxScan) s = s.slice(0, maxScan);

  // Fast regex pass for obvious JSON-ish runs.
  s = s.replace(/[\[{][\s\S]{400,}?[\]}]/g, (m) => (_looksLikeSerializedState(m) ? '\n' : m));

  // More accurate pass: remove balanced bracket blocks that look like state.
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '{' || ch === '[') {
      const end = _findMatchingBracket(s, i, maxBlockLen);
      if (end !== -1) {
        const block = s.slice(i, end + 1);
        if (block.length >= minLen && _looksLikeSerializedState(block)) {
          out += '\n';
          i = end;
          continue;
        }
      }
    }
    out += ch;
  }

  return out;
}

function _findMatchingBracket(s, start, maxLen) {
  const open = s[start];
  const stack = [];
  if (open === '{') stack.push('}');
  else if (open === '[') stack.push(']');
  else return -1;

  let inStr = false;
  let esc = false;
  const limit = Math.min(s.length, start + maxLen);

  for (let i = start + 1; i < limit; i += 1) {
    const ch = s[i];

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === '\\\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }

    if (ch === '"') {
      inStr = true;
      continue;
    }

    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length && ch === stack[stack.length - 1]) {
        stack.pop();
        if (!stack.length) return i;
      } else {
        // unbalanced
        return -1;
      }
    }
  }

  return -1;
}

function _looksLikeSerializedState(block) {
  const s = String(block || '');
  if (s.length < 250) return false;

  // Must contain at least some JSON punctuation patterns
  const quotes = (s.match(/"/g) || []).length;
  const colons = (s.match(/:/g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  const braces = (s.match(/[{}\[\]]/g) || []).length;

  const jsonPunct = quotes + colons + commas + braces;
  const jsonPunctRatio = jsonPunct / s.length;

  // Count letters (unicode)
  const letters = (s.match(/\p{L}/gu) || []).length;
  const letterRatio = letters / s.length;

  // Heuristics: lots of quotes/braces/colons, relatively punctuation-dense.
  if (quotes >= 10 && colons >= 5 && braces >= 10 && jsonPunctRatio >= 0.08) return true;

  // Longer blocks with very high JSON punctuation density.
  if (s.length >= 600 && braces >= 40 && jsonPunctRatio >= 0.10) return true;

  // Key/valueish structure + not too "natural language".
  if (quotes >= 16 && colons >= 8 && jsonPunctRatio >= 0.07 && letterRatio <= 0.75) return true;

  return false;
}

function _countByScriptAndClass(str, sampleLimit = 12000) {
  const s = String(str || '').slice(0, sampleLimit);
  let latin = 0;
  let cjk = 0;
  let letters = 0;
  let digits = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (!cp) continue;
    if (/\p{L}/u.test(ch)) letters++;
    if (/\p{N}/u.test(ch)) digits++;
    if (/\p{Script=Latin}/u.test(ch)) latin++;
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(ch)) cjk++;
  }
  return { latin, cjk, letters, digits };
}

function _normalizeCommon(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\r\n?/g, '\n')
    .normalize('NFKC');
}

function _collapseSpacesPreserveNewlines(s) {
  return String(s)
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function _mergeHyphenatedAcrossNewlines(s) {
  return String(s).replace(/([\p{L}])-[\n]+([\p{L}])/gu, '$1$2');
}

function _stripWeirdControlAndBoxChars(line) {
  return String(line)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, '')
    .replace(/[\u2500-\u257F]/g, '');
}

function _stripLeadingIsolatedIcons(line, docIsLatinDominant) {
  let s = String(line);
  if (!docIsLatinDominant) return s;
  s = s.replace(/^(?:\s*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]\s+)+/gu, '');
  s = s.replace(/(?:\s+[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]\s*)+$/gu, '');
  return s;
}

function _stripCjkCharsEverywhere(line, docIsLatinDominant) {
  if (!docIsLatinDominant) return String(line);
  return String(line).replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, '');
}

function _stripUiGlyphTokens(line, docIsLatinDominant) {
  if (!docIsLatinDominant) return String(line);
  let s = String(line);
  // remove CJK "icon" noise
  s = _stripCjkCharsEverywhere(s, docIsLatinDominant);
  // remove isolated CJK tokens
  s = s.replace(/\s+[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]\s+/gu, ' ');
  // common checkbox / star / arrow glyphs as standalone tokens
  s = s.replace(
    /(?:^|\s)(?:[□■▢▣▤▥▦▧▨▩◆◇◈○●◎◉◌◍◯◻◼☐☑☒]|[↑↓←→⇧⇩⇦⇨➔➜➤]|[★☆✦✧✩✪✫✬✭✮✯])(?:\s|$)/gu,
    ' ',
  );
  // long star runs
  s = s.replace(/[★☆]{3,}/g, ' ');
  return s.replace(/\s{2,}/g, ' ').trim();
}

function _fixSpacingHeuristics(line) {
  let s = String(line);
  s = s.replace(/(\p{N})(\p{Ll})/gu, '$1 $2');
  s = s.replace(/(\p{Ll})(\p{N})/gu, '$1 $2');
  s = s.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
  s = s.replace(/([,.;:!?])(\p{L})/gu, '$1 $2');
  s = s.replace(/([\)\]])(\p{L})/gu, '$1 $2');
  s = s.replace(/(\p{L})([\(\[])/gu, '$1 $2');
  return s.replace(/\s{2,}/g, ' ').trim();
}

function _lineFingerprint(line) {
  return String(line)
    .toLowerCase()
    .replace(/[\p{Sc}]/gu, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/[\s]+/g, ' ')
    .trim();
}

function _lineExactKey(line) {
  return String(line)
    .toLowerCase()
    .replace(/[\u00A0]/g, ' ')
    .replace(/[\s]+/g, ' ')
    .trim();
}

function _lineQuality(line) {
  const s = String(line);
  const len = s.length || 1;
  let letters = 0;
  let digits = 0;
  let other = 0;
  let latinLetters = 0;
  for (const ch of s) {
    if (/\p{L}/u.test(ch)) {
      letters++;
      if (/\p{Script=Latin}/u.test(ch)) latinLetters++;
    } else if (/\p{N}/u.test(ch)) digits++;
    else if (ch !== ' ') other++;
  }
  const alphaRatio = letters / len;
  const digitRatio = digits / len;
  const otherRatio = other / len;
  const tokenCount = s.trim().split(/\s+/).filter(Boolean).length;

  // gibberish-ish: long alpha token with very low vowel share (latin-ish)
  let gibberish = false;
  const vowels = /[aeiouyąęóAEIOUYĄĘÓ]/g;
  const tokens = s.split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    const alphaOnly = t.replace(/[^\p{L}]/gu, '');
    if (alphaOnly.length >= 18) {
      const v = (alphaOnly.match(vowels) || []).length;
      if (v / alphaOnly.length < 0.16) {
        gibberish = true;
        break;
      }
    }
  }

  return { alphaRatio, digitRatio, otherRatio, tokenCount, letters, digits, latinLetters, gibberish };
}

function _countNewlines(s) {
  const m = String(s || '').match(/\n/g);
  return m ? m.length : 0;
}

export function splitToLineCandidates(rawText, {
  targetLineLen = 140,
  minSentenceSplitLen = 450,
} = {}) {
  let s = _normalizeCommon(rawText);
  if (!s.trim()) return '';

  // If the text already contains structure, keep it.
  if (_countNewlines(s) >= 2) return s;

  // Common separators -> newlines (domain-agnostic)
  s = s
    .replace(/\s*[\u2022•·▪●]\s*/g, '\n')
    .replace(/\s*\|\s*/g, '\n')
    .replace(/[\t\f\v]+/g, '\n');

  // Sentence splitting for long, single-line blobs
  if (_countNewlines(s) < 2 && s.length >= minSentenceSplitLen) {
    s = s.replace(/([.!?])\s+(?=[\p{Lu}\p{N}])/gu, '$1\n');
  }

  // Soft wrap if still a single "line"
  if (_countNewlines(s) < 1 && s.length > targetLineLen * 2) {
    const words = s.split(/\s+/).filter(Boolean);
    const lines = [];
    let buf = '';
    for (const w of words) {
      if (!buf) {
        buf = w;
        continue;
      }
      if ((buf.length + 1 + w.length) <= targetLineLen) {
        buf += ' ' + w;
      } else {
        lines.push(buf);
        buf = w;
      }
    }
    if (buf) lines.push(buf);
    s = lines.join('\n');
  }

  return s;
}

export function cleanTextToLines(rawText, opts = {}) {
  const {
    // Hard caps: keep LLM inputs bounded (works for both DOM and OCR)
    maxChars = 25000,
    maxLines = 2000,
    // Pre-splitting helps when extracted text is one long line.
    ensureLineBreaks = true,
    splitOptions = {},

    mergeHyphenated = true,
    fixCommon = true,
    keepNewlines = true,
    collapseSpaces = true,

    // dedupe
    dedupeWindow = 80,
    boilerplateMinFreq = 2,
    boilerplateMaxLineLen = 90,
    dropMostlyJunkLines = true,

    stripUiGlyphs = true,
    stripCjkChars = true,
    fixSpacing = true,
    dedupeExact = true,
  } = opts;

  const rawSanitized = sanitizeRawText(rawText);

  let s = ensureLineBreaks ? splitToLineCandidates(rawSanitized, splitOptions) : String(rawSanitized || '');
  s = _normalizeCommon(s);
  if (mergeHyphenated) s = _mergeHyphenatedAcrossNewlines(s);
  if (!keepNewlines) s = s.replace(/\n+/g, ' ');
  if (collapseSpaces) s = keepNewlines ? _collapseSpacesPreserveNewlines(s) : s.replace(/\s+/g, ' ').trim();

  let rawLines = s.split('
').map((l) => l.trim());

  // Preserve paragraph boundaries: keep empty lines, but collapse multiple empties.
  let lines = [];
  let prevEmpty = true;
  for (const l of rawLines) {
    const isEmpty = !l;
    if (isEmpty) {
      if (!prevEmpty) lines.push('');
    } else {
      lines.push(l);
    }
    prevEmpty = isEmpty;
  }
  // Trim leading/trailing empties
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const docStats = _countByScriptAndClass(lines.join('\n'));
  const latinShare = docStats.letters > 0 ? (docStats.latin / docStats.letters) : 1;
  const cjkShare = docStats.letters > 0 ? (docStats.cjk / docStats.letters) : 0;
  const docIsLatinDominant = docStats.letters > 0 ? (latinShare >= 0.45 && cjkShare <= 0.35) : true;

  const removed = { junk: 0, window_dup: 0, boilerplate: 0, exact_dup: 0 };
  const counts = { in_lines: lines.length, out_lines: 0 };

  // 1) per-line cleanup + quality filter
  const cleaned = [];
  const fingerprints = [];
  const exactKeys = [];
  for (const line0 of lines) {
    let line = line0;
    if (fixCommon) line = _normalizeCommon(line);
    line = _stripWeirdControlAndBoxChars(line);
    line = _stripLeadingIsolatedIcons(line, docIsLatinDominant);
    if (stripCjkChars) line = _stripCjkCharsEverywhere(line, docIsLatinDominant);
    if (stripUiGlyphs) line = _stripUiGlyphTokens(line, docIsLatinDominant);
    if (fixSpacing) line = _fixSpacingHeuristics(line);
    if (collapseSpaces) line = line.replace(/[\t\f\v ]+/g, ' ').trim();
    if (!line) continue;

    const q = _lineQuality(line);
    if (dropMostlyJunkLines) {
      const alnum = q.letters + q.digits;
      if (alnum < 3 && q.tokenCount <= 2) {
        removed.junk++;
        continue;
      }
      if (q.gibberish && q.alphaRatio < 0.6) {
        removed.junk++;
        continue;
      }
      if (q.alphaRatio < 0.18 && q.digitRatio < 0.12 && q.otherRatio > 0.45 && line.length < 120) {
        removed.junk++;
        continue;
      }
    }

    cleaned.push(line);
    fingerprints.push(_lineFingerprint(line));
    exactKeys.push(_lineExactKey(line));
  }

  // 2) window dedupe (exact)
  const win = Math.max(0, Number(dedupeWindow) || 0);
  const lastSeen = new Map();
  const winFiltered = [];
  const winFp = [];
  for (let i = 0; i < cleaned.length; i++) {
    const key = exactKeys[i];
    const fp = fingerprints[i];
    const last = lastSeen.get(key);
    if (win > 0 && key && last !== undefined && (i - last) <= win) {
      removed.window_dup++;
      continue;
    }
    lastSeen.set(key, i);
    winFiltered.push(cleaned[i]);
    winFp.push(fp);
  }

  // 3) boilerplate freq (leave first)
  const freq = new Map();
  for (const fp of winFp) {
    if (!fp) continue;
    freq.set(fp, (freq.get(fp) || 0) + 1);
  }

  const seenBoiler = new Set();
  const out = [];
  for (let i = 0; i < winFiltered.length; i++) {
    const line = winFiltered[i];
    const fp = winFp[i];
    if (!fp) {
      out.push(line);
      continue;
    }

    const f = freq.get(fp) || 0;
    if (f >= boilerplateMinFreq && line.length <= boilerplateMaxLineLen) {
      const q = _lineQuality(line);
      const uiLike = q.tokenCount <= 10 && (q.alphaRatio < 0.78 || q.digitRatio > 0.22);
      if (uiLike) {
        if (seenBoiler.has(fp)) {
          removed.boilerplate++;
          continue;
        }
        seenBoiler.add(fp);
      }
    }
    out.push(line);
  }

  // 4) global exact dedupe
  let finalOut = out;
  if (dedupeExact) {
    const seen = new Set();
    const deduped = [];
    for (const line of out) {
      const key = _lineExactKey(line);
      if (key && seen.has(key)) {
        removed.exact_dup++;
        continue;
      }
      if (key) seen.add(key);
      deduped.push(line);
    }
    finalOut = deduped;
  }

  // Apply hard caps (helps keep inputs stable for the LLM)
  let capped = finalOut;
  if (Number.isFinite(maxLines) && maxLines > 0 && capped.length > maxLines) {
    capped = capped.slice(0, maxLines);
  }
  if (Number.isFinite(maxChars) && maxChars > 0) {
    const acc = [];
    let total = 0;
    for (const line of capped) {
      const l = String(line || '');
      const add = l.length + (acc.length ? 1 : 0);
      if (total + add > maxChars) break;
      acc.push(l);
      total += add;
    }
    capped = acc;
  }

  const cleanText = capped.join('\n').trim();
  const rawTextCapped = (Number.isFinite(maxChars) && maxChars > 0)
    ? String(rawSanitized || '').slice(0, maxChars)
    : String(rawSanitized || '');

  counts.out_lines = capped.length;
  counts.out_chars = cleanText.length;

  return {
    raw_text: rawTextCapped,
    clean_lines: capped,
    clean_text: cleanText,
    clean_meta: {
      mode: 'lines',
      counts,
      removed,
      params: {
        ensureLineBreaks,
        splitOptions,
        mergeHyphenated,
        fixCommon,
        keepNewlines,
        collapseSpaces,
        dedupeWindow: win,
        boilerplateMinFreq,
        boilerplateMaxLineLen,
        dropMostlyJunkLines,
        stripUiGlyphs,
        stripCjkChars,
        dedupeExact,
        fixSpacing,
      },
      doc: {
        isLatinDominant: docIsLatinDominant,
      },
    },
  };
}

export function truncateLinesForMongo(lines, {
  maxLines = 1200,
  maxChars = 600000,
} = {}) {
  if (!Array.isArray(lines)) return { lines: null, truncated: false };
  let out = lines;
  let truncated = false;
  let total = 0;
  for (const l of out) total += String(l || '').length;
  if (out.length > maxLines || total > maxChars) {
    out = out.slice(0, maxLines);
    truncated = true;
  }
  return { lines: out, truncated };
}
