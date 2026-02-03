// orchestrator/extractors/domStructuredText.js
// Goal: return ONLY human-visible text + numbers (no HTML/DOM/state blobs), with sane line breaks.
// Works with both Puppeteer DOM (innerText available) and JSDOM (no layout).

import { normalizeWhitespace } from '../../utils/normalize.js';

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template',
  'svg', 'canvas', 'meta', 'link', 'iframe', 'object', 'embed'
]);

const BLOCKISH_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'label', 'legend', 'li', 'main', 'nav',
  'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'ul'
]);

function _toLowerTag(node) {
  return String(node?.tagName || '').toLowerCase();
}

function _isHidden(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.hasAttribute?.('hidden')) return true;
  const aria = (el.getAttribute?.('aria-hidden') || '').toLowerCase();
  if (aria === 'true') return true;

  const style = (el.getAttribute?.('style') || '').toLowerCase();
  if (style.includes('display:none') || style.includes('display: none')) return true;
  if (style.includes('visibility:hidden') || style.includes('visibility: hidden')) return true;

  return false;
}

function _isBoilerplate(el) {
  // Generic boilerplate containers; avoids menus/footers dominating the text.
  if (!el || el.nodeType !== 1) return false;
  const tag = _toLowerTag(el);
  if (tag === 'nav' || tag === 'footer' || tag === 'header' || tag === 'aside') return true;

  const role = (el.getAttribute?.('role') || '').toLowerCase();
  if (role === 'navigation' || role === 'banner' || role === 'contentinfo') return true;

  return false;
}

function _isFrameworkStateContainer(el) {
  if (!el || el.nodeType !== 1) return false;

  const id = (el.id || '').toLowerCase();
  if (id === '__nuxt' || id === '__nuxt__' || id.includes('__nuxt')) return true;
  if (id === '__next' || id === '__next__' || id.includes('__next')) return true;
  if (id.includes('nuxt-data') || id.includes('next-data')) return true;

  const cls = String(el.className || '').toLowerCase();
  // framework-ish, but still generic: only triggers when combined with "state/payload/hydration".
  if (cls.includes('nuxt') && (cls.includes('state') || cls.includes('payload') || cls.includes('hydrate'))) return true;
  if (cls.includes('next') && (cls.includes('state') || cls.includes('payload') || cls.includes('hydrate'))) return true;

  return false;
}

function _pushLine(acc, text) {
  const t = normalizeWhitespace(text);
  if (!t) return;
  // avoid ultra-noisy single-character lines
  if (t.length === 1 && !/\p{L}|\d/u.test(t)) return;
  acc.push(t);
}

function _serializeText(root, { dropBoilerplate } = {}) {
  const parts = [];
  const pushNL = () => {
    if (parts.length && parts[parts.length - 1] !== '\n') parts.push('\n');
  };

  const walk = (node) => {
    if (!node) return;

    if (node.nodeType === 3) { // TEXT_NODE
      const value = node.nodeValue || '';
      if (value && value.trim()) parts.push(value);
      return;
    }

    if (node.nodeType !== 1) return; // ELEMENT_NODE only
    const el = node;

    const tag = _toLowerTag(el);
    if (!tag) return;
    if (SKIP_TAGS.has(tag)) return;
    if (_isHidden(el)) return;
    if (_isFrameworkStateContainer(el)) return;
    if (dropBoilerplate && _isBoilerplate(el)) return;

    if (tag === 'br') {
      pushNL();
      return;
    }

    const isBlockish = BLOCKISH_TAGS.has(tag);
    if (isBlockish) pushNL();

    // Special case: inputs/buttons often carry useful text in value/aria-label
    if (tag === 'input') {
      _pushLine(parts, el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || el.getAttribute?.('value') || '');
    } else if (tag === 'button') {
      _pushLine(parts, el.getAttribute?.('aria-label') || '');
    }

    // Walk children
    const children = el.childNodes || [];
    for (const child of children) walk(child);

    if (isBlockish) pushNL();
  };

  walk(root);

  // Join and normalize line breaks + whitespace per-line
  let text = parts.join('');
  text = text.replace(/[ \t\f\v]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  const lines = text
    .split('\n')
    .map((l) => normalizeWhitespace(l))
    .filter(Boolean);

  return lines.join('\n');
}

export function domToStructuredText(root, {
  maxChars = 25000,
  dropBoilerplate = true,
} = {}) {
  if (!root) return '';

  // Best case: real browser DOM (Puppeteer) → innerText gives human-visible text & line breaks.
  try {
    const inner = typeof root.innerText === 'string' ? root.innerText : null;
    if (inner && inner.trim()) {
      const out = inner
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((l) => normalizeWhitespace(l))
        .filter(Boolean)
        .join('\n')
        .slice(0, maxChars);
      return out;
    }
  } catch {
    // ignore, fallback to serializer
  }

  // Fallback: DOM walk that inserts line breaks at block-ish boundaries.
  const out = _serializeText(root, { dropBoilerplate });
  return out.slice(0, maxChars);
}
