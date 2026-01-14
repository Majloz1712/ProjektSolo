import crypto from 'node:crypto';

export const SYSTEM_DEFAULT_JUDGE_PROMPT =
  'Powiadom o istotnych zmianach na stronie produktu, w szczególności cena, dostępność, opinie oraz parametry; ignoruj zmiany kosmetyczne, stopki i banery cookies.';

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

export function normalizeUserPrompt(userPrompt) {
  const trimmed = (userPrompt ?? '').toString().trim();
  return trimmed.length ? trimmed : null;
}

export function resolveEffectivePrompt(userPrompt, systemPrompt) {
  return normalizeUserPrompt(userPrompt) || systemPrompt;
}

export function extractJsonFromText(rawResponse, { maxLength = 20000, maxAttempts = 3 } = {}) {
  const text = String(rawResponse || '').slice(0, maxLength);
  if (!text.trim()) {
    return { ok: false, error: 'EMPTY_RESPONSE' };
  }

  const candidates = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      candidates.push({ start: i, open: ch, close: ch === '{' ? '}' : ']' });
      if (candidates.length >= maxAttempts) break;
    }
  }

  let attempts = 0;
  for (const candidate of candidates) {
    if (attempts >= maxAttempts) break;
    attempts += 1;

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = candidate.start; i < text.length; i += 1) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === candidate.open) depth += 1;
      if (ch === candidate.close) depth -= 1;
      if (depth === 0 && i > candidate.start) {
        const slice = text.slice(candidate.start, i + 1).trim();
        try {
          const value = JSON.parse(slice);
          return {
            ok: true,
            value,
            extracted: candidate.start !== 0 || i + 1 !== text.length,
          };
        } catch {
          break;
        }
      }
    }
  }

  return { ok: false, error: 'NO_JSON_FOUND' };
}
