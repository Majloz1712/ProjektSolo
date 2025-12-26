// skrypt/llm/ollamaClient.js
import { withOllamaSemaphore } from './semaforOllama.js';
import { performance } from 'node:perf_hooks';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

// zgodne z Twoim .env:
const TEXT_MODEL =
  process.env.OLLAMA_TEXT_MODEL || process.env.LLM_MODEL || 'llama3';

const VISION_MODEL =
  process.env.OLLAMA_VISION_MODEL || process.env.LLM_VISION_MODEL || 'llava';

function normalizeB64(input) {
  if (!input) return null;
  let s = String(input).trim();

  // obsługa "data:image/png;base64,...."
  const idx = s.indexOf('base64,');
  if (idx !== -1) s = s.slice(idx + 'base64,'.length).trim();

  // obsługa "data:...,<base64>"
  if (s.startsWith('data:')) {
    const comma = s.indexOf(',');
    if (comma !== -1) s = s.slice(comma + 1).trim();
  }

  return s.length ? s : null;
}

/**
 * Niskopoziomowe wywołanie /api/generate (Ollama).
 * Zwraca `data.response` (string).
 */
async function ollamaGenerate({ model, prompt, images, options }, logger, label) {
  const log = logger || console;

  return withOllamaSemaphore(
    async () => {
      const controller = new AbortController();
      const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS || 300000);
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const t0 = performance.now();
      let ok = false;
      let httpStatus = null;
      let aborted = false;

      try {
        const body = {
          model,
          prompt,
          stream: false,
        };

        if (Array.isArray(images) && images.length) body.images = images;
        if (options && typeof options === 'object') body.options = options;

        const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        httpStatus = res.status;

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Ollama error (${res.status}): ${text}`);
        }

        const data = await res.json();
        ok = true;
        return data.response;
      } catch (err) {
        aborted = err?.name === 'AbortError';
        throw err;
      } finally {
        clearTimeout(timeout);
        log.info(`ollama_${label}_done`, {
          model,
          ok,
          httpStatus,
          aborted,
          promptChars: typeof prompt === 'string' ? prompt.length : null,
          imagesCount: Array.isArray(images) ? images.length : 0,
          durationMs: Math.round(performance.now() - t0),
        });
      }
    },
    { logger: log, label },
  );
}

export async function generateTextWithOllama({
  prompt,
  model = TEXT_MODEL,
  logger,
  options,
}) {
  return ollamaGenerate({ model, prompt, options }, logger, 'generate');
}

export async function analyzeImageWithOllama({
  prompt,
  base64Image,
  model = VISION_MODEL,
  logger,
  options,
}) {
  const img = normalizeB64(base64Image);
  return ollamaGenerate(
    { model, prompt, images: img ? [img] : [], options },
    logger,
    'vision',
  );
}

/**
 * 2 obrazy (prev/new) w jednym callu.
 * Domyślnie temperatura=0 żeby zminimalizować halucynacje.
 */
export async function compareImagesWithOllama({
  prompt,
  base64Images,
  model = VISION_MODEL,
  logger,
  options = { temperature: 0, top_p: 0.1, repeat_penalty: 1.1 },
}) {
  const imgs = (base64Images || []).map(normalizeB64).filter(Boolean);
  return ollamaGenerate(
    { model, prompt, images: imgs, options },
    logger,
    'vision_compare',
  );
}

// W razie gdybyś chciał OCR 1 obraz / call (opcjonalnie)
export async function ocrImageWithOllama({
  prompt,
  base64Image,
  model = VISION_MODEL,
  logger,
}) {
  const img = normalizeB64(base64Image);
  return ollamaGenerate(
    {
      model,
      prompt,
      images: img ? [img] : [],
      options: { temperature: 0, top_p: 0.1, repeat_penalty: 1.1 },
    },
    logger,
    'vision_ocr',
  );
}

