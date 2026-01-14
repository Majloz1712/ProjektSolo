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

export function stripMarkdownFences(text) {
  const raw = String(text || '');
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) {
    return raw;
  }
  const match = trimmed.match(/^```[\w-]*\s*\n([\s\S]*?)\n```$/);
  if (match) {
    return match[1];
  }
  const withoutStart = trimmed.replace(/^```[\w-]*\s*/, '');
  return withoutStart.replace(/```$/, '').trim();
}

export function findTracklyBlock(text) {
  const match = String(text || '').match(/BEGIN_TRACKLY_ANALYSIS[\s\S]*?END_TRACKLY_ANALYSIS/);
  return match ? match[0] : null;
}

function parseNullableNumber(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'null') return null;
  const normalized = trimmed.replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNullableString(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

export function parseKeyValueBlock(rawResponse) {
  const text = String(rawResponse || '');
  if (!text.trim()) {
    return {
      parseMode: 'none',
      extracted: false,
      error: 'LLM_NO_BLOCK_FOUND',
      parsed: null,
    };
  }

  const block = findTracklyBlock(text);
  if (!block) {
    return {
      parseMode: 'none',
      extracted: false,
      error: 'LLM_NO_BLOCK_FOUND',
      parsed: null,
    };
  }

  try {
    const direct = text.trim().startsWith('BEGIN_TRACKLY_ANALYSIS');
    const parseMode = direct ? 'direct' : 'extracted';
    const extracted = !direct;

    const cleanedBlock = stripMarkdownFences(block);
    const inner = cleanedBlock
      .replace(/BEGIN_TRACKLY_ANALYSIS/, '')
      .replace(/END_TRACKLY_ANALYSIS/, '')
      .trim();

    const parsed = {
      summary: null,
      product_type: null,
      main_currency: null,
      price_hint: { min: null, max: null },
      features: [],
    };

    const lines = inner.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim().toUpperCase();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (key === 'SUMMARY') parsed.summary = parseNullableString(value);
      if (key === 'PRODUCT_TYPE') parsed.product_type = parseNullableString(value);
      if (key === 'MAIN_CURRENCY') parsed.main_currency = parseNullableString(value);
      if (key === 'PRICE_MIN') parsed.price_hint.min = parseNullableNumber(value);
      if (key === 'PRICE_MAX') parsed.price_hint.max = parseNullableNumber(value);
      if (key === 'FEATURE') {
        const featureValue = parseNullableString(value);
        if (featureValue) parsed.features.push(featureValue);
      }
    }

    return {
      parseMode,
      extracted,
      error: null,
      parsed,
    };
  } catch {
    return {
      parseMode: 'extracted',
      extracted: true,
      error: 'LLM_KV_PARSE_ERROR',
      parsed: null,
    };
  }
}

export function normalizePriceHint(ph) {
  if (!ph || typeof ph !== 'object') {
    return { min: null, max: null };
  }
  const min = parseNullableNumber(ph.min ?? null);
  const max = parseNullableNumber(ph.max ?? null);
  return {
    min: typeof min === 'number' ? min : null,
    max: typeof max === 'number' ? max : null,
  };
}
