// skrypt/llm/analizaSnapshotu.js
// Snapshot analysis (text-only) + optional semantic chunk template.
//
// IMPORTANT:
// - LLM receives ONLY text extracted from the page (extracted_v2.text and/or OCR clean_text).
// - Semantic chunking is handled via an "anchor template" which we try to REUSE from baseline analysis.

import { mongoClient } from '../polaczenieMDB.js';
import { Double, ObjectId } from 'mongodb';
import { performance } from 'node:perf_hooks';

import { generateTextWithOllama } from './ollamaClient.js';
import {
  sanitizeNullableString,
  sanitizeRequiredString,
  clampText,
  hashUserPrompt,
} from './analysisUtils.js';
import {
  buildChunkTemplateLLM,
  scoreTemplateFit,
} from './llmChunker.js';
import { ensureSnapshotChunks } from './chunksSnapshotu.js';
import { extractEvidenceFromChunksLLM } from './llmEvidence.js';

const db = mongoClient.db(process.env.MONGO_DB || 'inzynierka');
const analysesCol = db.collection('analizy');
const snapshotsCol = db.collection('snapshots');

const OLLAMA_MODEL =
  process.env.OLLAMA_TEXT_MODEL ||
  process.env.LLM_MODEL ||
  'qwen2.5:3b-instruct';

function normalizeUserPrompt(value) {
  const s = String(value || '').trim();
  return s.length ? s : null;
}

function normalizeNumberOrNull(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = String(value).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!s) return null;
  const n = Number(s[0]);
  return Number.isFinite(n) ? n : null;
}

async function safeInsertAnalysis(doc, { logger, snapshotId } = {}) {
  const log = logger || console;
  try {
    const { insertedId } = await analysesCol.insertOne(doc);
    return { insertedId };
  } catch (err) {
    log?.error?.('mongo_insert_analysis_failed', {
      snapshotId: snapshotId?.toString?.() || null,
      error: err?.message || String(err),
    });
    return { insertedId: null };
  }
}

async function getExistingAnalysisForSnapshot(snapshotId) {
  if (!snapshotId) return null;
  return analysesCol.findOne({ snapshot_id: new ObjectId(snapshotId) });
}

function chooseTextSources(snapshot) {
  const extractedText =
    sanitizeNullableString(snapshot?.extracted_v2?.clean_text) ||
    sanitizeNullableString(snapshot?.extracted_v2?.text) ||
    '';
  const ocrText =
    sanitizeNullableString(snapshot?.vision_ocr?.clean_text) ||
    sanitizeNullableString(snapshot?.vision_ocr?.text) ||
    '';

  // Prefer extracted (DOM text) when it is not empty; OCR is fallback.
  const primary = extractedText.trim() ? { source: 'extracted', text: extractedText } : null;
  const secondary = ocrText.trim() ? { source: 'ocr', text: ocrText } : null;
  return { primary, secondary };
}

function buildUniversalPrompt({ userPrompt, extractedText, ocrText }) {
  const up = userPrompt ? `USER_PROMPT:\n${userPrompt}\n\n` : 'USER_PROMPT:\n(brak)\n\n';

  // Hard clamp to prevent token blow-ups.
  const ex = extractedText ? clampText(extractedText, 9000) : '';
  const ocr = ocrText ? clampText(ocrText, 9000) : '';

  // NOTE: LLM gets only text from the page (extracted/OCR). No images.
  return (
    up +
    'CONTEXT:\n\n' +
    (ex ? `EXTRACTED_TEXT:\n${ex}\n\n` : '') +
    (ocr ? `OCR_TEXT:\n${ocr}\n\n` : '') +
    'Zwróć JSON o strukturze:\n\n' +
    '{ "summary": string, "metrics": { "rating": number|null, "reviews_count": number|null } }'
  );
}

function buildUniversalSystem() {
  return [
    'Jesteś narzędziem do ekstrakcji uniwersalnych danych ze strony na podstawie TEKSTU.',
    'Nie zgadujesz. Jeśli czegoś nie ma lub jest niejednoznaczne -> użyj null/"unknown".',
    'Zwróć WYŁĄCZNIE poprawny JSON.',
  ].join('\n');
}

function isValidChunkTemplate(tpl) {
  if (!tpl || typeof tpl !== 'object') return false;
  if (tpl.error) return false;
  if (!Array.isArray(tpl.chunks) || tpl.chunks.length < 1) return false;
  // minimalna walidacja struktury (żeby nie reuse'ować śmieci)
  return tpl.chunks.every((c) =>
    c &&
    typeof c === 'object' &&
    typeof c.key === 'string' &&
    c.key.trim().length > 0 &&
    Array.isArray(c.anchor_candidates) &&
    c.anchor_candidates.length > 0,
  );
}

