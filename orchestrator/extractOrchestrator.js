import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import puppeteer from 'puppeteer';

import { jsonldExtractor } from '../extractors/jsonldExtractor.js';
import { metaOgExtractor } from '../extractors/metaOgExtractor.js';
import { readabilityExtractor } from '../extractors/readabilityExtractor.js';
import { visibleTextExtractor } from '../extractors/visibleTextExtractor.js';
import { clampTextLength, normalizeWhitespace } from '../utils/normalize.js';
import { retryWithBackoff } from '../utils/retryBackoff.js';

const EXTRACTORS = [
  jsonldExtractor,
  metaOgExtractor,
  readabilityExtractor,
  visibleTextExtractor,
];

const KEY_FIELDS = ['title', 'description', 'text'];
const BLOCK_KEYWORDS = [
  'captcha',
  'cloudflare',
  'access denied',
  'verify you are human',
  'are you a robot',
  'robot check',
  'temporarily blocked',
  'service unavailable',
  'forbidden',
];

const LOGS_DIR = path.resolve(process.cwd(), 'logs');
const BLOCKED_DIR = path.join(LOGS_DIR, 'blocked');
const LOG_FILE = path.join(LOGS_DIR, 'extractor.log');

fs.mkdirSync(BLOCKED_DIR, { recursive: true });

