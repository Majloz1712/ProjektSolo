import { normalizeWhitespace, normalizePriceCandidate, sanitizeArray, inferContentType } from '../utils/normalize.js';

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function flattenScripts(doc) {
  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
  const payloads = [];
  for (const script of scripts) {
    const body = script.textContent?.trim();
    if (!body) continue;
    const parsed = parseJson(body);
    if (!parsed) continue;
    if (Array.isArray(parsed)) {
      payloads.push(...parsed);
    } else if (parsed['@graph'] && Array.isArray(parsed['@graph'])) {
      payloads.push(...parsed['@graph']);
    } else {
      payloads.push(parsed);
    }
  }
  return payloads;
}

function scoreEntry(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  const type = Array.isArray(entry['@type']) ? entry['@type'].join(',') : entry['@type'];
  if (!type) return 0;
  const lowered = String(type).toLowerCase();
  if (lowered.includes('product')) return 1;
  if (lowered.includes('article') || lowered.includes('newsarticle') || lowered.includes('blogposting')) return 0.9;
  if (lowered.includes('webpage')) return 0.6;
  return 0.4;
}

function extractImages(entry) {
  const values = [];
  const props = ['image', 'imageUrl', 'imageurl', 'thumbnailUrl'];
  for (const prop of props) {
    const val = entry[prop];
    if (!val) continue;
    if (typeof val === 'string') {
      values.push(val);
    } else if (Array.isArray(val)) {
      values.push(...val.filter((item) => typeof item === 'string'));
    } else if (val.url) {
      values.push(val.url);
    }
  }
  return sanitizeArray(values);
}

function extractText(entry) {
  const props = ['description', 'articleBody'];
  for (const prop of props) {
    const val = entry[prop];
    if (!val) continue;
    if (typeof val === 'string') return normalizeWhitespace(val);
  }
  return null;
}

function extractAttributes(entry) {
  const attrs = {};
  if (!entry || typeof entry !== 'object') return attrs;
  const candidates = ['brand', 'sku', 'mpn', 'gtin13', 'gtin', 'model'];
  for (const key of candidates) {
    if (!entry[key]) continue;
    const value = entry[key];
    if (typeof value === 'object' && value.name) {
      attrs[key] = normalizeWhitespace(value.name);
    } else {
      attrs[key] = normalizeWhitespace(String(value));
    }
  }
  return attrs;
}

export const jsonldExtractor = {
  name: 'jsonld',
  detect(doc) {
    const payloads = flattenScripts(doc);
    if (!payloads.length) return 0;
    const scores = payloads.map((entry) => scoreEntry(entry));
    return Math.max(...scores, 0);
  },
  extract(doc, { url }) {
    const payloads = flattenScripts(doc);
    if (!payloads.length) return null;
    const scored = payloads
      .map((entry) => ({ entry, score: scoreEntry(entry) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || !best.entry) return null;
    const entry = best.entry;
    const type = Array.isArray(entry['@type']) ? entry['@type'][0] : entry['@type'];
    const title = normalizeWhitespace(entry.name || entry.headline || entry.title || '');
    const description = normalizeWhitespace(entry.description || entry.abstract || '');
    const text = extractText(entry);
    const offers = Array.isArray(entry.offers) ? entry.offers : entry.offers ? [entry.offers] : [];
    let price = null;
    for (const offer of offers) {
      if (!offer) continue;
      price = normalizePriceCandidate(offer.priceCurrency ? `${offer.price} ${offer.priceCurrency}` : offer.price);
      if (price) break;
    }
    if (!price && entry.price) {
      price = normalizePriceCandidate(entry.priceCurrency ? `${entry.price} ${entry.priceCurrency}` : entry.price);
    }
    const images = extractImages(entry);
    const attributes = extractAttributes(entry);
    const confidence = Math.min(1, 0.7 + (best.score || 0.2));
    return {
      url,
      title: title || null,
      description: description || null,
      text: text || description || null,
      htmlMain: null,
      price: price || null,
      images,
      attributes,
      confidence,
      extractor: 'jsonld',
      contentType: inferContentType({ jsonLdType: type, text: text || description || '' }),
    };
  },
};