async function buildOrReuseChunkTemplate({
  snapshot,
  // userPrompt intentionally ignored for chunk template.
  // Chunking must be page-structure-driven and reusable across runs.
  userPrompt,
  reuseTemplate,
  logger,
}) {
  const log = logger || console;
  const enabled = process.env.LLM_CHUNKING_ENABLED === '1';
  if (!enabled) return null;

  const { primary, secondary } = chooseTextSources(snapshot);

  // For chunking we want the text that stays relatively stable across snapshots.
  // Prefer extracted text, fallback to OCR.
  const candidate = primary && primary.text.trim().length >= 400 ? primary : secondary;
  if (!candidate) return null;

  // 1) Reuse (if provided and fits)
  if (isValidChunkTemplate(reuseTemplate)) {
    const fit = scoreTemplateFit(candidate.text, reuseTemplate);
    const minFit = Number(process.env.LLM_CHUNK_MIN_FIT_RATIO || 0.6);
    if (fit >= minFit) {
      return {
        ...reuseTemplate,
        source: reuseTemplate.source || candidate.source,
        reused: true,
        fitRatio: fit,
      };
    }

    log?.warn?.('llm_chunk_template_reuse_rejected', {
      snapshotId: snapshot?._id?.toString?.() || null,
      source: candidate.source,
      fitRatio: fit,
      minFit,
    });
  }

  // 2) Build new template via LLM
  const chunkModel = process.env.OLLAMA_CHUNK_MODEL || OLLAMA_MODEL;
  const res = await buildChunkTemplateLLM(
    {
      text: candidate.text,
      source: candidate.source,
      url: snapshot?.url || null,
      // NIE przekazujemy userPrompt do template chunków.
      // UserPrompt ma wpływać na ocenę zmian, nie na segmentację.
      model: chunkModel,
    },
    { logger: log },
  );

  if (!res?.ok || !res?.template) {
    return {
      source: candidate.source,
      model: chunkModel,
      createdAt: new Date().toISOString(),
      durationMs: res?.durationMs || null,
      chunks: [],
      error: res?.error || 'LLM_CHUNK_TEMPLATE_FAILED',
      reused: false,
      fitRatio: 0,
    };
  }

  // Store the normalized template with some metadata
  const fitRatio = scoreTemplateFit(candidate.text, res.template);
  return {
    version: res.template.version,
    source: candidate.source,
    model: chunkModel,
    createdAt: res.createdAt,
    durationMs: res.durationMs,
    text_sha1: res.text_sha1,
    chunks: res.template.chunks,
    error: null,
    reused: false,
    fitRatio,
    repaired: res.repaired || 0,
    fallbackUsed: !!res.fallbackUsed,
  };
}

