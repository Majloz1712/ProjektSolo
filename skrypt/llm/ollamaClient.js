// ./skrypt/llm/ollamaClient.js
import { withOllamaSemaphore } from './semaforOllama.js';
import { performance } from 'node:perf_hooks';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const TEXT_MODEL = process.env.LLM_MODEL || 'llama3';

export async function generateTextWithOllama({ prompt, model = TEXT_MODEL, logger }) {
  const log = logger || console;

  return withOllamaSemaphore(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    const t0 = performance.now();
    let ok = false;
    let httpStatus = null;
    let aborted = false;

    try {
      const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
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

      log.info('ollama_generate_done', {
        model,
        ok,
        httpStatus,
        aborted,
        promptChars: typeof prompt === 'string' ? prompt.length : null,
        durationMs: Math.round(performance.now() - t0),
      });
    }
  }, { logger: log, label: 'generate' });
}



export async function analyzeImageWithOllama({
  model = TEXT_MODEL,
  prompt,
  base64Image,
  logger,
}) {
  const log = logger || console;

  return withOllamaSemaphore(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    const t0 = performance.now();
    let ok = false;
    let httpStatus = null;
    let aborted = false;

    try {
      const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          images: [base64Image],
          stream: false,
        }),
      });

      httpStatus = res.status;

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama vision error (${res.status}): ${text}`);
      }

      const data = await res.json();
      ok = true;
      return data.response;
    } catch (err) {
      aborted = err?.name === 'AbortError';
      throw err;
    } finally {
      clearTimeout(timeout);

      log.info('ollama_vision_done', {
        model,
        ok,
        httpStatus,
        aborted,
        promptChars: typeof prompt === 'string' ? prompt.length : null,
        imageChars: typeof base64Image === 'string' ? base64Image.length : null,
        durationMs: Math.round(performance.now() - t0),
      });
    }
  },{ logger: log, label: 'vision' });
}

