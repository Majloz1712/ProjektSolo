import {
  normalizeWhitespace,
  normalizePriceCandidate,
  sanitizeArray,
  inferContentType,
} from '../utils/normalize.js';
import { detectMainPriceFromDom } from './priceUtils.js';

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

function normalizeTypes(entry) {
  const t = entry?.['@type'];
  if (!t) return [];
  const arr = Array.isArray(t) ? t : [t];
  return arr.map((x) => String(x || '').toLowerCase()).filter(Boolean);
}

function hasType(entry, needle) {
  const types = normalizeTypes(entry);
  return types.some((t) => t.includes(needle));
}

function scoreEntry(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  if (hasType(entry, 'product')) return 1.0;
  if (hasType(entry, 'itemlist')) return 0.98;
  if (hasType(entry, 'collectionpage') || hasType(entry, 'searchresults') || hasType(entry, 'webpage')) return 0.65;
  if (hasType(entry, 'article') || hasType(entry, 'newsarticle') || hasType(entry, 'blogposting')) return 0.9;
  return 0.4;
}

function extractImages(entry) {
  const values = [];
  const props = ['image', 'imageUrl', 'imageurl', 'thumbnailUrl'];
  for (const prop of props) {
    const val = entry?.[prop];
    if (!val) continue;
    if (typeof val === 'string') values.push(val);
    else if (Array.isArray(val)) values.push(...val.filter((x) => typeof x === 'string'));
    else if (val?.url) values.push(val.url);
  }
  return sanitizeArray(values);
}

function extractAttributes(entry) {
  const attrs = {};
  if (!entry || typeof entry !== 'object') return attrs;

  const candidates = ['brand', 'sku', 'mpn', 'gtin13', 'gtin', 'model', 'category'];
  for (const key of candidates) {
    if (!entry[key]) continue;
    const value = entry[key];
    if (typeof value === 'object' && value?.name) attrs[key] = normalizeWhitespace(value.name);
    else attrs[key] = normalizeWhitespace(String(value));
  }

  return attrs;
}

function pickName(obj) {
  return normalizeWhitespace(obj?.name || obj?.headline || obj?.title || '');
}

function pickDescription(obj) {
  return normalizeWhitespace(obj?.description || obj?.abstract || obj?.articleBody || '');
}

function pickOfferPrice(obj) {
  const offersRaw = obj?.offers;
  const offers = Array.isArray(offersRaw) ? offersRaw : offersRaw ? [offersRaw] : [];
  for (const offer of offers) {
    if (!offer) continue;
    const amount = offer.price ?? offer.lowPrice ?? null;
    const currency = offer.priceCurrency ?? offer.currency ?? null;
    const cand = amount != null
      ? `${amount} ${currency || ''}`.trim()
      : null;
    const p = normalizePriceCandidate(cand);
    if (p) return p;
  }

  // sometimes product has direct price fields
  const directAmount = obj?.price ?? null;
  const directCurrency = obj?.priceCurrency ?? null;
  const p2 = normalizePriceCandidate(
    directAmount != null ? `${directAmount} ${directCurrency || ''}`.trim() : null
  );
  return p2 || null;
}

function normalizeItemListElements(entry) {
  const raw = entry?.itemListElement || entry?.itemListElements || entry?.itemList || null;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter(Boolean);
}

function extractItemFromListElement(el) {
  // ListItem can have "item" or direct Product-ish object
  if (!el) return null;
  if (typeof el === 'string') return null; // URL only (skip; we avoid fetching here)
  if (el.item) return el.item;
  return el;
}

function buildStructuredTextFromProduct(entry) {
  const lines = [];
  const name = pickName(entry);
  const desc = pickDescription(entry);
  const price = pickOfferPrice(entry);

  if (name) lines.push(`# ${name}`);
  if (price) lines.push(`Cena: ${price.value} ${price.currency}`);
  const attrs = extractAttributes(entry);
  for (const [k, v] of Object.entries(attrs)) {
    if (!v) continue;
    // keep it stable: TitleCase key-ish
    lines.push(`${k}: ${v}`);
  }
  if (desc) {
    lines.push('');
    lines.push(desc);
  }

  const text = lines.join('\n').trim();
  return {
    text,
    attributes: { ...attrs, structured: true, jsonld_kind: 'product' },
    images: extractImages(entry),
    price: price || null,
    title: name || null,
    description: desc || null,
  };
}

function buildStructuredTextFromItemList(entry) {
  const lines = [];
  const title = pickName(entry);
  const desc = pickDescription(entry);

  if (title) lines.push(`# ${title}`);
  if (desc) lines.push(desc);

  lines.push('## Lista pozycji');

  const elements = normalizeItemListElements(entry);
  const items = [];
  for (const el of elements) {
    const item = extractItemFromListElement(el);
    if (!item || typeof item !== 'object') continue;
    const name = pickName(item);
    if (!name) continue;
    const price = pickOfferPrice(item);
    items.push({ name, price });
    if (items.length >= 180) break; // guard
  }

  for (const it of items) {
    if (it.price) lines.push(`- ${it.name} — ${it.price.value} ${it.price.currency}`);
    else lines.push(`- ${it.name}`);
  }

  const text = lines.join('\n').trim();
  return {
    text,
    attributes: { structured: true, jsonld_kind: 'itemlist', item_count: items.length },
    images: extractImages(entry),
    price: null,
    title: title || null,
    description: desc || null,
  };
}

export const jsonldExtractor = {
  name: 'jsonld',

  detect(doc) {
    const payloads = flattenScripts(doc);
    if (!payloads.length) return 0;
    return Math.max(...payloads.map(scoreEntry), 0);
  },

  extract(doc, { url }) {
    const payloads = flattenScripts(doc);
    if (!payloads.length) return null;

    const scored = payloads
      .map((entry) => ({ entry, score: scoreEntry(entry) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best?.entry) return null;

    const entry = best.entry;
    const types = normalizeTypes(entry);
    const type0 = types[0] || null;

    // Prefer fully-structured outputs when possible.
    let structured = null;
    if (hasType(entry, 'itemlist') || entry?.itemListElement) {
      structured = buildStructuredTextFromItemList(entry);
    } else if (hasType(entry, 'product')) {
      structured = buildStructuredTextFromProduct(entry);
    } else {
      const title = pickName(entry);
      const description = pickDescription(entry);
      structured = {
        text: description || null,
        attributes: extractAttributes(entry),
        images: extractImages(entry),
        price: pickOfferPrice(entry),
        title: title || null,
        description: description || null,
      };
    }

    const domPrice = detectMainPriceFromDom(doc);
    const mainPrice = domPrice || structured.price || null;

    const confidence = Math.min(1, 0.75 + (best.score || 0.2) * 0.25);

    return {
      url,
      title: structured.title || null,
      description: structured.description || null,
      text: structured.text || structured.description || null,
      htmlMain: null,
      price: mainPrice,
      images: structured.images || [],
      attributes: structured.attributes || {},
      confidence,
      extractor: 'jsonld',
      contentType: inferContentType({ jsonLdType: type0, text: structured.text || '' }),
    };
  },
};
