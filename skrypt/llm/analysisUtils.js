import crypto from 'node:crypto';

export function sanitizeNullableString(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

export function sanitizeRequiredString(value) {
  if (value == null) return '';
  const s = String(value).trim();
  return s.length ? s : '';
}

export function hashUserPrompt(userPrompt) {
  if (!userPrompt) return null;
  return crypto.createHash('sha1').update(String(userPrompt)).digest('hex');
}

export function parseTrackedFields(userPrompt) {
  const raw = (userPrompt || '').toString().toLowerCase();
  if (!raw.trim()) {
    return { trackedFields: [], strict: false };
  }

  const fields = new Set();

  if (raw.includes('cena') || raw.includes('price')) {
    fields.add('main_price');
  }
  if (raw.includes('opinie') || raw.includes('opinii') || raw.includes('reviews') || raw.includes('review')) {
    fields.add('review_count');
  }
  if (raw.includes('oceny') || raw.includes('rating')) {
    fields.add('rating');
  }

  return { trackedFields: [...fields], strict: true };
}
