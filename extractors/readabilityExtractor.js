import { clampTextLength, normalizeWhitespace, normalizePriceCandidate, inferContentType } from '../utils/normalize.js';


function detectPrice(text) {
  if (!text) return null;
  const match = text.match(/([\d][\d\s.,]+)\s*(zł|pln|eur|€|usd|\$|£)/i);
  if (!match) return null;
  return normalizePriceCandidate(match[0]);
}



function scoreElement(element) {
  if (!element) return 0;
  const text = normalizeWhitespace(element.textContent || '');
  const lengthScore = Math.min(1, text.length / 8000);
  const paragraphCount = element.querySelectorAll('p').length;
  const headingBonus = element.querySelectorAll('h1,h2,h3').length ? 0.1 : 0;
  return lengthScore + Math.min(0.5, paragraphCount / 20) + headingBonus;
}

function findBestContainer(doc) {
  const candidates = [
    doc.querySelector('article'),
    doc.querySelector('main'),
    doc.querySelector('[role="main"]'),
    doc.querySelector('#content'),
  ].filter(Boolean);

  const additional = Array.from(doc.querySelectorAll('section, div')).filter((el) => {
    const paragraphs = el.querySelectorAll('p').length;
    return paragraphs >= 3 && el.textContent?.length > 500;
  });

  candidates.push(...additional);

  let best = null;
  let bestScore = 0;
  for (const el of candidates) {
    const score = scoreElement(el);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return { element: best, score: bestScore };
}

export const readabilityExtractor = {
  name: 'readability',
  detect(doc) {
    const { score } = findBestContainer(doc);
    return Math.min(1, score);
  },
    extract(doc, { url }) {
    const { element, score } = findBestContainer(doc);
    if (!element) return null;

    // NOWE: klon + wycięcie script/style/noscript
    const clone = element.cloneNode(true);
    clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());

    const text = normalizeWhitespace(clone.textContent || '');
    if (!text) return null;

    const htmlMain = clampTextLength(clone.innerHTML || '');
    const title = normalizeWhitespace(doc.querySelector('h1')?.textContent || doc.querySelector('title')?.textContent || '');
    const description = normalizeWhitespace(doc.querySelector('meta[name="description"]')?.getAttribute('content') || '');
    const price = detectPrice(text);

    return {
      url,
      title: title || null,
      description: description || null,
      text,
      //htmlMain,
      price: price || null,
      images: Array.from(element.querySelectorAll('img'))
        .map((img) => img.getAttribute('src'))
        .filter(Boolean),
      attributes: {},
      confidence: Math.min(0.8, 0.4 + Math.min(0.4, score)),
      extractor: 'readability',
      contentType: inferContentType({ text }),
    };

  },

};
