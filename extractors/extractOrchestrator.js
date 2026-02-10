import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import puppeteer from "puppeteer";
import { performance } from "node:perf_hooks";

import { jsonldExtractor } from "../extractors/jsonldExtractor.js";
import { metaOgExtractor } from "../extractors/metaOgExtractor.js";
import { readabilityExtractor } from "../extractors/readabilityExtractor.js";
import { visibleTextExtractor } from "../extractors/visibleTextExtractor.js";
import { clampTextLength, normalizeWhitespace } from "../utils/normalize.js";
import { retryWithBackoff } from "../utils/retryBackoff.js";

const EXTRACTORS = [
  jsonldExtractor,
  metaOgExtractor,
  readabilityExtractor,
  visibleTextExtractor,
];

const KEY_FIELDS = ["title", "description", "text"];
const BLOCK_KEYWORDS = [
  "captcha",
  "cloudflare",
  "access denied",
  "verify you are human",
  "are you a robot",
  "robot check",
  "temporarily blocked",
  "service unavailable",
  "forbidden",
];

const LOGS_DIR = path.resolve(process.cwd(), "logs");
const BLOCKED_DIR = path.join(LOGS_DIR, "blocked");
const LOG_FILE = path.join(LOGS_DIR, "extractor.log");

fs.mkdirSync(BLOCKED_DIR, { recursive: true });

// -------------------------------
// Clean-lines for extracted DOM text (OCR-like output shape)
// Produces: { raw_text, clean_text, clean_lines, clean_meta }
// Stored alongside extracted_v2 to make diffs/chunking stable.
// -------------------------------

const EXTRACT_CLEAN_MAX_CHARS = Number(process.env.EXTRACT_CLEAN_MAX_CHARS || 25000);
const EXTRACT_CLEAN_MAX_LINES = Number(process.env.EXTRACT_CLEAN_MAX_LINES || 1400);
const EXTRACT_CLEAN_MAX_LINES_CHARS = Number(process.env.EXTRACT_CLEAN_MAX_LINES_CHARS || 650000);
const EXTRACT_CLEAN_WRAP = Number(process.env.EXTRACT_CLEAN_WRAP || 140);
const EXTRACT_CLEAN_MAX_LINE_LEN = Number(process.env.EXTRACT_CLEAN_MAX_LINE_LEN || 420);
const EXTRACT_CLEAN_MIN_CHARS_PER_LINE = Number(process.env.EXTRACT_CLEAN_MIN_CHARS_PER_LINE || 2);

function _normalizePreserveNewlines(value) {
  let s = String(value ?? '');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // NBSP -> space
  s = s.replace(/\u00A0/g, ' ');
  // Remove zero-width/control chars that break diffs
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, '');
  return s;
}

