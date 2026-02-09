// skrypt/llm/ollamaClient.js
import { withOllamaSemaphore } from "./semaforOllama.js";
import { performance } from "node:perf_hooks";
import crypto from "node:crypto";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

// domyślne modele (zgodne z tym co chcesz wdrożyć)
const TEXT_MODEL =
  process.env.OLLAMA_TEXT_MODEL || process.env.LLM_MODEL || "llama3.2:3b";

const VISION_MODEL =
  process.env.OLLAMA_VISION_MODEL || process.env.LLM_VISION_MODEL || "llava";


// 0 = minimalnie, 1 = normal, 2 = verbose (preview prompt/response)
const DEBUG_LEVEL = Number(process.env.OLLAMA_DEBUG_LEVEL || 1);
// ile znaków promptu/response pokazać w logu (gdy DEBUG_LEVEL >= 2)
const PREVIEW_CHARS = Number(process.env.OLLAMA_DEBUG_PREVIEW_CHARS || 700);

function sha1(s) {
  try {
    return crypto.createHash("sha1").update(String(s || ""), "utf8").digest("hex");
  } catch {
    return null;
  }
}

function safePreview(s, n = PREVIEW_CHARS) {
  if (s == null) return null;
  const str = String(s);
  if (str.length <= n) return str;
  return str.slice(0, n) + `…[+${str.length - n} chars]`;
}

function looksLikeJsonText(t) {
  if (t == null) return false;
  const s = String(t).trim();
  return (s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"));
}

function isJsonRequested(format) {
  if (!format) return false;
  if (format === "json") return true;
  if (typeof format === "object") return true; // schema object
  return false;
}

function getCallerHint() {
  try {
    const st = new Error().stack || "";
    const lines = st.split("\n").map((l) => l.trim());
    const interesting = lines
      .slice(3)
      .find((l) => l && !l.includes("ollamaClient.js") && !l.includes("semaforOllama.js"));
    return interesting || lines[3] || null;
  } catch {
    return null;
  }
}

function attachAsStringObject(text, raw, parsedJson, meta) {
  const sObj = new String(text ?? "");
  sObj.text = text ?? "";
  sObj.raw = raw ?? null;
  sObj.json = parsedJson ?? null;
  sObj.meta = meta ?? null;
  return sObj;
}

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

      const requestId = crypto.randomUUID
        ? crypto.randomUUID()
        : crypto.randomBytes(8).toString("hex");
      const caller = getCallerHint();

      try {
        const body = {
          model,
          prompt,
          stream: !!stream,
          keep_alive: keepAlive != null ? keepAlive : resolveKeepAlive(),
          context: [],
        };

        if (system) body.system = system;
        if (format) body.format = format;
        if (Array.isArray(images) && images.length) body.images = images;
        if (options && typeof options === "object") body.options = options;

        if (DEBUG_LEVEL >= 1) {
          log?.info?.(`ollama_${label}_request`, {
            requestId,
            caller,
            model,
            hasSystem: !!system,
            formatType: format == null ? null : typeof format,
            format,
            promptChars: typeof prompt === "string" ? prompt.length : null,
            promptSha1: typeof prompt === "string" ? sha1(prompt) : null,
            imagesCount: Array.isArray(images) ? images.length : 0,
            optionsKeys: options && typeof options === "object" ? Object.keys(options) : null,
            timeoutMs: timeoutMsEff,
            keepAlive: body.keep_alive,
            stream: !!stream,
          });

          if (DEBUG_LEVEL >= 2) {
            log?.info?.(`ollama_${label}_request_preview`, {
              requestId,
              promptPreview: safePreview(prompt),
              systemPreview: safePreview(system),
            });
          }
        }

        const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        httpStatus = res.status;

        if (!res.ok) {
          const textErr = await res.text();
          throw new Error(`Ollama error (${res.status}): ${textErr}`);
        }

        const data = await res.json();
        ok = true;

        const text = data?.response ?? "";
        const wantsJson = isJsonRequested(format);

        let parsedJson = null;
        let jsonParseOk = false;
        let jsonParseErr = null;

        if (wantsJson) {
          try {
            if (looksLikeJsonText(text)) {
              parsedJson = JSON.parse(String(text));
              jsonParseOk = true;
            } else {
              const s = String(text || "");
              const firstObj = s.indexOf("{");
              const lastObj = s.lastIndexOf("}");
              const firstArr = s.indexOf("[");
              const lastArr = s.lastIndexOf("]");

              let candidate = null;
              if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) candidate = s.slice(firstObj, lastObj + 1);
              else if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) candidate = s.slice(firstArr, lastArr + 1);

              if (candidate) {
                parsedJson = JSON.parse(candidate);
                jsonParseOk = true;
              }
            }
          } catch (e) {
            jsonParseErr = String(e?.message || e);
          }
        }

        const meta = {
          requestId,
          caller,
          label,
          model,
          wantsJson,
          jsonParseOk,
          jsonParseErr,
          promptSha1: typeof prompt === "string" ? sha1(prompt) : null,
          promptChars: typeof prompt === "string" ? prompt.length : null,
          responseChars: typeof text === "string" ? text.length : null,
          responseSha1: typeof text === "string" ? sha1(text) : null,
          httpStatus,
        };

        if (DEBUG_LEVEL >= 1) {
          log?.info?.(`ollama_${label}_response_meta`, meta);
          log?.info?.(`ollama_${label}_response_keys`, {
            requestId,
            keys: data && typeof data === "object" ? Object.keys(data) : null,
          });

          if (DEBUG_LEVEL >= 2) {
            log?.info?.(`ollama_${label}_response_preview`, {
              requestId,
              responsePreview: safePreview(text),
              parsedJsonPreview: parsedJson ? safePreview(JSON.stringify(parsedJson)) : null,
            });
          }
        }

        return attachAsStringObject(text, data, parsedJson, meta);
      } catch (err) {
        aborted = err?.name === "AbortError";
        if (DEBUG_LEVEL >= 1) {
          log?.error?.(`ollama_${label}_error`, {
            requestId,
            caller,
            model,
            httpStatus,
            aborted,
            message: String(err?.message || err),
            stack: err?.stack ? safePreview(err.stack, 2000) : null,
          });
        }
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
