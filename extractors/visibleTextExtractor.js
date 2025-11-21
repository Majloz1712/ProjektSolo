import {
  clampTextLength,
  normalizeWhitespace,
  normalizePriceCandidate,
  inferContentType,
} from '../utils/normalize.js';

function collectVisibleText(doc) {
  const NodeFilterImpl = doc.defaultView?.NodeFilter || globalThis.NodeFilter;
  if (!NodeFilterImpl) {
    // awaryjnie: sam tekst z body
    return normalizeWhitespace(doc.body?.textContent || '');
  }

  const walker = doc.createTreeWalker(
    doc.body,
    NodeFilterImpl.SHOW_TEXT,
    {
      acceptNode(node) {
        const parentName = node.parentNode?.nodeName?.toLowerCase();

        // 1) wycinamy rzeczy oczywiste: <script>, <style>, <noscript>, <template>
        if (['script', 'style', 'noscript', 'template'].includes(parentName)) {
          return NodeFilterImpl.FILTER_REJECT;
        }

        const raw = node.textContent || '';
        const text = raw.trim();

        if (!text) return NodeFilterImpl.FILTER_REJECT;
        if (/^\s*$/.test(text)) return NodeFilterImpl.FILTER_REJECT;
        if (text.length < 3) return NodeFilterImpl.FILTER_SKIP;

        // 2) typowe śmieci JS / JSON – bardzo długie linie z klamrami + cudzysłowami
        if (
          text.length > 400 &&
          /[{}()[\];=]/.test(text) &&
          /['"]/.test(text)
        ) {
          return NodeFilterImpl.FILTER_SKIP;
        }

        // 3) mega długie ciągi znaków (np. base64, tokeny)
        if (text.length > 1000 && /[A-Za-z0-9+\/]{80,}/.test(text)) {
          return NodeFilterImpl.FILTER_SKIP;
        }

        return NodeFilterImpl.FILTER_ACCEPT;
      },
    },
  );

  const parts = [];
  while (walker.nextNode()) {
    parts.push(normalizeWhitespace(walker.currentNode.textContent));
  }

  // lekkie przycięcie, żeby nie było kilometrowego tekstu
  const full = parts.join('\n');
  return clampTextLength(full || '', 20000);
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
    let text = collectVisibleText(doc);
    if (!text) return null;

    // ❶ SPECJALNY CASE NA WAF / „JavaScript is disabled” – ucinamy śmieci JS
    if (/AwsWafIntegration|JavaScript is disabled|verify that you'?re not a robot/i.test(text)) {
      // zostawiamy tylko „ludzką” część komunikatu
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/AwsWafIntegration|getNewUrlWithAddedParameter|chal_t\s*=/i.test(l));

      text = normalizeWhitespace(lines.join(' '));
    }

    const title = normalizeWhitespace(
      doc.querySelector('h1')?.textContent
      || doc.querySelector('title')?.textContent
      || '',
    );

    const description = normalizeWhitespace(
      doc.querySelector('meta[name="description"]')?.getAttribute('content')
      || '',
    );

    const htmlMain = clampTextLength(findHeuristicContainer(doc) || '');

    return {
      url,
      title: title || null,
      description: description || null,
      text: text || null,
      //htmlMain: htmlMain || null,
      price: detectPrice(text),
      images: [],
      attributes: {},
      confidence: Math.min(0.5, text.length / 4000 + 0.2),
      extractor: 'visible-text',
      contentType: inferContentType({ text }),
    };
  },
};

