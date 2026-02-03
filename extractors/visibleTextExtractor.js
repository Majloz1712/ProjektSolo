// orchestrator/extractors/visibleTextExtractor.js
// Visible text fallback extractor.
//
// Key improvement:
// - Prefer structured block serialization (headings/paragraphs/list items) to expose sections.
// - Keep legacy text-node walker as fallback for very weird DOMs.

import {
  clampTextLength,
  normalizeWhitespace,
  normalizePriceCandidate,
  inferContentType,
} from '../utils/normalize.js';
import { detectMainPriceFromDom } from './priceUtils.js';
import { domToStructuredText } from './domStructuredText.js';

function detectPrice(text) {
  if (!text) return null;
  const match = text.match(/([\d][\d\s.,]+)\s*(zł|pln|eur|€|usd|\$|£)/i);
  if (!match) return null;
  return normalizePriceCandidate(match[0]);
}

function pickMainContainer(doc) {
  return (
    doc.querySelector('article') ||
    doc.querySelector('main') ||
    doc.querySelector('[role="main"]') ||
    doc.querySelector('#content') ||
    doc.body
  );
}

// Legacy walker — sometimes useful for DOMs with lots of inline nodes.
function collectVisibleTextByWalker(doc) {
  const NodeFilterImpl = doc.defaultView?.NodeFilter || globalThis.NodeFilter;
  if (!NodeFilterImpl) {
    return normalizeWhitespace(doc.body?.textContent || '');
  }

  const walker = doc.createTreeWalker(doc.body, NodeFilterImpl.SHOW_TEXT, {
    acceptNode(node) {
      const parentName = node.parentNode?.nodeName?.toLowerCase();
      if (['script', 'style', 'noscript', 'template'].includes(parentName)) {
        return NodeFilterImpl.FILTER_REJECT;
      }
      const text = (node.textContent || '').trim();
      if (!text) return NodeFilterImpl.FILTER_REJECT;
      if (text.length < 3) return NodeFilterImpl.FILTER_SKIP;
      if (text.length > 400 && /[{}()[\];=]/.test(text) && /['"]/.test(text)) {
        return NodeFilterImpl.FILTER_SKIP;
      }
      if (text.length > 1000 && /[A-Za-z0-9+\/]{80,}/.test(text)) {
        return NodeFilterImpl.FILTER_SKIP;
      }
      return NodeFilterImpl.FILTER_ACCEPT;
    },
  });

  const parts = [];
  while (walker.nextNode()) {
    parts.push(normalizeWhitespace(walker.currentNode.textContent));
  }
  return clampTextLength(parts.join('\n') || '', 20000);
}

function findHeuristicContainerHtml(doc) {
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

export const visibleTextExtractor = {
  name: 'visible-text',

  detect(doc) {
    // Fast heuristic: if the page has non-trivial body text, we can be a fallback.
    const raw = normalizeWhitespace(doc.body?.textContent || '');
    return Math.min(0.5, raw.length / 2000);
  },

  extract(doc, { url }) {
    // 1) Prefer structured serialization for section visibility
    const container = pickMainContainer(doc);
    const clone = container?.cloneNode?.(true) || null;
    if (clone) {
      clone.querySelectorAll('script, style, noscript, template').forEach((el) => el.remove());
    }

    let text = clone
      ? domToStructuredText(clone, {
          maxChars: 20000,
          maxBlocks: 2000,
          dropBoilerplate: true,
        })
      : '';

    // 2) Fallback to legacy walker if structured output is too small
    if (!text || text.length < 300) {
      text = collectVisibleTextByWalker(doc);
    }

    if (!text) return null;

    // Special-case WAF / JS-disabled pages: keep only human-ish lines
    if (/AwsWafIntegration|JavaScript is disabled|verify that you'?re not a robot/i.test(text)) {
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/AwsWafIntegration|getNewUrlWithAddedParameter|chal_t\s*=/i.test(l));
      text = normalizeWhitespace(lines.join(' '));
    }

    const title = normalizeWhitespace(
      doc.querySelector('h1')?.textContent || doc.querySelector('title')?.textContent || '',
    );

    const description = normalizeWhitespace(
      doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
        doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        '',
    );

    const htmlMain = clampTextLength(findHeuristicContainerHtml(doc) || '');

    const domPrice = detectMainPriceFromDom(doc);
    return {
      url,
      title: title || null,
      description: description || null,
      text: text || null,
      htmlMain: htmlMain || null,
      price: domPrice || detectPrice(text),
      images: [],
      attributes: {
        structured: !!clone,
        structured_format: clone ? 'markdown-ish' : 'plain',
      },
      confidence: Math.min(0.55, text.length / 4000 + 0.2),
      extractor: 'visible-text',
      contentType: inferContentType({ text }),
    };
  },
};
