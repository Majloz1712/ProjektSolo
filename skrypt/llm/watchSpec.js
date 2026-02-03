import crypto from 'crypto';
import { generateTextWithOllama } from './ollamaClient.js';
import { safeJsonParse } from './analysisUtils.js';

/**
 * watch_spec_v1 – prompt-driven spec that defines WHICH fields matter for change detection.
 *
 * This version intentionally avoids relying on predefined `metrics.*`.
 * All watched fields are treated as `universal_data` keys driven by the watch spec.
 */

export function hashUserPrompt(userPrompt = '') {
  return crypto.createHash('sha256').update(String(userPrompt)).digest('hex');
}

export function normalizeNumberLike(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = String(value).trim().replace(/\s+/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function normalizeStringLike(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

/**
 * Validate and normalize watch spec.
 * - Accepts legacy fields where source could be "metrics"
 * - Normalizes EVERYTHING into source="universal_data"
 * - If legacy field had path but missing id -> uses path as id
 */
export function validateWatchSpec(maybeSpec) {
  if (!maybeSpec || typeof maybeSpec !== 'object') return null;
  const spec = { ...maybeSpec };
  if (spec.version !== 'watch_spec_v1') return null;
  if (!Array.isArray(spec.fields)) return null;

  const fields = [];
  for (const f of spec.fields) {
    if (!f || typeof f !== 'object') continue;

    const rawSource = f.source === 'metrics' || f.source === 'universal_data' ? f.source : null;
    if (!rawSource) continue;

    const idFromId = typeof f.id === 'string' ? f.id.trim() : '';
    const idFromPath = typeof f.path === 'string' ? f.path.trim() : '';
    const id = (idFromId || idFromPath || '').trim();

    const label = typeof f.label === 'string' ? f.label.trim() : '';
    const type = f.type === 'number' || f.type === 'string' ? f.type : 'string';
    const trigger = ['changed', 'increased', 'decreased'].includes(f.trigger) ? f.trigger : 'changed';

    if (!id || !label) continue;

    fields.push({
      id,
      label,
      source: 'universal_data', // always normalize
      type,
      trigger,
    });
  }

  if (!fields.length) return null;

  return {
    version: 'watch_spec_v1',
    only_these_fields: spec.only_these_fields === true,
    fields,
    notes: typeof spec.notes === 'string' ? spec.notes.trim() : undefined,
  };
}

export async function generateWatchSpecWithLLM({ userPrompt, model, logger }) {
  const system =
    'Jesteś asystentem, który z polecenia użytkownika tworzy specyfikację obserwowanych pól (watch_spec_v1).\n' +
    'Zwróć WYŁĄCZNIE poprawny JSON (bez komentarzy, bez markdown).';

  const prompt =
    `USER_PROMPT (PL):\n${String(userPrompt || '').trim()}\n\n` +
    'Wygeneruj JSON o strukturze:\n' +
    '{\n' +
    '  "version": "watch_spec_v1",\n' +
    '  "only_these_fields": true,\n' +
    '  "fields": [\n' +
    '    {"id": "...", "label": "...", "source": "universal_data", "type": "number"|"string", "trigger": "changed"|"increased"|"decreased"}\n' +
    '  ],\n' +
    '  "notes": "krótka notatka (opcjonalnie)"\n' +
    '}\n\n' +
    'Zasady:\n' +
    '- Spec ma odzwierciedlać WYŁĄCZNIE to, co użytkownik uznaje za istotną zmianę.\n' +
    '- Jeśli użytkownik mówi "powiadom tylko gdy X" – dodaj tylko X.\n' +
    '- NIE używaj source="metrics". Wszystko ma być opisane jako pola universal_data.\n' +
    '- id ma być stabilnym kluczem (snake_case jeśli się da).\n' +
    '- Dla liczników ustaw type="number" i trigger="increased" jeśli user chce powiadomień o wzroście.\n' +
    '- Zwróć tylko JSON.';

  const out = await generateTextWithOllama({
    model,
    system,
    prompt,
    format: 'json',
    temperature: 0,
    options: { top_k: 1, top_p: 1, seed: 42 },
    stream: false,
    logger,
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS_WATCHSPEC || process.env.OLLAMA_TIMEOUT_MS || 120000),
  });

  const parsed = safeJsonParse(out);
  if (!parsed) {
    logger?.warn?.('watchspec_llm_invalid_json', {
      hasOutput: !!out && String(out).trim().length > 0,
      outputPreview: String(out || '').slice(0, 240),
    });
  }
  return validateWatchSpec(parsed);
}

export function getValueByWatchField(field, analysis) {
  if (!field || !analysis) return null;

  const arr = Array.isArray(analysis.universal_data) ? analysis.universal_data : [];
  const hit = arr.find((x) => x && typeof x === 'object' && x.key === field.id);
  return hit ? hit.value ?? null : null;
}

export function sanitizeAnalysisByWatchSpec(analysis, watchSpec) {
  if (!analysis || !watchSpec) return analysis;
  const spec = validateWatchSpec(watchSpec);
  if (!spec) return analysis;

  // Always neutralize metrics to avoid hard-coded semantics.
  const metrics = { rating: null, reviews_count: null };

  // If strict spec -> filter universal_data to only watched fields (ALL are universal_data now).
  let universal_data = Array.isArray(analysis.universal_data) ? analysis.universal_data : [];
  if (spec.only_these_fields) {
    const allowed = new Set(spec.fields.map((f) => f.id));
    universal_data = universal_data
      .filter((x) => x && typeof x === 'object' && allowed.has(x.key))
      .map((x) => ({ key: x.key, label: x.label ?? x.key, value: x.value ?? null }));
  }

  return {
    ...analysis,
    metrics,
    universal_data,
    watch_spec: spec,
  };
}

export function computeWatchDelta(watchSpec, prevAnalysis, newAnalysis) {
  const spec = validateWatchSpec(watchSpec);
  if (!spec) {
    return {
      spec: null,
      anyChanged: false,
      allComparable: false,
      hasUnknown: true,
      changes: [],
      unknown: [],
    };
  }

  const changes = [];
  const unknown = [];

  for (const field of spec.fields) {
    const prevRaw = getValueByWatchField(field, prevAnalysis);
    const newRaw = getValueByWatchField(field, newAnalysis);
    const prev = field.type === 'number' ? normalizeNumberLike(prevRaw) : normalizeStringLike(prevRaw);
    const next = field.type === 'number' ? normalizeNumberLike(newRaw) : normalizeStringLike(newRaw);

    if (prev === null || next === null) {
      unknown.push({ id: field.id, label: field.label, prev: prevRaw ?? null, next: newRaw ?? null });
      continue;
    }

    let changed = false;
    if (field.type === 'number') {
      if (field.trigger === 'changed') changed = prev !== next;
      else if (field.trigger === 'increased') changed = next > prev;
      else if (field.trigger === 'decreased') changed = next < prev;
    } else {
      changed = prev !== next;
    }

    if (changed) {
      changes.push({ id: field.id, label: field.label, prev, next, trigger: field.trigger });
    }
  }

  return {
    spec,
    anyChanged: changes.length > 0,
    allComparable: unknown.length === 0,
    hasUnknown: unknown.length > 0,
    changes,
    unknown,
  };
}