function toLogLine(level, correlationId, message, meta) {
  const payload = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${new Date().toISOString()} [${correlationId}] ${level.toUpperCase()} ${message}${payload}`;
}

function createLogger(correlationId) {
  return {
    log(level, message, meta = {}) {
      const line = toLogLine(level, correlationId, message, meta);
      if (level === 'error') {
        console.error(line);
      } else if (level === 'warn') {
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
  const { default: nodeFetch } = await import('node-fetch');
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

function isResultAcceptable(result) {
  if (!result) return false;
  if (result.confidence < 0.5) return false;
  const hasKey = KEY_FIELDS.some((field) => {
    const value = result[field];
    return typeof value === 'string' && value.trim().length > 0;
  });
  return hasKey;
}

function fallbackExtraction(doc, url) {
  const title = normalizeWhitespace(doc.querySelector('title')?.textContent || '');
  const description = normalizeWhitespace(doc.querySelector('meta[name="description"]')?.getAttribute('content') || '');
  const paragraphs = Array.from(doc.querySelectorAll('p')).slice(0, 4);
  const text = normalizeWhitespace(paragraphs.map((p) => p.textContent).join(' '));
  return {
    url,
    title: title || null,
    description: description || null,
    text: text || null,
    htmlMain: clampTextLength(doc.querySelector('main')?.innerHTML || ''),
    price: null,
    images: [],
    attributes: {},
    confidence: text ? 0.35 : 0.2,
    extractor: 'fallback',
    contentType: 'unknown',
  };
}

async function runExtractors(doc, html, context, logger) {
  const scored = EXTRACTORS
    .map((extractor, index) => ({
      extractor,
      score: Math.max(0, Math.min(1, extractor.detect(doc, html, context) || 0)),
      order: index,
    }))
    .sort((a, b) => {
      if (b.score === a.score) return a.order - b.order;
      return b.score - a.score;
    });
  for (const { extractor, score } of scored) {
    if (score <= 0) continue;
    logger.log('info', 'extractor_attempt', { extractor: extractor.name, score });
    try {
      const result = extractor.extract(doc, { ...context, html });
      if (!result) continue;
      if (!result.extractor) {
        result.extractor = extractor.name;
      }
      result.confidence = Math.min(1, result.confidence ?? score);
      if (isResultAcceptable(result)) {
        return result;
      }
      logger.log('warn', 'extractor_low_confidence', {
        extractor: extractor.name,
        confidence: result.confidence,
      });
    } catch (err) {
      logger.log('warn', 'extractor_failed', { extractor: extractor.name, message: err.message });
    }
  }
  logger.log('info', 'extractor_fallback', {});
  return fallbackExtraction(doc, context.url);
}

function buildBlockedResult({ url, reason, finalUrl, screenshotPath }) {
  return {
    url: finalUrl || url,
    fetchedAt: new Date().toISOString(),
    contentType: 'unknown',
    title: null,
    description: null,
    text: null,
    htmlMain: null,
    price: null,
    images: [],
    attributes: screenshotPath ? { blockedScreenshot: screenshotPath } : {},
    confidence: 0,
    extractor: 'blocked',
    blocked: true,
    human_review: true,
    block_reason: reason,
  };
}

async function fetchStaticDocument(url, logger, correlationId) {
  logger.log('info', 'fetch_static_start', { url });
  const response = await retryWithBackoff(
    async () => {
      const res = await fetchImpl(url, {
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });
      if (!res.ok && ![401, 403, 404, 429, 503].includes(res.status)) {
        throw new Error(`http_${res.status}`);
      }
      return res;
    },
    {
      retries: 2,
      onRetry: (err, attempt) => logger.log('warn', 'fetch_retry', { attempt, message: err.message }),
    },
  );

  const finalUrl = response.url || url;
  const status = response.status;
  const buffer = await response.arrayBuffer();
  const html = Buffer.from(buffer).toString('utf8');
  logger.log('info', 'fetch_static_done', { status, bytes: html.length });
  const reason = detectBlock({ status, html });
  if (reason) {
    logger.log('warn', 'fetch_block_detected', { reason, status });
    return { blocked: true, result: buildBlockedResult({ url, finalUrl, reason }) };
  }
  const doc = createDocument(html, finalUrl);
  return { blocked: false, doc, html, finalUrl, status };
}

async function renderDocument(url, logger, correlationId) {
  logger.log('info', 'render_start', { url });
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'accept-language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
    });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    const html = await page.content();
    const finalUrl = page.url();
    const status = response?.status?.() ?? 200;
    const reason = detectBlock({ status, html });
    if (reason) {
      const screenshotPath = path.join(BLOCKED_DIR, `${correlationId}-${Date.now()}.jpeg`);
      try {
        await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 60, fullPage: false });
        logger.log('warn', 'render_block_screenshot', { screenshotPath });
      } catch (err) {
        logger.log('warn', 'render_block_screenshot_failed', { message: err.message });
      }
      return { blocked: true, result: buildBlockedResult({ url, finalUrl, reason, screenshotPath }) };
    }
    const doc = createDocument(html, finalUrl);
    logger.log('info', 'render_done', { finalUrl });
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
  const correlationId = options.correlationId || randomUUID();
  const logger = createLogger(correlationId);
  const allowRender = options.render;
  const base = {
    url,
    fetchedAt: new Date().toISOString(),
    contentType: 'unknown',
    title: null,
    description: null,
    text: null,
    htmlMain: null,
    price: null,
    images: [],
    attributes: {},
    confidence: 0,
    extractor: 'fallback',
    blocked: false,
    human_review: false,
    block_reason: null,
  };

  try {
    const staticResult = await fetchStaticDocument(url, logger, correlationId);
    if (staticResult.blocked) {
      return enrichResult(base, staticResult.result);
    }
    const { doc, html, finalUrl } = staticResult;
    const extracted = await runExtractors(doc, html, { url: finalUrl }, logger);
    let combined = enrichResult(base, { ...extracted, url: finalUrl });
    if (combined.confidence < 0.4 && allowRender !== false) {
      logger.log('info', 'render_fallback_triggered', { confidence: combined.confidence });
      const renderResult = await renderDocument(finalUrl, logger, correlationId);
      if (renderResult.blocked) {
        return enrichResult(base, renderResult.result);
      }
      const extractedRendered = await runExtractors(renderResult.doc, renderResult.html, { url: renderResult.finalUrl }, logger);
      combined = enrichResult(base, { ...extractedRendered, url: renderResult.finalUrl });
    }
    return combined;
  } catch (err) {
    logger.log('error', 'fetch_extract_failed', { message: err.message });
    return enrichResult(base, {
      extractor: 'fallback',
      confidence: 0,
      human_review: true,
      block_reason: err.message,
    });
  }
}
