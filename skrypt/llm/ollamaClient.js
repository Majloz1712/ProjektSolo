// skrypt/llm/ollamaClient.js
import { withOllamaSemaphore } from "./semaforOllama.js";
import { performance } from "node:perf_hooks";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

// domyślne modele (zgodne z tym co chcesz wdrożyć)
const TEXT_MODEL =
  process.env.OLLAMA_TEXT_MODEL || process.env.LLM_MODEL || "llama3.2:3b";

const VISION_MODEL =
  process.env.OLLAMA_VISION_MODEL || process.env.LLM_VISION_MODEL || "llava";

function normalizeB64(input) {
  if (!input) return null;
  let s = String(input).trim();

  // "data:image/png;base64,...."
  const idx = s.indexOf("base64,");
  if (idx !== -1) s = s.slice(idx + "base64,".length).trim();

  // "data:...,<base64>"
  if (s.startsWith("data:")) {
    const comma = s.indexOf(",");
    if (comma !== -1) s = s.slice(comma + 1).trim();
  }

  return s.length ? s : null;
}

/**
 * Niskopoziomowe wywołanie /api/generate (Ollama).
 * Zwraca `data.response` (string).
 *
 * WAŻNE: wspiera `system` oraz `format: "json"` (Twoje wymagania).
 */
function resolveKeepAlive() {
  // Ollama wspiera: 0, liczby sekund, albo stringi typu "10m".
  const raw = process.env.OLLAMA_KEEP_ALIVE;
  if (raw == null || raw === '') return '10m';
  if (raw === '0' || raw === 'false' || raw === 'off') return 0;
  // liczba -> sekundy
  if (/^\d+$/.test(String(raw))) return Number(raw);
  return String(raw);
}

async function ollamaGenerate(
  { model, prompt, system, format, images, options, stream = false, timeoutMs, keepAlive },
  logger,
  label,
) {
  const log = logger || console;

  return withOllamaSemaphore(
    async () => {
      const controller = new AbortController();
      const timeoutMsEff =
        timeoutMs != null ? Number(timeoutMs) : Number(process.env.OLLAMA_TIMEOUT_MS || 300000);
      const timeout = setTimeout(() => controller.abort(), timeoutMsEff);

      const t0 = performance.now();
      let ok = false;
      let httpStatus = null;
      let aborted = false;

      try {
        const body = {
          model,
          prompt,
          stream: !!stream,
          keep_alive: keepAlive != null ? keepAlive : resolveKeepAlive(),
          context: [],
        };


        if (system) body.system = system;
        if (format) body.format = format; // np. "json"
        if (Array.isArray(images) && images.length) body.images = images;
        if (options && typeof options === "object") body.options = options;

        const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        httpStatus = res.status;

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Ollama error (${res.status}): ${text}`);
        }

        const data = await res.json();
        ok = true;
        return data?.response ?? "";
      } catch (err) {
        aborted = err?.name === "AbortError";
        throw err;
      } finally {
        clearTimeout(timeout);
        log?.info?.(`ollama_${label}_done`, {
          model,
          ok,
          httpStatus,
          aborted,
          hasSystem: !!system,
          format: format || null,
          promptChars: typeof prompt === "string" ? prompt.length : null,
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
  system,
  format, // "json"
  model = TEXT_MODEL,
  logger,
  options,
  stream = false,
  temperature,
  timeoutMs,
  keepAlive,
}) {
  const opts =
    temperature != null
      ? { ...(options || {}), temperature: Number(temperature) }
      : options;

  return ollamaGenerate(
    { model, prompt, system, format, options: opts, stream, timeoutMs, keepAlive },
    logger,
    "generate",
  );
}

export async function analyzeImageWithOllama({
  prompt,
  system,
  format,
  base64Image,
  model = VISION_MODEL,
  logger,
  options,
  stream = false,
  temperature,
}) {
  const img = normalizeB64(base64Image);
  const opts =
    temperature != null
      ? { ...(options || {}), temperature: Number(temperature) }
      : options;

  return ollamaGenerate(
    {
      model,
      prompt,
      system,
      format,
      images: img ? [img] : [],
      options: opts,
      stream,
    },
    logger,
    "vision",
  );
}

/**
 * 2 obrazy (prev/new) w jednym callu.
 */
export async function compareImagesWithOllama({
  prompt,
  system,
  format,
  base64Images,
  model = VISION_MODEL,
  logger,
  options,
  stream = false,
}) {
  const imgs = (base64Images || []).map(normalizeB64).filter(Boolean);

  const opts =
    options && typeof options === "object"
      ? options
      : { temperature: 0, top_p: 0.1, repeat_penalty: 1.1 };

  return ollamaGenerate(
    { model, prompt, system, format, images: imgs, options: opts, stream },
    logger,
    "vision_compare",
  );
}

export async function ocrImageWithOllama({
  prompt,
  system,
  format,
  base64Image,
  model = VISION_MODEL,
  logger,
}) {
  const img = normalizeB64(base64Image);
  return ollamaGenerate(
    {
      model,
      prompt,
      system,
      format,
      images: img ? [img] : [],
      options: { temperature: 0, top_p: 0.1, repeat_penalty: 1.1 },
      stream: false,
    },
    logger,
    "vision_ocr",
  );
}

