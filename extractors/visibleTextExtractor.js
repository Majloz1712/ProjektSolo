import { clampTextLength, normalizeWhitespace, normalizePriceCandidate, inferContentType } from '../utils/normalize.js';

function collectVisibleText(doc) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.textContent?.trim();
      if (!text) return NodeFilter.FILTER_REJECT;
      if (/^\s*$/.test(text)) return NodeFilter.FILTER_REJECT;
      if (text.length < 3) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const parts = [];
  while (walker.nextNode()) {
    parts.push(normalizeWhitespace(walker.currentNode.textContent));
  }
  return normalizeWhitespace(parts.join(' '));
}

function findHeuristicContainer(doc) {
  const selectors = [
    'article',
    'main',
    '[role="main"]',
    '[itemtype*="Product"]',
    '.product',
    '.article',
  ];
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (el) return el.outerHTML;
  }
  return null;
}

function detectPrice(text) {
  if (!text) return null;
  const match = text.match(/([\d][\d\s.,]+)\s*(zł|pln|eur|€|usd|\$|£)/i);
  if (!match) return null;
  return normalizePriceCandidate(match[0]);
}

export const visibleTextExtractor = {
  name: 'visible-text',
  detect(doc) {
    const text = collectVisibleText(doc);
    return Math.min(0.5, text.length / 2000);
  },
  extract(doc, { url }) {
    const text = collectVisibleText(doc);
    if (!text) return null;
    const title = normalizeWhitespace(doc.querySelector('h1')?.textContent || doc.querySelector('title')?.textContent || '');
    const description = normalizeWhitespace(doc.querySelector('meta[name="description"]')?.getAttribute('content') || '');
    const htmlMain = clampTextLength(findHeuristicContainer(doc) || '');
    return {
      url,
      title: title || null,
      description: description || null,
      text,
      htmlMain: htmlMain || null,
      price: detectPrice(text),
      images: [],
      attributes: {},
      confidence: Math.min(0.5, text.length / 4000 + 0.2),
      extractor: 'visible-text',
      contentType: inferContentType({ text }),
    };
  },
};
