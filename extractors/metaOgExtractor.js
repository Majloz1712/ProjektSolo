import { normalizeWhitespace, normalizePriceCandidate, sanitizeArray, inferContentType } from '../utils/normalize.js';
import { detectMainPriceFromDom } from './priceUtils.js';

function pickMeta(doc, selector) {
  const el = doc.querySelector(selector);
  return el?.getAttribute('content')?.trim() || null;
}

function collectImages(doc) {
  const ogImage = pickMeta(doc, 'meta[property="og:image"]');
  const twitterImage = pickMeta(doc, 'meta[name="twitter:image"],meta[name="twitter:image:src"]');
  const links = Array.from(doc.querySelectorAll('link[rel="image_src"], link[rel="thumbnail"]'))
    .map((el) => el.getAttribute('href'))
    .filter(Boolean);
  return sanitizeArray([ogImage, twitterImage, ...links]);
}

function detectPrice(doc) {
  const ogPriceAmount = pickMeta(doc, 'meta[property="product:price:amount"]');
  const ogPriceCurrency = pickMeta(doc, 'meta[property="product:price:currency"]');
  if (ogPriceAmount) {
    return normalizePriceCandidate(`${ogPriceAmount} ${ogPriceCurrency || ''}`);
  }
  const potential = pickMeta(doc, 'meta[itemprop="price"]') || pickMeta(doc, 'meta[name="price"]');
  return normalizePriceCandidate(potential);
}

export const metaOgExtractor = {
  name: 'meta-og',
  detect(doc) {
    const ogTitle = pickMeta(doc, 'meta[property="og:title"]');
    const ogDesc = pickMeta(doc, 'meta[property="og:description"]');
    if (ogTitle || ogDesc) return 0.7;
    const title = doc.querySelector('title');
    return title ? 0.3 : 0;
  },
  extract(doc, { url }) {
    const title = normalizeWhitespace(
      pickMeta(doc, 'meta[property="og:title"]')
      || pickMeta(doc, 'meta[name="twitter:title"]')
      || doc.querySelector('title')?.textContent
      || ''
    );
    const description = normalizeWhitespace(
      pickMeta(doc, 'meta[property="og:description"]')
      || pickMeta(doc, 'meta[name="description"]')
      || ''
    );
    const domPrice = detectMainPriceFromDom(doc);
    const price = domPrice || detectPrice(doc);
    const images = collectImages(doc);
    // IMPORTANT: og/meta extractor is *metadata-first*. Returning whole bodyText
    // tends to include navigation / footer noise and breaks "structured-only" pipelines.
    // Keep it minimal and stable: use the description as a text proxy.
    const bodyText = description;
    const confidence = title ? 0.6 : 0.45;
    return {
      url,
      title: title || null,
      description: description || null,
      text: bodyText || null,
      htmlMain: null,
      price: price || null,
      images,
      attributes: {},
      confidence,
      extractor: 'meta-og',
      contentType: inferContentType({ ogType: pickMeta(doc, 'meta[property="og:type"]'), text: bodyText }),
    };
  },
};