function _collapseSpacesPreserveNewlines(value) {
  const s = _normalizePreserveNewlines(value);
  return s
    .split('\n')
    .map((l) => l.replace(/[\t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function _lineExactKey(line) {
  return String(line)
    .toLowerCase()
    .replace(/[\u00A0]/g, ' ')
    .replace(/[\s]+/g, ' ')
    .trim();
}

function _lineQuality(line) {
  const s = String(line);
  const len = s.length || 1;
  let letters = 0;
  let digits = 0;
  let other = 0;
  for (const ch of s) {
    if (/\p{L}/u.test(ch)) letters++;
    else if (/\p{N}/u.test(ch)) digits++;
    else if (ch !== ' ') other++;
  }
  const alphaRatio = letters / len;
  const digitRatio = digits / len;
  const otherRatio = other / len;
  const tokenCount = s.trim().split(/\s+/).filter(Boolean).length;
  return { alphaRatio, digitRatio, otherRatio, tokenCount, letters, digits };
}

function _wrapIfSingleLine(text, wrapAt = 140) {
  const t = String(text ?? '');
  if (!t) return t;
  // If it's already multi-line, do nothing.
  if (t.includes('\n')) return t;

  // Only wrap when it's a big blob (common for DOM extract).
  if (t.length < Math.max(600, wrapAt * 3)) return t;

  const out = [];
  let buf = '';
  for (const token of t.split(/\s+/).filter(Boolean)) {
    if (!buf) {
      buf = token;
      continue;
    }
    if ((buf.length + 1 + token.length) <= wrapAt) {
      buf += ' ' + token;
    } else {
      out.push(buf);
      buf = token;
    }
  }
  if (buf) out.push(buf);
  return out.join('\n');
}

function _wrapLongLine(line, maxLen, { maxPieces = 10, minBacktrack = 20, maxBacktrack = 40 } = {}) {
  const s = String(line || '').trim();
  if (!s) return [];
  if (!maxLen || s.length <= maxLen) return [s];

  const parts = [];
  let i = 0;

  while (i < s.length && parts.length < maxPieces) {
    let end = Math.min(i + maxLen, s.length);

    // try to break on space near the end to avoid splitting words
    if (end < s.length) {
      const window = s.slice(i, end);
      const lastSpace = window.lastIndexOf(' ');
      const minIdx = Math.max(minBacktrack, window.length - maxBacktrack);
      if (lastSpace >= minIdx) end = i + lastSpace;
    }

    const chunk = s.slice(i, end).trim();
    if (chunk) parts.push(chunk);

    i = end;
    while (s[i] === ' ') i++;
  }

  // if we cut early, mark last chunk to indicate truncation
  if (i < s.length && parts.length) {
    parts[parts.length - 1] = parts[parts.length - 1].replace(/\s+$/, '') + ' …';
  }

  return parts;
}

function _stripJsonBlobs(text) {
  let s = String(text || '');
  if (!s) return s;

  // Remove large {...} / [...] blobs with very high JSON punctuation density.
  // This catches common SSR payloads (Nuxt/Next/etc.) without site-specific rules.
  for (let pass = 0; pass < 2; pass++) {
    s = s.replace(/[\[{][\s\S]{300,}?[\]}]/g, (m) => {
      const punct = (m.match(/[\[\]{}\":,]/g) || []).length;
      const letters = (m.match(/[\p{L}]/gu) || []).length;
      const digits = (m.match(/[\p{N}]/gu) || []).length;

      // if punctuation strongly dominates real content, drop it
      if (punct >= 120 && punct > (letters + digits)) return ' ';
      return m;
    });
  }

  // common hydration markers (still generic enough)
  s = s.replace(/\b(__NUXT__|__NEXT_DATA__|nuxtState|pinia)\b[\s\S]{0,200}/gi, ' ');

  return s;
}


function cleanExtractedToLines(rawText, opts = {}) {
  const {
    maxChars = EXTRACT_CLEAN_MAX_CHARS,
    maxLines = EXTRACT_CLEAN_MAX_LINES,
    maxLinesChars = EXTRACT_CLEAN_MAX_LINES_CHARS,
    wrapAt = EXTRACT_CLEAN_WRAP,
    maxLineLen = EXTRACT_CLEAN_MAX_LINE_LEN,
    minCharsPerLine = EXTRACT_CLEAN_MIN_CHARS_PER_LINE,
    // keep first occurrence of short repeating UI-like lines
    boilerplateMinFreq = 2,
    boilerplateMaxLineLen = 90,
    dedupeExact = true,
    dropMostlyJunkLines = true,
  } = opts;

  const raw = String(rawText ?? '');
  let s = raw;
  if (maxChars > 0 && s.length > maxChars) s = s.slice(0, maxChars);

  s = _wrapIfSingleLine(s, wrapAt);
  s = _collapseSpacesPreserveNewlines(s);

  s = _stripJsonBlobs(s);

  let lines = s.split('\n').map((l) => l.trim()).filter(Boolean);

  if (maxLineLen > 0) {
    lines = lines.flatMap((l) => _wrapLongLine(l, maxLineLen));
  }

  const removed = { junk: 0, boilerplate: 0, exact_dup: 0 };
  const counts = { in_lines: lines.length, out_lines: 0 };

  // 1) basic junk filter
  if (dropMostlyJunkLines) {
    const kept = [];
    for (const line of lines) {
      const q = _lineQuality(line);
      const alnum = q.letters + q.digits;
      if (alnum < minCharsPerLine) {
      // keep simple numeric-only tokens (e.g. 21, 2026, 14.99)
      const numericOk = /^\d{2,}([.,]\d+)?[%+]?$/u.test(line);
      if (!numericOk) {
        removed.junk++;
        continue;
      }
    }
      if (q.alphaRatio < 0.12 && q.digitRatio < 0.08 && q.otherRatio > 0.45 && line.length < 140) {
        removed.junk++;
        continue;
      }
      kept.push(line);
    }
    lines = kept;
  }

  // 2) boilerplate frequency (conservative): keep first UI-like line occurrence
  const fp = (line) =>
    String(line)
      .toLowerCase()
      .replace(/[\p{Sc}]/gu, ' ')
      .replace(/[\p{P}\p{S}]/gu, ' ')
      .replace(/[\s]+/g, ' ')
      .trim();

  const freq = new Map();
  const fps = [];
  for (const line of lines) {
    const k = fp(line);
    fps.push(k);
    if (!k) continue;
    freq.set(k, (freq.get(k) || 0) + 1);
  }

  const seenBoiler = new Set();
  const outBoiler = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const k = fps[i];
    if (!k) {
      outBoiler.push(line);
      continue;
    }
    const f = freq.get(k) || 0;
    if (f >= boilerplateMinFreq && line.length <= boilerplateMaxLineLen) {
      const q = _lineQuality(line);
      const uiLike = q.tokenCount <= 10 && (q.alphaRatio < 0.78 || q.digitRatio > 0.22);
      if (uiLike) {
        if (seenBoiler.has(k)) {
          removed.boilerplate++;
          continue;
        }
        seenBoiler.add(k);
      }
    }
    outBoiler.push(line);
  }

  // 3) exact dedupe (global) + hard limits
  const finalOut = [];
  const seen = new Set();
  let charBudget = Math.max(0, Number(maxLinesChars) || 0);
  for (const line of outBoiler) {
    const key = _lineExactKey(line);
    if (dedupeExact && key && seen.has(key)) {
      removed.exact_dup++;
      continue;
    }
    if (key) seen.add(key);

    if (maxLines > 0 && finalOut.length >= maxLines) break;

    if (charBudget > 0) {
      const next = line.length + 1;
      if (finalOut.length > 0 && next > charBudget) break;
      charBudget -= next;
    }

    finalOut.push(line);
  }

  counts.out_lines = finalOut.length;

  return {
    raw_text: raw,
    clean_lines: finalOut,
    clean_text: finalOut.join('\n').trim(),
    clean_meta: {
      mode: 'lines',
      counts,
      removed,
      params: {
        maxChars,
        maxLines,
        maxLinesChars,
        wrapAt,
        boilerplateMinFreq,
        boilerplateMaxLineLen,
        dedupeExact,
        dropMostlyJunkLines,
      },
    },
  };
}

function buildRawExtractedText(result) {
  if (!result || typeof result !== 'object') return '';
  const parts = [];
  const t = String(result.title || '').trim();
  const d = String(result.description || '').trim();
  const x = String(result.text || '').trim();

  if (t) parts.push(t);
  if (d && d !== t) parts.push(d);
  if (x && x !== d && x !== t) parts.push(x);

  return parts.join('\n\n').trim();
}

function attachCleanExtracted(result) {
  // Do not add clean_* to blocked placeholders (they are not real page content).
  if (!result || typeof result !== 'object') return result;
  if (result.blocked) return result;

  const raw = buildRawExtractedText(result);
  if (!raw) return result;

  const cleaned = cleanExtractedToLines(raw);
  return {
    ...result,
    raw_text: cleaned.raw_text,
    clean_text: cleaned.clean_text,
    clean_lines: cleaned.clean_lines,
    clean_meta: cleaned.clean_meta,
  };
}


function toLogLine(level, correlationId, message, meta) {
  const payload =
    meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${new Date().toISOString()} [${correlationId}] ${level.toUpperCase()} ${message}${payload}`;
}

function createLogger(correlationId) {
  return {
    log(level, message, meta = {}) {
      const line = toLogLine(level, correlationId, message, meta);
      if (level === "error") {
        console.error(line);
      } else if (level === "warn") {
        console.warn(line);
      } else {
        console.log(line);
      }
      fs.appendFile(LOG_FILE, `${line}\n`, () => {});
    },
  };
}

async function fetchImpl(url, options = {}) {
  if (globalThis.fetch) {
    return globalThis.fetch(url, options);
  }
  const { default: nodeFetch } = await import("node-fetch");
  return nodeFetch(url, options);
}

function detectBlock({ status, html }) {
  if (status && [401, 403, 429, 503].includes(status)) {
    return `status_${status}`;
  }
  const snippet = html.slice(0, 2000).toLowerCase();
  if (!snippet) return null;
  for (const keyword of BLOCK_KEYWORDS) {
    if (snippet.includes(keyword)) {
      return keyword;
    }
  }
  return null;
}

function createDocument(html, url) {
  return new JSDOM(html, { url }).window.document;
}

function fallbackExtraction(doc, url) {
  const title = normalizeWhitespace(
    doc.querySelector("title")?.textContent || "",
  );
  const description = normalizeWhitespace(
    doc.querySelector('meta[name="description"]')?.getAttribute("content") ||
      "",
  );
  const paragraphs = Array.from(doc.querySelectorAll("p"))
    .slice(0, 6)
    .map((p) => normalizeWhitespace(p.textContent))
    .filter(Boolean);
  // Preserve some line structure (diff/LLM-friendly) instead of one mega-line.
  const text = paragraphs.join("\n");
  return {
    url,
    title: title || null,
    description: description || null,
    text: text || null,
    htmlMain: clampTextLength(doc.querySelector("main")?.innerHTML || ""),
    price: null,
    images: [],
    attributes: {},
    confidence: text ? 0.35 : 0.2,
    extractor: "fallback",
    contentType: "unknown",
  };
}

async function runExtractors(doc, html, context, logger) {
  const t0 = performance.now();

  // We prefer *structured* text (multi-line blocks, headings, lists) over
  // meta-only extractors (JSON-LD / og:...) even if meta returns a high detect score.
  const META_EXTRACTOR_NAMES = new Set(["jsonld", "meta-og"]);

  function structuredTextScore(result) {
    const text = String(result?.text || "").trim();
    if (!text) return 0;

    const lines = text
      .split("\n")
      .map((l) => String(l).trim())
      .filter(Boolean);

    const lineCount = lines.length;
    const avgLen = text.length / Math.max(1, lineCount);
    const headings = lines.filter((l) => /^#{1,6}\s+/.test(l)).length;
    const listItems = lines.filter((l) => /^(\s*-\s+|\s*\d+\.\s+)/.test(l)).length;
    const keyValues = lines.filter((l) => /^[^:]{2,60}:\s+\S/.test(l)).length;

    let s = 0;
    s += Math.min(1, lineCount / 120) * 0.35;
    s += Math.min(1, headings / 6) * 0.25;
    s += Math.min(1, listItems / 30) * 0.2;
    s += Math.min(1, keyValues / 30) * 0.15;
    s += avgLen <= 160 ? 0.05 : 0;

    if (result?.attributes?.structured) s += 0.1;
    if (lineCount <= 2 && text.length > 800) s -= 0.3;

    const urls = (text.match(/https?:\/\//g) || []).length;
    const braces = (text.match(/[{}\[\]]/g) || []).length;
    s -= Math.min(0.4, urls * 0.05 + braces / 200);

    const conf = Math.max(0, Math.min(1, Number(result?.confidence ?? 0)));
    s = s * (0.6 + 0.4 * conf);

    return Math.max(0, Math.min(1, s));
  }

  function isAcceptableWithStructure(result, sScore) {
    if (!result) return false;
    const hasKey = KEY_FIELDS.some((field) => {
      const value = result[field];
      return typeof value === "string" && value.trim().length > 0;
    });
    if (!hasKey) return false;
    // If structure is strong, allow slightly lower confidence.
    if (sScore >= 0.55) return true;
    return (result.confidence ?? 0) >= 0.5;
  }

  function mergeMeta(textRes, metaRes) {
    if (!metaRes) return textRes;
    const mergedImages = Array.from(
      new Set([...(textRes.images || []), ...(metaRes.images || [])].filter(Boolean)),
    );
    const mergedAttrs = {
      ...(metaRes.attributes || {}),
      ...(textRes.attributes || {}),
      meta_extractor: metaRes.extractor || null,
    };
    return {
      ...textRes,
      title: textRes.title || metaRes.title || null,
      description: textRes.description || metaRes.description || null,
      price: textRes.price || metaRes.price || null,
      images: mergedImages,
      attributes: mergedAttrs,
      contentType: textRes.contentType && textRes.contentType !== "unknown"
        ? textRes.contentType
        : (metaRes.contentType || textRes.contentType),
    };
  }

  const scored = EXTRACTORS.map((extractor, index) => ({
    extractor,
    score: Math.max(0, Math.min(1, extractor.detect(doc, html, context) || 0)),
    order: index,
  })).sort((a, b) => {
    if (b.score === a.score) return a.order - b.order;
    return b.score - a.score;
  });

  const candidates = [];
  for (const { extractor, score } of scored) {
    if (score <= 0) continue;
    logger.log("info", "extractor_attempt", { extractor: extractor.name, score });
    const tOne0 = performance.now();
    try {
      const result = extractor.extract(doc, { ...context, html });
      logger.log("info", "extractor_attempt_done", {
        extractor: extractor.name,
        durationMs: Math.round(performance.now() - tOne0),
      });
      if (!result) continue;
      if (!result.extractor) result.extractor = extractor.name;
      result.confidence = Math.min(1, result.confidence ?? score);

      const sScore = structuredTextScore(result);
      const acceptable = isAcceptableWithStructure(result, sScore);
      candidates.push({ extractor: extractor.name, score, result, sScore, acceptable });
    } catch (err) {
      logger.log("warn", "extractor_failed", { extractor: extractor.name, message: err.message });
    }
  }

  const ok = candidates.filter((c) => c.acceptable && c.result);
  if (!ok.length) {
    logger.log("info", "extractor_fallback", { durationMs: Math.round(performance.now() - t0) });
    return fallbackExtraction(doc, context.url);
  }

  const meta = ok
    .filter((c) => META_EXTRACTOR_NAMES.has(String(c.result.extractor || c.extractor)))
    .sort((a, b) => (b.result.confidence ?? 0) - (a.result.confidence ?? 0))[0]?.result || null;

  const textCandidates = ok
    .filter((c) => !META_EXTRACTOR_NAMES.has(String(c.result.extractor || c.extractor)))
    .sort((a, b) => {
      if (b.sScore === a.sScore) return (b.result.confidence ?? 0) - (a.result.confidence ?? 0);
      return b.sScore - a.sScore;
    });

  const best = (textCandidates[0] || ok.sort((a, b) => (b.result.confidence ?? 0) - (a.result.confidence ?? 0))[0]).result;
  const merged = mergeMeta(best, meta);

  logger.log("info", "extractors_done", {
    chosen: best.extractor,
    structuredScore: structuredTextScore(best),
    confidence: best.confidence,
    meta: meta?.extractor || null,
    durationMs: Math.round(performance.now() - t0),
  });

  return merged;
}

function buildBlockedResult({ url, reason, finalUrl, screenshotPath }) {
  return {
    url: finalUrl || url,
    fetchedAt: new Date().toISOString(),
    contentType: "unknown",
    title: null,
    description: null,
    text: null,
    htmlMain: null,
    price: null,
    images: [],
    attributes: screenshotPath ? { blockedScreenshot: screenshotPath } : {},
    confidence: 0,
    extractor: "blocked",
    blocked: true,
    human_review: true,
    block_reason: reason,
  };
}

async function fetchStaticDocument(url, logger, correlationId) {
  const t0 = performance.now();
  logger.log("info", "fetch_static_start", { url });
  const response = await retryWithBackoff(
    async () => {
      const res = await fetchImpl(url, {
        redirect: "follow",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      });
      if (!res.ok && ![401, 403, 404, 429, 503].includes(res.status)) {
        throw new Error(`http_${res.status}`);
      }
      return res;
    },
    {
      retries: 2,
      onRetry: (err, attempt) =>
        logger.log("warn", "fetch_retry", { attempt, message: err.message }),
    },
  );

  const finalUrl = response.url || url;
  const status = response.status;

  const tBody0 = performance.now();
  const buffer = await response.arrayBuffer();
  const html = Buffer.from(buffer).toString("utf8");
  const bodyMs = Math.round(performance.now() - tBody0);

  logger.log("info", "fetch_static_done", {
    status,
    bytes: html.length,
    bodyMs,
    durationMs: Math.round(performance.now() - t0),
  });

  const reason = detectBlock({ status, html });
  if (reason) {
    logger.log("warn", "fetch_block_detected", { reason, status });
    return {
      blocked: true,
      result: buildBlockedResult({ url, finalUrl, reason }),
    };
  }
  const doc = createDocument(html, finalUrl);
  return { blocked: false, doc, html, finalUrl, status };
}

async function renderDocument(url, logger, correlationId) {
  const t0 = performance.now();
  logger.log("info", "render_start", { url });
  const tLaunch0 = performance.now();
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  logger.log("info", "render_browser_launched", {
    durationMs: Math.round(performance.now() - tLaunch0),
  });

  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    await page.setExtraHTTPHeaders({
      "accept-language": "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",
    });
    const tGoto0 = performance.now();
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    logger.log("info", "render_goto_done", {
      durationMs: Math.round(performance.now() - tGoto0),
    });

    await page.waitForTimeout(1500);
    const html = await page.content();
    const finalUrl = page.url();
    const status = response?.status?.() ?? 200;
    const reason = detectBlock({ status, html });
    if (reason) {
      const screenshotPath = path.join(
        BLOCKED_DIR,
        `${correlationId}-${Date.now()}.jpeg`,
      );
      try {
        await page.screenshot({
          path: screenshotPath,
          type: "jpeg",
          quality: 60,
          fullPage: false,
        });
        logger.log("warn", "render_block_screenshot", { screenshotPath });
      } catch (err) {
        logger.log("warn", "render_block_screenshot_failed", {
          message: err.message,
        });
      }
      return {
        blocked: true,
        result: buildBlockedResult({ url, finalUrl, reason, screenshotPath }),
      };
    }
    const doc = createDocument(html, finalUrl);
    logger.log("info", "render_done", {
      finalUrl,
      status,
      bytes: html.length,
      durationMs: Math.round(performance.now() - t0),
    });

    return { blocked: false, doc, html, finalUrl, status };
  } finally {
    await browser.close();
  }
}

function enrichResult(base, result) {
  return {
    ...base,
    ...result,
    url: result.url || base.url,
    fetchedAt: base.fetchedAt,
    blocked: result.blocked ?? false,
    human_review: result.human_review ?? false,
    block_reason: result.block_reason ?? null,
  };
}

export async function fetchAndExtract(url, options = {}) {
  const t0 = performance.now();
  const correlationId = options.correlationId || randomUUID();
  const logger = createLogger(correlationId);
  const allowRender = options.render;
  const providedHtml = options.html || null; // <--- NOWE

  const base = {
    url,
    fetchedAt: new Date().toISOString(),
    contentType: "unknown",
    title: null,
    description: null,
    text: null,
    htmlMain: null,
    price: null,
    images: [],
    attributes: {},
    confidence: 0,
    extractor: "fallback",
    blocked: false,
    human_review: false,
    block_reason: null,
  };

  try {
    let doc;
    let html;
    let finalUrl = url;
    let status = 200;

    if (providedHtml) {
      // 1) UŻYWAMY HTML OD AGENTA – ŻADNEGO FETCHA
      logger.log("info", "use_provided_html", { url });
      html = providedHtml;
      doc = createDocument(html, finalUrl);
    } else {
      // 2) STARE ZACHOWANIE – FETCH STATYCZNY + EW. RENDER
      const staticResult = await fetchStaticDocument(
        url,
        logger,
        correlationId,
      );
      if (staticResult.blocked) {
        logger.log("info", "fetch_extract_done", {
          url,
          finalUrl: staticResult.result.url,
          extractor: "blocked",
          confidence: 0,
          blocked: true,
          durationMs: Math.round(performance.now() - t0),
        });
        return enrichResult(base, staticResult.result);
      }

      ({ doc, html, finalUrl, status } = staticResult);
    }

    const extracted = await runExtractors(doc, html, { url: finalUrl }, logger);
    let combined = enrichResult(base, { ...extracted, url: finalUrl });

    // fallback z renderem TYLKO gdy NIE mieliśmy providedHtml
    if (!providedHtml && combined.confidence < 0.4 && allowRender !== false) {
      logger.log("info", "render_fallback_triggered", {
        confidence: combined.confidence,
      });
      const renderResult = await renderDocument(
        finalUrl,
        logger,
        correlationId,
      );
      if (renderResult.blocked) {
        logger.log("info", "fetch_extract_done", {
          url,
          finalUrl: renderResult.result.url,
          extractor: "blocked",
          confidence: 0,
          blocked: true,
          durationMs: Math.round(performance.now() - t0),
        });
        return enrichResult(base, renderResult.result);
      }

      const extractedRendered = await runExtractors(
        renderResult.doc,
        renderResult.html,
        { url: renderResult.finalUrl },
        logger,
      );
      combined = enrichResult(base, {
        ...extractedRendered,
        url: renderResult.finalUrl,
      });
    }

    logger.log("info", "fetch_extract_done", {
      url,
      finalUrl: combined.url,
      extractor: combined.extractor,
      confidence: combined.confidence,
      blocked: !!combined.blocked,
      durationMs: Math.round(performance.now() - t0),
    });

    return attachCleanExtracted(combined);
  } catch (err) {
    logger.log("error", "fetch_extract_failed", {
      message: err.message,
      durationMs: Math.round(performance.now() - t0),
    });

    return enrichResult(base, {
      extractor: "fallback",
      confidence: 0,
      human_review: true,
      block_reason: err.message,
    });
  }
}
