// orchestrator/extractors/domStructuredText.js
// Goal: DOM/HTML -> OCR-like clean text (for LLM):
// - 0 SSR/JSON/framework payloads
// - 0 URLs/api dumps/emails
// - short lines, no mega-lines
// Works even if `root` is a DOM node OR an HTML string.

import { clampTextLength, normalizeWhitespace } from '../utils/normalize.js';

export const DOM_STRUCTURED_TEXT_VERSION = '2026-02-02_v7';

const BOILERPLATE_CONTAINERS = [
  'nav',
  'footer',
  'header',
  'aside',
  '[role="navigation"]',
  '[role="contentinfo"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[aria-hidden="true"]',
  '[hidden]',
];

// Prefer human-facing *block-ish* tags (generic).
// We intentionally avoid inline UI tags like <a>/<button>/<label> because they
// create lots of noise and duplication (their text is usually already present
// in surrounding <p>/<li>/etc.).
const BLOCK_TAGS = new Set([
  'h1','h2','h3','h4','h5','h6',
  'p','li','blockquote',
  'dl','dt','dd',
  'table','caption',
  'figcaption',
]);

const SKIP_TAGS = new Set([
  'script','style','noscript','template','svg','canvas',
]);

function isString(x) {
  return typeof x === 'string' || x instanceof String;
}

function tagNameLower(el) {
  return String(el?.tagName || '').toLowerCase();
}

