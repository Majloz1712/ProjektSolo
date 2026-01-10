import { normalizePriceCandidate } from "../utils/normalize.js";

const PRICE_SELECTORS = [
  '[itemprop="price"]',
  '[data-price]',
  '[data-price-value]',
  '[data-main-price]',
  '.price',
  '.price__value',
  '.product-price',
  '.offer-price',
  '.main-price',
  '.product__price',
];

const EXCLUDED_PRICE_HINTS = [
  'rata',
  'raty',
  'miesięcz',
  'miesiecz',
  'od ',
  'od:',
  'używan',
  'uzywan',
  'najniższa',
  'najnizsza',
  'outlet',
];

function isExcludedPriceText(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return EXCLUDED_PRICE_HINTS.some((hint) => lower.includes(hint));
}

function readElementPrice(el) {
  if (!el) return null;
  const attrValue =
    el.getAttribute?.("content") ||
    el.getAttribute?.("value") ||
    el.getAttribute?.("data-price") ||
    el.getAttribute?.("data-price-value") ||
    el.getAttribute?.("data-main-price");
  const text = attrValue || el.textContent || "";
  if (!text) return null;
  if (isExcludedPriceText(text)) return null;
  return normalizePriceCandidate(text);
}

export function detectMainPriceFromDom(doc) {
  if (!doc) return null;

  for (const selector of PRICE_SELECTORS) {
    const elements = Array.from(doc.querySelectorAll(selector));
    for (const el of elements) {
      const price = readElementPrice(el);
      if (price) return price;
    }
  }

  return null;
}
