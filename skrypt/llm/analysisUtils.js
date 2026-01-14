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

export function extractFirstJsonObject(text, maxAttempts = 3) {
  const input = String(text || '');
  if (!input.trim()) return null;

  const starts = [];
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === '{') {
      starts.push(i);
      if (starts.length >= maxAttempts) break;
    }
  }

  for (const start of starts) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < input.length; i += 1) {
      const ch = input[i];
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
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      if (depth === 0 && i > start) {
        const slice = input.slice(start, i + 1).trim();
        try {
          return JSON.parse(slice);
        } catch {
          break;
        }
      }
    }
  }

  return null;
}

export function parseJsonFromLLM(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return { ok: false, error: 'LLM_NO_JSON_FOUND' };

  try {
    return { ok: true, data: JSON.parse(text), mode: 'direct' };
  } catch {
    const extracted = extractFirstJsonObject(text, 3);
    if (extracted != null) {
      return { ok: true, data: extracted, mode: 'extracted' };
    }
  }

  return { ok: false, error: 'LLM_NO_JSON_FOUND' };
}