function decodeBasicEntities(s) {
  if (!s) return s;
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripZeroWidth(s) {
  return (s || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function insertSpacesBetweenLettersAndDigits(s) {
  if (!s) return s;
  return s
    .replace(/(\d)([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż])/g, '$1 $2')
    .replace(/([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż])(\d)/g, '$1 $2');
}

function cleanInlineText(s) {
  if (!s) return '';
  let t = String(s);
  t = decodeBasicEntities(t);
  t = stripZeroWidth(t);
  t = normalizeWhitespace(t);
  t = insertSpacesBetweenLettersAndDigits(t);
  t = normalizeWhitespace(t);
  return t;
}

// Line-level cleaner that preserves a small amount of leading indentation for
// list markers. This keeps nested lists stable for diffs/chunking.
function cleanLinePreserveIndent(s) {
  if (!s) return '';
  const raw = String(s).replace(/\t/g, '  ');
  const m = raw.match(/^(\s{0,12})([\s\S]*)$/);
  const lead = (m?.[1] || '').replace(/\t/g, ' ');
  const rest = cleanInlineText(m?.[2] || raw);
  if (!rest) return '';

  // Keep indentation only when the *cleaned* line starts with a list marker.
  if (/^(-\s+|\d+\.\s+)/.test(rest)) {
    const keep = lead.slice(0, 8); // cap indentation to keep output stable
    return keep + rest;
  }
  return rest;
}

// Like cleanInlineText, but preserves line breaks. This is critical for
// "structured" output (headings / lists / tables) where newlines carry meaning.
function cleanMultilineText(s) {
  if (!s) return '';
  let t = String(s);
  t = decodeBasicEntities(t);
  t = stripZeroWidth(t);
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const lines = t
    .split('\n')
    .map((l) => {
      let x = normalizeWhitespace(l);
      x = insertSpacesBetweenLettersAndDigits(x);
      x = normalizeWhitespace(x);
      return x;
    });

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripHtmlTags(html) {
  if (!html) return '';
  let t = String(html);

  // Drop scripts/styles/templates aggressively first.
  t = t.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  t = t.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ');

  // Drop remaining tags.
  t = t.replace(/<\/?[^>]+>/g, ' ');

  return t;
}

function isHiddenByAttrs(el) {
  if (!el) return true;
  if (el.hasAttribute?.('hidden')) return true;
  const ariaHidden = String(el.getAttribute?.('aria-hidden') || '').toLowerCase();
  if (ariaHidden === 'true') return true;

  // Attribute-level only (works in JSDOM too).
  const style = String(el.getAttribute?.('style') || '').toLowerCase();
  if (style.includes('display:none') || style.includes('visibility:hidden')) return true;
  return false;
}

function isInBoilerplate(el, root, dropBoilerplate) {
  if (!dropBoilerplate) return false;
  if (!el?.closest) return false;
  const hit = el.closest(BOILERPLATE_CONTAINERS.join(','));
  if (!hit) return false;
  return root ? root.contains(hit) : true;
}

function pickContentRoot(root) {
  if (!root?.querySelector) return root;
  const candidates = [
    root.querySelector('main'),
    root.querySelector('[role="main"]'),
    root.querySelector('article'),
  ].filter(Boolean);

  if (!candidates.length) return root;

  let best = root;
  let bestLen = 0;
  for (const c of candidates) {
    const t = cleanInlineText(typeof c.innerText === 'string' ? c.innerText : c.textContent);
    if (t.length > bestLen) {
      bestLen = t.length;
      best = c;
    }
  }
  return bestLen >= 200 ? best : root;
}

// --------- HARD PAYLOAD REMOVAL (generic) ----------

function looksSerialized(blob) {
  if (!blob || blob.length < 180) return false;

  const len = blob.length;
  const punct = (blob.match(/[\[\]{}":,\\]/g) || []).length;
  const letters = (blob.match(/[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/g) || []).length;

  if (/(__NUXT__|__NEXT_DATA__|\$snuxt|pinia|redux|apollo|hydration|webpack|schema\.org|@context|@type)/i.test(blob)) {
    return true;
  }

  // High density of JSON punctuation/escapes
  if ((punct / len) > 0.12 && (letters / len) < 0.75) return true;

  // Many quotes/colons typically present in JSON
  const quotes = (blob.match(/"/g) || []).length;
  const colons = (blob.match(/:/g) || []).length;
  if (quotes >= 20 && colons >= 10) return true;

  return false;
}

function findMatchingBracket(s, start) {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;

  const maxScan = Math.min(s.length, start + 60000); // guard
  for (let i = start; i < maxScan; i++) {
    const ch = s[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function removeSerializedBlobs(s) {
  if (!s) return s;
  let t = String(s);

  // Fast wins: drop explicit NEXT/NUXT payload script remnants if any survived textification.
  t = t.replace(/__NUXT__[\s\S]{0,20000}/g, ' ');
  t = t.replace(/__NEXT_DATA__[\s\S]{0,20000}/g, ' ');

  let out = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];

    // Detect large {...} or [...] blocks and remove if serialized.
    if (ch === '{' || ch === '[') {
      const end = findMatchingBracket(t, i);
      if (end !== -1) {
        const blob = t.slice(i, end + 1);
        if (looksSerialized(blob)) {
          i = end; // skip blob
          continue;
        }
      }
    }

    out += ch;
  }

  return out;
}

function shouldDropLine(line) {
  if (!line) return true;

  // Any remaining heavy JSON chars -> drop
  const heavy = (line.match(/[\[\]{}\\"]/g) || []).length;
  if (heavy >= 3) return true;

  // URLs / API dumps
  if (/https?:\/\/\S+/i.test(line)) return true;
  if (/(^|\s)\/api\/\S+/i.test(line)) return true;
  const slashes = (line.match(/\//g) || []).length;
  if (slashes >= 6) return true;

  // Emails / tel / mailto are almost always footer noise in monitoring
  if (/\bmailto:|tel:|\b\S+@\S+\.\S+\b/i.test(line)) return true;

  // Schema / framework words
  if (/(schema\.org|@context|@type|pinia|hydration|redux|apollo|\$snuxt|__nuxt|__next)/i.test(line)) return true;

  // “tool UI” noise
  if (/no elements found|list is empty/i.test(line)) return true;

  // Very low signal: mostly punctuation
  const len = line.length;
  const alphaNum = (line.match(/[0-9A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/g) || []).length;
  if (len >= 30 && alphaNum / len < 0.55) return true;

  // Too short (and not numeric)
  if (len <= 1 && !/^\d$/.test(line)) return true;

  return false;
}

function splitToLines(text, maxLineChars = 140) {
  if (!text) return [];
  const raw = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // If the input already contains structure (newlines), preserve it.
  // Otherwise, try to introduce line breaks using generic separators.
  const hasNewlines = raw.includes('\n');
  const rough = (hasNewlines ? raw : raw
      .replace(/\s*[\u2022•·▪●]\s*/g, '\n')
      .replace(/\s{2,}/g, '\n')
      .replace(/\s*\|\s*/g, '\n')
    )
    .split(/\n+/g)
    .filter(Boolean);

  const out = [];
  for (const partRaw of rough) {
    const part = cleanLinePreserveIndent(partRaw);
    if (!part) continue;

    if (part.length <= maxLineChars) {
      out.push(part);
      continue;
    }

    // Soft wrap long lines. If this is a list item, keep indentation stable.
    const li = part.match(/^(\s{0,8})(-\s+|\d+\.\s+)([\s\S]+)$/);
    const basePrefix = li ? `${li[1]}${li[2]}` : '';
    const contPrefix = li ? `${li[1]}  ` : '';
    let s = li ? li[3].trim() : part;

    const widthFirst = li ? Math.max(20, maxLineChars - basePrefix.length) : maxLineChars;
    const widthCont = li ? Math.max(20, maxLineChars - contPrefix.length) : maxLineChars;

    let first = true;
    while (s.length > (first ? widthFirst : widthCont)) {
      const width = first ? widthFirst : widthCont;
      let cut = s.lastIndexOf(' ', width);
      if (cut < Math.floor(width * 0.6)) cut = width;
      const chunk = s.slice(0, cut).trim();
      out.push((first ? basePrefix : contPrefix) + chunk);
      s = s.slice(cut).trim();
      first = false;
    }
    if (s) out.push((first ? basePrefix : contPrefix) + s);
  }
  return out;
}

// --------- STRUCTURED SERIALIZATION (stable, OCR-like) ----------

function _listDepth(el, root) {
  if (!el?.parentElement) return 0;
  let depth = 0;
  let cur = el.parentElement;
  while (cur && cur !== root) {
    const t = tagNameLower(cur);
    if (t === 'ul' || t === 'ol') depth++;
    cur = cur.parentElement;
  }
  return depth;
}

function _cloneAndDrop(el, selectors) {
  try {
    const clone = el.cloneNode(true);
    clone.querySelectorAll?.(selectors).forEach((n) => n.remove());
    return clone;
  } catch {
    return el;
  }
}

function _textOf(el) {
  const raw = (typeof el.innerText === 'string' ? el.innerText : el.textContent) || '';
  return cleanInlineText(raw);
}

function _serializeDl(dl) {
  const lines = [];
  const children = Array.from(dl.children || []);
  let term = null;
  for (const ch of children) {
    const t = tagNameLower(ch);
    if (t === 'dt') {
      const v = _textOf(ch);
      term = v || null;
    } else if (t === 'dd') {
      const v = _textOf(ch);
      if (!v) continue;
      if (term) lines.push(`${term}: ${v}`);
      else lines.push(v);
    }
  }
  return lines;
}

function _serializeTable(table) {
  const lines = [];
  const caption = cleanInlineText(table.querySelector?.('caption')?.textContent || '');
  lines.push(caption ? `TABLE: ${caption}` : 'TABLE');

  const rows = Array.from(table.querySelectorAll?.('tr') || []);
  for (const tr of rows) {
    const cells = Array.from(tr.querySelectorAll?.('th,td') || []);
    const vals = cells.map((c) => cleanInlineText(c.textContent || '')).filter(Boolean);
    if (!vals.length) continue;
    const isHeader = cells.length && cells.every((c) => tagNameLower(c) === 'th');
    const line = vals.join(' | ');
    lines.push(isHeader ? `HEAD: ${line}` : line);
  }
  return lines;
}

// Extract structured text from DOM in a way that preserves sections (headings),
// list nesting and key/value pairs, while dropping UI boilerplate.
function extractFromDom(rootEl, { dropBoilerplate = true } = {}) {
  const contentRoot0 = pickContentRoot(rootEl);
  // Work on a clone so we never mutate the original DOM passed by callers.
  const contentRoot = _cloneAndDrop(contentRoot0, 'script,style,noscript,template,svg,canvas');
  contentRoot.querySelectorAll?.('#__NEXT_DATA__, #__NUXT_DATA__, #__APOLLO_STATE__').forEach((n) => n.remove());

  const lines = [];
  const seen = new Set();

  const push = (line) => {
    const v = cleanLinePreserveIndent(line);
    if (!v) return;
    // Keep duplicates rare, but don't over-dedupe: only exact duplicates globally.
    if (seen.has(v)) return;
    seen.add(v);
    lines.push(v);
  };

  const visit = (node) => {
    if (!node) return;
    const tag = tagNameLower(node);
    if (SKIP_TAGS.has(tag)) return;
    if (isHiddenByAttrs(node)) return;
    if (isInBoilerplate(node, contentRoot, dropBoilerplate)) return;

    // Handle high-structure containers as units (avoid td/th duplication).
    if (tag === 'dl') {
      for (const l of _serializeDl(node)) push(l);
      return;
    }
    if (tag === 'table') {
      for (const l of _serializeTable(node)) push(l);
      return;
    }

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      const lvl = Number(tag.slice(1)) || 2;
      const t = _textOf(node);
      if (t) push(`${'#'.repeat(Math.min(6, Math.max(1, lvl)))} ${t}`);
      return;
    }

    // List items (preserve nesting, exclude nested list text)
    if (tag === 'li') {
      const depth = _listDepth(node, contentRoot);
      const indent = '  '.repeat(Math.min(4, depth));
      const tmp = _cloneAndDrop(node, 'ul,ol,table,dl');
      const t = _textOf(tmp);
      if (t) push(`${indent}- ${t}`);

      // Traverse only nested lists (keep order)
      const nested = Array.from(node.children || []).filter((c) => {
        const ct = tagNameLower(c);
        return ct === 'ul' || ct === 'ol';
      });
      for (const sub of nested) visit(sub);
      return;
    }

    // Paragraph-like blocks
    if (tag === 'p' || tag === 'blockquote' || tag === 'figcaption') {
      // Avoid duplicates: <p> inside <li> is almost always the same content.
      if (tag === 'p' && node.closest?.('li') && node.closest('li') !== node) return;
      const t = _textOf(node);
      if (t) push(t);
      return;
    }

    // Generic traversal for remaining nodes: visit element children in order.
    for (const ch of Array.from(node.children || [])) {
      visit(ch);
    }
  };

  visit(contentRoot);

  // Fallback if block extraction fails
  if (!lines.length) {
    const raw = (typeof contentRoot.innerText === 'string' ? contentRoot.innerText : contentRoot.textContent) || '';
    return cleanInlineText(raw);
  }

  return lines.join('\n');
}

function finalizeToOcrLike(text, {
  maxBlocks = 2500,
  maxLineChars = 140,
} = {}) {
  let t = cleanMultilineText(text);

  // If any HTML survived (string mode), strip tags then clean again.
  if (/<\/?[a-z][\s\S]*>/i.test(t)) {
    t = cleanMultilineText(stripHtmlTags(t));
  }

  // Hard kill serialized payloads even if they got merged into visible text.
  t = removeSerializedBlobs(t);
  t = cleanMultilineText(t);

  const lines = splitToLines(t, maxLineChars);

  const out = [];
  const seen = new Set();
  for (let line of lines) {
    // One more pass to kill late payload tails
    line = removeSerializedBlobs(line);
    line = cleanLinePreserveIndent(line);

    if (!line) continue;
    if (shouldDropLine(line)) continue;

    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
      if (out.length >= maxBlocks) break;
    }
  }

  return out.join('\n');
}

export function domToStructuredText(root, {
  maxChars = 25000,
  maxBlocks = 2500,
  dropBoilerplate = true, // kept for signature compatibility
  maxLineChars = 140,
} = {}) {
  if (!root) return '';

  let rawText = '';

  // If somebody accidentally passes HTML string -> still handle it.
  if (isString(root)) {
    rawText = stripHtmlTags(String(root));
  } else {
    // DOM node path
    try {
      rawText = extractFromDom(root, { dropBoilerplate });
    } catch {
      // Last resort: attempt textContent
      rawText = cleanInlineText(root?.textContent || '');
    }
  }

  const cleaned = finalizeToOcrLike(rawText, { maxBlocks, maxLineChars });
  return clampTextLength(cleaned || '', maxChars);
}

