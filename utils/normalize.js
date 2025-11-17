const CURRENCY_SYMBOLS = {
  'zł': 'PLN',
  'pln': 'PLN',
  'zl': 'PLN',
  '€': 'EUR',
  'eur': 'EUR',
  '£': 'GBP',
  'gbp': 'GBP',
  '$': 'USD',
  'usd': 'USD',
};

export function normalizeWhitespace(value) {
  if (typeof value !== 'string') return value ?? '';
  return value.replace(/\s+/g, ' ').trim();
}

function detectCurrency(fragment = '') {
  const lower = fragment.toLowerCase();
  for (const [symbol, currency] of Object.entries(CURRENCY_SYMBOLS)) {
    if (lower.includes(symbol)) return currency;
  }
  return null;
}

export function normalizePriceCandidate(raw) {
  if (!raw) return null;
  const cleaned = normalizeWhitespace(String(raw));
  if (!cleaned) return null;
  const match = cleaned.match(/([\d\s.,]+)\s*([a-zA-Zżł€£$]{0,4})/u);
  if (!match) return null;
  const numberPart = match[1].replace(/[\s]/g, '').replace(',', '.');
  const value = Number.parseFloat(numberPart);
  if (!Number.isFinite(value)) return null;
  const currencyFragment = match[2] || cleaned;
  const currency = detectCurrency(currencyFragment) || null;
  return { value, currency };
}

export function clampTextLength(text, max = 20000) {
  if (typeof text !== 'string') return text ?? '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function inferContentType({ jsonLdType, ogType, text = '' } = {}) {
  const normalizedType = (jsonLdType || ogType || '').toLowerCase();
  if (normalizedType.includes('product')) return 'product';
  if (normalizedType.includes('article') || normalizedType.includes('news')) return 'article';
  if (normalizedType.includes('blog')) return 'article';
  const lowered = text.toLowerCase();
  if (lowered.includes('produkt') || lowered.includes('cena')) return 'product';
  if (lowered.includes('autor') || lowered.includes('data publikacji')) return 'article';
  return 'page';
}

export function sanitizeArray(input) {
  if (!Array.isArray(input)) return [];
  return input.filter((item) => typeof item === 'string' && item.trim()).map((item) => normalizeWhitespace(item));
}

export function toISODate(value) {
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}