export async function ensureSnapshotAnalysis(snapshotRef, options = {}) {
  const { force = false, logger, userPrompt, reuseChunkTemplate } = options;
  const log = logger || console;
  const t0 = performance.now();

  // Load snapshot if needed
  let snapshot = snapshotRef;
  if (!snapshot || typeof snapshot !== 'object' || !snapshot._id) {
    snapshot = await snapshotsCol.findOne({ _id: new ObjectId(snapshotRef) });
  }
  if (!snapshot) return null;

  // Cache hit
  if (!force) {
    const existing = await getExistingAnalysisForSnapshot(snapshot._id);
    if (existing) return existing;
  }

  const normalizedUserPrompt = normalizeUserPrompt(userPrompt || snapshot?.llm_prompt);

  const { primary, secondary } = chooseTextSources(snapshot);
  const extractedText = primary?.source === 'extracted' ? primary.text : '';
  const ocrText = secondary?.source === 'ocr' ? secondary.text : '';

  const prompt = buildUniversalPrompt({
    userPrompt: normalizedUserPrompt,
    extractedText,
    ocrText,
  });

  log?.info?.('snapshot_analysis_llm_start', {
    snapshotId: snapshot._id.toString(),
    monitorId: String(snapshot.monitor_id || ''),
    zadanieId: String(snapshot.zadanie_id || snapshot.zadanieId || ''),
    model: OLLAMA_MODEL,
    hasUserPrompt: !!normalizedUserPrompt,
  });

  let raw = null;
  let parsed = null;
  let err = null;

  try {
    raw = await generateTextWithOllama({
      prompt,
      system: buildUniversalSystem(),
      model: OLLAMA_MODEL,
      format: 'json',
      temperature: 0,
      timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS_ANALYSIS || process.env.OLLAMA_TIMEOUT_MS || 180000),
    });
    parsed = typeof raw === 'object' ? raw : JSON.parse(String(raw));
  } catch (e) {
    err = e;
  }

  // Chunk template (reuse or build) happens even if universal extraction fails,
  // because it is useful for diffs and judge.
  let chunkTemplate = null;
  try {
    chunkTemplate = await buildOrReuseChunkTemplate({
      snapshot,
      userPrompt: normalizedUserPrompt,
      reuseTemplate: reuseChunkTemplate,
      logger: log,
    });
  } catch (e) {
    chunkTemplate = {
      source: 'unknown',
      model: process.env.OLLAMA_CHUNK_MODEL || OLLAMA_MODEL,
      createdAt: new Date().toISOString(),
      durationMs: null,
      chunks: [],
      error: e?.message || String(e),
      reused: false,
      fitRatio: 0,
    };
  }

  // If universal extraction failed -> save an error doc (still with chunk_template).
  if (!parsed) {
    const docErr = {
      zadanieId: String(snapshot.zadanie_id || snapshot.zadanieId || ''),
      monitorId: String(snapshot.monitor_id || ''),
      createdAt: new Date(),
      type: 'snapshot',
      snapshot_id: snapshot._id,
      url: snapshot?.url || null,
      model: OLLAMA_MODEL,
      score: new Double(1.0),
      schema_version: 'universal_v1',
      intent: {
        userPrompt: normalizedUserPrompt,
        userPromptHash: hashUserPrompt(normalizedUserPrompt),
      },
      summary: '',
      metrics: { rating: null, reviews_count: null },
      universal_data: [],
      chunk_template: chunkTemplate || null,
      prompt,
      raw_response: raw != null ? String(raw) : null,
      error: err?.message || String(err),
    };

    const { insertedId } = await safeInsertAnalysis(docErr, { logger: log, snapshotId: snapshot._id });
    if (insertedId) {
      docErr._id = insertedId;
      docErr._inserted = true;
    } else {
      docErr._inserted = false;
    }
    return docErr;
  }

  const summary = sanitizeRequiredString(parsed?.summary);
  const rating = normalizeNumberOrNull(parsed?.metrics?.rating);
  const reviewsCount = normalizeNumberOrNull(parsed?.metrics?.reviews_count);
  const universalData = [];

  const userPromptHash = normalizedUserPrompt ? hashUserPrompt(normalizedUserPrompt) : null;

  // Evidence extraction for judge: for the given user prompt, extract SHORT verbatim quotes
  // from chunk texts. This runs regardless of whether a change is "important" – it is just
  // building a compact, prompt-specific view of the snapshot.
  let evidenceV1 = null;
  let promptChunksV1 = null;
  if (normalizedUserPrompt) {
    try {
      const chunkDoc = await ensureSnapshotChunks(snapshot, {
        logger: log,
        chunkTemplate: chunkTemplate || null,
      });

      const chunks = Array.isArray(chunkDoc?.chunks) ? chunkDoc.chunks : [];
      if (chunks.length) {
        const ev = await extractEvidenceFromChunksLLM({
          model: OLLAMA_MODEL,
          userPrompt: normalizedUserPrompt,
          chunks,
          maxQuotesPerChunk: 30,
          maxQuoteChars: 300,
          timeoutMs: Number(process.env.LLM_EVIDENCE_TIMEOUT_MS || 40000),
          trace: {
            snapshotId: String(snapshot?._id || ''),
            monitorId: String(snapshot?.monitor_id || ''),
          },
        });

        evidenceV1 = {
          version: 'evidence_v1',
          promptHash: userPromptHash,
          source: chunkDoc?.source || null,
          model: OLLAMA_MODEL,
          createdAt: new Date(),
          // [{ quote, chunk_id }]
          items: ev.items,
          // { [chunkId]: boolean }
          chunk_relevance: ev.byChunk,
        };

        promptChunksV1 = {
          version: 'prompt_chunks_v1',
          promptHash: userPromptHash,
          source: chunkDoc?.source || null,
          focus_chunk_ids: ev.focusChunkIds,
        };
      }
    } catch (err) {
      log?.warn?.('snapshot_evidence_failed', {
        snapshotId: String(snapshot?._id || ''),
        err: err?.message || String(err),
      });
    }
  }

  const doc = {
    zadanieId: String(snapshot.zadanie_id || snapshot.zadanieId || ''),
    monitorId: String(snapshot.monitor_id || ''),
    createdAt: new Date(),
    type: 'snapshot',
    snapshot_id: snapshot._id,
    url: snapshot?.url || null,
    model: OLLAMA_MODEL,
    score: new Double(1.0),
    schema_version: 'universal_v1',
    intent: {
      userPrompt: normalizedUserPrompt,
      userPromptHash,
    },
    summary,
    metrics: { rating, reviews_count: reviewsCount },
    universal_data: [],
    evidence_v1: evidenceV1,
    prompt_chunks_v1: promptChunksV1,
    chunk_template: chunkTemplate || null,
    prompt,
    raw_response: raw != null ? String(raw) : null,
    error: null,
  };

  const { insertedId } = await safeInsertAnalysis(doc, { logger: log, snapshotId: snapshot._id });
  if (insertedId) {
    doc._id = insertedId;
    doc._inserted = true;
  } else {
    doc._inserted = false;
  }

  log?.info?.('snapshot_analysis_success', {
    snapshotId: snapshot._id.toString(),
    monitorId: String(snapshot.monitor_id || ''),
    zadanieId: String(snapshot.zadanie_id || snapshot.zadanieId || ''),
    durationMs: Math.round(performance.now() - t0),
    universalDataItems: Array.isArray(doc.universal_data) ? doc.universal_data.length : 0,
    chunkTemplate: {
      enabled: process.env.LLM_CHUNKING_ENABLED === '1',
      reused: !!doc.chunk_template?.reused,
      chunks: Array.isArray(doc.chunk_template?.chunks) ? doc.chunk_template.chunks.length : 0,
      fitRatio: doc.chunk_template?.fitRatio ?? null,
      error: doc.chunk_template?.error || null,
    },
  });

  return doc;
}
