// skrypt/llm/diffEngine.js
// Refactor: lean machine diff + optional universal_data diff (from snapshot analyses).

import { mongoClient } from '../polaczenieMDB.js';
import { performance } from 'node:perf_hooks';
import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';
import { extractChunksByTemplate, computeChunkDiff } from './llmChunker.js';
import { extractEvidenceFromChunksLLM } from './llmEvidence.js';


const db = mongoClient.db(process.env.MONGO_DB || 'inzynierka');
const snapshotsCol = db.collection('snapshots');
const analizyCol = db.collection('analizy');

function collectEvidenceQuotesFromAnalysis(analysis) {
  const ev = analysis?.evidence_v1;
  if (!ev) return [];
  // Preferred: { items: [{quote, ...}, ...] }
  if (Array.isArray(ev.items)) {
    return ev.items
      .map((it) => (it && typeof it === 'object' ? (it.quote || it.text) : it))
      .filter((q) => typeof q === 'string' && q.trim().length)
      .map((q) => q.trim());
  }
  // Legacy / alternate formats
  if (Array.isArray(ev.quotes)) {
    return ev.quotes
      .filter((q) => typeof q === 'string' && q.trim().length)
      .map((q) => q.trim());
  }
  if (Array.isArray(ev.before) || Array.isArray(ev.after)) {
    // If someone stored diff-format in analysis, flatten it.
    const arr = [];
    if (Array.isArray(ev.before)) arr.push(...ev.before);
    if (Array.isArray(ev.after)) arr.push(...ev.after);
    return arr
      .filter((q) => typeof q === 'string' && q.trim().length)
      .map((q) => q.trim());
  }
  return [];
}

export async function getPreviousSnapshot(currentSnapshot, { logger } = {}) {
  if (!currentSnapshot) return null;
  const log = logger || console;
  const t0 = performance.now();

  const prev = await snapshotsCol
    .find({ monitor_id: currentSnapshot.monitor_id, ts: { $lt: currentSnapshot.ts } })
    .sort({ ts: -1 })
    .limit(1)
    .next();

  const durationMs = Math.round(performance.now() - t0);
  if (durationMs >= 20) {
    log?.info?.('diff_prev_snapshot_done', {
      monitorId: String(currentSnapshot.monitor_id || ''),
      snapshotId: currentSnapshot?._id?.toString?.() || null,
      durationMs,
      found: !!prev,
    });
  }

  return prev || null;
}

export async function getSnapshotAnalysis(snapshotId, { logger } = {}) {
  const log = logger || console;
  const t0 = performance.now();

  const doc = await analizyCol.findOne({ snapshot_id: snapshotId, type: 'snapshot' });

  const durationMs = Math.round(performance.now() - t0);
  if (durationMs >= 20) {
    log?.info?.('diff_get_analysis_done', {
      snapshotId: snapshotId?.toString?.() || String(snapshotId),
      durationMs,
      found: !!doc,
    });
  }

  return doc || null;
}

export async function getAnalysisById(analysisId, { logger } = {}) {
  if (!analysisId) return null;

  const log = logger || console;
  const t0 = performance.now();

  let _id;
  try {
    _id = typeof analysisId === 'string' ? new ObjectId(String(analysisId)) : analysisId;
  } catch {
    return null;
  }

  try {
    const dbName = process.env.MONGO_DB || 'inzynierka';
    const db = mongoClient.db(dbName);
    const analizyCol = db.collection('analizy');

    const doc = await analizyCol.findOne({ _id });

    log?.info?.('mongo_getAnalysisById_done', {
      analysisId: String(analysisId),
      found: !!doc,
      durationMs: Math.round(performance.now() - t0),
    });

    return doc || null;
  } catch (err) {
    log?.warn?.('mongo_getAnalysisById_failed', {
      analysisId: String(analysisId),
      error: String(err?.message || err),
    });
    return null;
  }
}


function sha1(value) {
  const s = (value ?? '').toString();
  if (!s) return null;
  return crypto.createHash('sha1').update(s).digest('hex');
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeB64(b64) {
  if (!b64) return null;
  let s = String(b64).trim();
  const idx = s.indexOf('base64,');
  if (idx !== -1) s = s.slice(idx + 7);
  if (s.startsWith('data:')) {
    const comma = s.indexOf(',');
    if (comma !== -1) s = s.slice(comma + 1);
  }
  s = s.trim();
  return s.length ? s : null;
}

// Bardzo prosty score różnicy tekstu (0 = identyczny, 1 = zupełnie inny)
function simpleTextDiffScore(a, b) {
  if (!a && !b) return 0;
  if (!a || !b) return 1;
  if (a === b) return 0;

  const aWords = new Set(a.split(/\s+/).filter(Boolean));
  const bWords = new Set(b.split(/\s+/).filter(Boolean));

  if (aWords.size === 0 && bWords.size === 0) return 0;

  let intersection = 0;
  for (const w of aWords) {
    if (bWords.has(w)) intersection += 1;
  }

  const union = new Set([...aWords, ...bWords]).size;
  if (union === 0) return 0;

  return 1 - intersection / union;
}

/**
 * Chunk-based diff (lokalne zmiany w długim tekście).
 * - dzielimy tekst na chunki ~TARGET_CHARS z OVERLAP_CHARS
 * - porównujemy każdy nowy chunk do prev chunków w oknie +/- WINDOW
 * - similarity = Jaccard na tokenach (unigramy)
 */
const TEXT_CHUNK = {
  TARGET_CHARS: Number(process.env.TEXT_CHUNK_TARGET_CHARS || 900),
  OVERLAP_CHARS: Number(process.env.TEXT_CHUNK_OVERLAP_CHARS || 120),
  MAX_CHUNKS: Number(process.env.TEXT_CHUNK_MAX_CHUNKS || 60),
  WINDOW: Number(process.env.TEXT_CHUNK_WINDOW || 2),
  NGRAM: Number(process.env.TEXT_CHUNK_NGRAM || 1),

  CHANGE_THRESHOLD: Number(process.env.TEXT_CHUNK_CHANGE_THRESHOLD || 0.12),
  CHANGE_THRESHOLD_NUM: Number(process.env.TEXT_CHUNK_CHANGE_THRESHOLD_NUM || 0.08),

  SIGNIFICANT_THRESHOLD: Number(process.env.TEXT_CHUNK_SIGNIFICANT_THRESHOLD || 0.18),
  SIGNIFICANT_THRESHOLD_NUM: Number(process.env.TEXT_CHUNK_SIGNIFICANT_THRESHOLD_NUM || 0.14),
  SIGNIFICANT_RATIO: Number(process.env.TEXT_CHUNK_SIGNIFICANT_RATIO || 0.08),
  SIGNIFICANT_CHANGED_CHUNKS: Number(process.env.TEXT_CHUNK_SIGNIFICANT_CHANGED_CHUNKS || 2),
};

function tokenizeWords(text) {
  const s = String(text || '').toLowerCase();
  // unicode letters + digits (działa też dla PL)
  return s.match(/[\p{L}\p{N}]+/gu) || [];
}

function toShingleSet(text, n = 1) {
  const tokens = tokenizeWords(text);
  const set = new Set();
  if (tokens.length === 0) return set;

  if (n <= 1) {
    for (const t of tokens) set.add(t);
    return set;
  }

  if (tokens.length < n) {
    set.add(tokens.join(' '));
    return set;
  }

  for (let i = 0; i <= tokens.length - n; i++) {
    set.add(tokens.slice(i, i + n).join(' '));
  }
  return set;
}

function jaccardSimilarity(aSet, bSet) {
  if (aSet.size === 0 && bSet.size === 0) return 1;
  if (aSet.size === 0 || bSet.size === 0) return 0;

  let inter = 0;
  // iteruj po mniejszym secie
  const small = aSet.size <= bSet.size ? aSet : bSet;
  const big = aSet.size <= bSet.size ? bSet : aSet;

  for (const x of small) if (big.has(x)) inter += 1;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 1 : inter / union;
}

function chunkText(rawText) {
  const t = String(rawText || '').trim();
  if (!t) return [];

  // 1) spróbuj naturalnych separatorów (newline / '|')
  let parts = t
    .split(/\n{2,}|\s*\|\s*/g)
    .map((x) => x.trim())
    .filter(Boolean);

  const chunks = [];
  const target = TEXT_CHUNK.TARGET_CHARS;
  const overlap = TEXT_CHUNK.OVERLAP_CHARS;

  // jeśli nie ma separatorów (często extracted_v2.text jest jednym ciągiem),
  // tnij twardo na chunki target/overlap
  if (parts.length <= 1) {
    const step = Math.max(1, target - overlap);
    for (let i = 0; i < t.length && chunks.length < TEXT_CHUNK.MAX_CHUNKS; i += step) {
      const slice = t.slice(i, i + target).trim();
      if (slice) chunks.push(slice);
    }
    return chunks;
  }

  let buf = '';
  for (const p of parts) {

    if (!buf) {
      buf = p;
      continue;
    }

    if ((buf.length + 1 + p.length) <= target) {
      buf += ' ' + p;
    } else {
      chunks.push(buf.trim());

      // overlap: weź końcówkę poprzedniego bufora
      const tail = overlap > 0 ? buf.slice(Math.max(0, buf.length - overlap)) : '';
      buf = (tail ? tail + ' ' : '') + p;
    }

    if (chunks.length >= TEXT_CHUNK.MAX_CHUNKS) break;
  }

  if (buf && chunks.length < TEXT_CHUNK.MAX_CHUNKS) chunks.push(buf.trim());

  // jeśli i tak wyszło za mało/za dużo, przytnij
  return chunks.slice(0, TEXT_CHUNK.MAX_CHUNKS);
}

function computeTextChunkDiff(prevText, nowText) {
  const prevChunks = chunkText(prevText);
  const nowChunks = chunkText(nowText);

  const prevSets = prevChunks.map((c) => toShingleSet(c, TEXT_CHUNK.NGRAM));
  const nowSets = nowChunks.map((c) => toShingleSet(c, TEXT_CHUNK.NGRAM));

  let changedChunks = 0;
  let changedChunksWithDigits = 0;
  let maxChunkDiffScore = 0;
  let sumBestSim = 0;

  const examples = [];

  for (let i = 0; i < nowChunks.length; i++) {
    let bestSim = 0;

    if (prevChunks.length === 0) {
      bestSim = 0;
    } else {
      const from = Math.max(0, i - TEXT_CHUNK.WINDOW);
      const to = Math.min(prevChunks.length - 1, i + TEXT_CHUNK.WINDOW);

      for (let j = from; j <= to; j++) {
        const sim = jaccardSimilarity(nowSets[i], prevSets[j]);
        if (sim > bestSim) bestSim = sim;
      }
    }

    sumBestSim += bestSim;

    const diff = 1 - bestSim;
    if (diff > maxChunkDiffScore) maxChunkDiffScore = diff;

    const hasDigits = /\d/.test(nowChunks[i]);
    const changeThr = hasDigits ? TEXT_CHUNK.CHANGE_THRESHOLD_NUM : TEXT_CHUNK.CHANGE_THRESHOLD;

    if (diff >= changeThr) {
      changedChunks += 1;
      if (hasDigits) changedChunksWithDigits += 1;

      if (examples.length < 3) {
        examples.push({
          index: i,
          diffScore: Number(diff.toFixed(3)),
          preview: nowChunks[i].slice(0, 160),
        });
      }
    }
  }

  const changedRatio = nowChunks.length ? changedChunks / nowChunks.length : 0;
  const avgBestSimilarity = nowChunks.length ? sumBestSim / nowChunks.length : 1;

  // significance: max diff / ratio / liczba zmienionych chunków
  const sigMaxThr = changedChunksWithDigits > 0
    ? TEXT_CHUNK.SIGNIFICANT_THRESHOLD_NUM
    : TEXT_CHUNK.SIGNIFICANT_THRESHOLD;

  const significant =
    maxChunkDiffScore >= sigMaxThr ||
    changedRatio >= TEXT_CHUNK.SIGNIFICANT_RATIO ||
    changedChunks >= TEXT_CHUNK.SIGNIFICANT_CHANGED_CHUNKS;

  return {
    prevChunks: prevChunks.length,
    nowChunks: nowChunks.length,
    changedChunks,
    changedChunksWithDigits,
    changedRatio: Number(changedRatio.toFixed(3)),
    maxChunkDiffScore: Number(maxChunkDiffScore.toFixed(3)),
    avgBestSimilarity: Number(avgBestSimilarity.toFixed(3)),
    significant,
    examples,
    config: {
      targetChars: TEXT_CHUNK.TARGET_CHARS,
      overlapChars: TEXT_CHUNK.OVERLAP_CHARS,
      maxChunks: TEXT_CHUNK.MAX_CHUNKS,
      window: TEXT_CHUNK.WINDOW,
      ngram: TEXT_CHUNK.NGRAM,
      changeThreshold: TEXT_CHUNK.CHANGE_THRESHOLD,
      changeThresholdNum: TEXT_CHUNK.CHANGE_THRESHOLD_NUM,
      significantThreshold: TEXT_CHUNK.SIGNIFICANT_THRESHOLD,
      significantThresholdNum: TEXT_CHUNK.SIGNIFICANT_THRESHOLD_NUM,
      significantRatio: TEXT_CHUNK.SIGNIFICANT_RATIO,
      significantChangedChunks: TEXT_CHUNK.SIGNIFICANT_CHANGED_CHUNKS,
    },
  };
}



function buildTextEvidence(prevText, nowText, { maxItems = 5 } = {}) {
  const prev = normalizeText(prevText);
  const now = normalizeText(nowText);
  if (!prev && !now) return { added: [], removed: [] };

  const toLines = (t) =>
    String(t || '')
      .split(/\n+|[.!?]+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 6 && x.length <= 220);

  const prevLines = toLines(prev);
  const nowLines = toLines(now);

  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const prevMap = new Map(prevLines.map((l) => [norm(l), l]));
  const nowMap = new Map(nowLines.map((l) => [norm(l), l]));

  const added = [];
  for (const [k, v] of nowMap.entries()) {
    if (!prevMap.has(k)) {
      added.push(v);
      if (added.length >= maxItems) break;
    }
  }

  const removed = [];
  for (const [k, v] of prevMap.entries()) {
    if (!nowMap.has(k)) {
      removed.push(v);
      if (removed.length >= maxItems) break;
    }
  }

  return { added, removed };
}

function toNumberMaybe(v) {
  if (v == null) return null;
  const m = String(v).replace(/\u00A0/g, ' ').match(/-?\d[\d ]*(?:[.,]\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/ /g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parsePriceLike(extractedPrice) {
  if (!extractedPrice) return null;
  if (typeof extractedPrice === 'string') return toNumberMaybe(extractedPrice);
  if (typeof extractedPrice === 'object') return toNumberMaybe(extractedPrice.value ?? extractedPrice.amount ?? null);
  return null;
}

function stableJsonHash(value) {
  try {
    return sha1(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

function normalizeUniversalMap(analysis) {
  const list = Array.isArray(analysis?.universal_data) ? analysis.universal_data : [];
  const map = new Map();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key || '').trim();
    if (!key) continue;
    const value = String(item.value ?? '').trim() || 'unknown';
    map.set(key, value);
  }
  return map;
}

function diffUniversalData(prevAnalysis, newAnalysis) {
  const prev = normalizeUniversalMap(prevAnalysis);
  const next = normalizeUniversalMap(newAnalysis);

  const added = [];
  const removed = [];
  const changed = [];

  for (const [k, v] of next.entries()) {
    if (!prev.has(k)) added.push({ key: k, after: v });
    else {
      const before = prev.get(k);
      if (before !== v) changed.push({ key: k, before, after: v });
    }
  }

  for (const [k, v] of prev.entries()) {
    if (!next.has(k)) removed.push({ key: k, before: v });
  }

  return {
    added,
    removed,
    changed,
    any: added.length > 0 || removed.length > 0 || changed.length > 0,
  };
}

export async function computeMachineDiff(prevSnapshot, newSnapshot, { logger, prevAnalysis, newAnalysis } = {}) {
  const log = logger || console;

  if (!prevSnapshot) {
    return {
      hasAnyChange: false,
      hasSignificantMachineChange: false,
      reasons: ['no_prev_snapshot'],
      metrics: { baseline: true },
      textEvidence: { added: [], removed: [] },
      prevSnapshotId: null,
      newSnapshotId: newSnapshot?._id ?? null,
    };
  }

  const t0 = performance.now();

  const prevEx = prevSnapshot?.extracted_v2 || {};
  const newEx = newSnapshot?.extracted_v2 || {};

  const metrics = {};
  const reasons = [];

  // ---- Screenshot ----
  const prevShotHash = sha1(normalizeB64(prevSnapshot?.screenshot_b64));
  const newShotHash = sha1(normalizeB64(newSnapshot?.screenshot_b64));
  metrics.screenshotChanged = Boolean((prevShotHash || newShotHash) && prevShotHash !== newShotHash);
  if (metrics.screenshotChanged) reasons.push('screenshot_changed');

  // ---- Extracted core fields ----
  metrics.titleChanged = normalizeText(prevEx.title) !== normalizeText(newEx.title);
  metrics.descriptionChanged = normalizeText(prevEx.description) !== normalizeText(newEx.description);
  if (metrics.titleChanged) reasons.push('title_changed');
  if (metrics.descriptionChanged) reasons.push('description_changed');

const prevTextRaw = String(prevEx.text || '');
const newTextRaw = String(newEx.text || '');
const prevText = normalizeText(prevTextRaw);
const newText = normalizeText(newTextRaw);


  // Globalny diff (jak było)
  metrics.textDiffScore = simpleTextDiffScore(prevText, newText);
  if (metrics.textDiffScore > 0.05) {
    reasons.push(`text_changed(score=${metrics.textDiffScore.toFixed(3)})`);
  }





// ---- OCR text (only if already present on snapshots) ----
const prevOcrRaw = String(prevSnapshot?.vision_ocr?.clean_text || prevSnapshot?.vision_ocr?.text || '');
const newOcrRaw = String(newSnapshot?.vision_ocr?.clean_text || newSnapshot?.vision_ocr?.text || '');
const prevOcr = normalizeText(prevOcrRaw);
const newOcr = normalizeText(newOcrRaw);

const prevOcrHash = sha1(prevOcr);
const newOcrHash = sha1(newOcr);
metrics.ocrTextDiffScore = simpleTextDiffScore(prevOcr, newOcr);
metrics.ocrTextChanged = Boolean((prevOcrHash || newOcrHash) && prevOcrHash !== newOcrHash);
if (metrics.ocrTextChanged && metrics.ocrTextDiffScore > 0.05) {
  reasons.push(`ocr_text_changed(score=${metrics.ocrTextDiffScore.toFixed(3)})`);
}

// ---- Chunk diff (LLM template if available; fallback to algorithmic) ----
const chunkTemplate = prevAnalysis?.chunk_template || newAnalysis?.chunk_template || null;
const llmChunkingEnabled = process.env.LLM_CHUNKING_ENABLED === '1';

if (llmChunkingEnabled && chunkTemplate?.chunks?.length) {
  const source = chunkTemplate?.source === 'ocr' ? 'ocr' : 'extracted';

  const prevSrcText = source === 'ocr' ? prevOcrRaw : prevTextRaw;
  const newSrcText = source === 'ocr' ? newOcrRaw : newTextRaw;

  const prevChunked = extractChunksByTemplate(prevSrcText, chunkTemplate);
  const newChunked = extractChunksByTemplate(newSrcText, chunkTemplate);

  metrics.textChunkDiff = computeChunkDiff(prevChunked.chunks, newChunked.chunks);
  metrics.textChunkDiff.mode = 'llm_template';
  metrics.textChunkDiff.templateSource = source;
  metrics.textChunkDiff.templateMissing = {
    prevMissing: prevChunked.missing,
    newMissing: newChunked.missing,
  };
  metrics.textChunkDiff.templateFit = {
    prevFitRatio: prevChunked?.stats?.fitRatio ?? null,
    newFitRatio: newChunked?.stats?.fitRatio ?? null,
    prevFound: prevChunked?.stats?.found ?? null,
    newFound: newChunked?.stats?.found ?? null,
    total: prevChunked?.stats?.total ?? null,
  };

  // Keep a compact subset for the LLM judge (stable size).
  const maxChanged = Number(process.env.LLM_CHUNK_MAX_CHANGED_FOR_JUDGE || 8);
  if (Array.isArray(metrics.textChunkDiff.changed)) {
    metrics.textChunkDiff.changed_for_judge = metrics.textChunkDiff.changed.slice(0, maxChanged);
  }
} else {
  // fallback: chunkuj to samo źródło co evidence (OCR jeśli jest, inaczej extracted)
  const basePrev = (prevOcrRaw || prevOcr) ? prevOcrRaw : prevTextRaw;
  const baseNew = (newOcrRaw || newOcr) ? newOcrRaw : newTextRaw;

  metrics.textChunkDiff = computeTextChunkDiff(basePrev, baseNew);
  metrics.textChunkDiff.mode = 'algo_fixed';
}

if (metrics.textChunkDiff?.changedChunks > 0) {
  reasons.push(
    `text_chunk_changed(changed=${metrics.textChunkDiff.changedChunks}/${metrics.textChunkDiff.nowChunks},mode=${metrics.textChunkDiff.mode})`
  );
}



  // ---- Plugin prices ----
  const prevPluginPrices = Array.isArray(prevSnapshot?.plugin_prices) ? prevSnapshot.plugin_prices : [];
  const newPluginPrices = Array.isArray(newSnapshot?.plugin_prices) ? newSnapshot.plugin_prices : [];
  const prevPluginHash = stableJsonHash(prevPluginPrices);
  const newPluginHash = stableJsonHash(newPluginPrices);
  metrics.pluginPricesChanged = Boolean((prevPluginHash || newPluginHash) && prevPluginHash !== newPluginHash);
  if (metrics.pluginPricesChanged) reasons.push('plugin_prices_changed');

  // ---- Main price (cheap) ----
  const prevPrice = parsePriceLike(prevEx.price);
  const newPrice = parsePriceLike(newEx.price);
  if (typeof prevPrice === 'number' && typeof newPrice === 'number' && prevPrice !== newPrice) {
    const absChange = newPrice - prevPrice;
    const relChange = prevPrice !== 0 ? absChange / prevPrice : null;
    metrics.price = { oldVal: prevPrice, newVal: newPrice, absChange, relChange };
    reasons.push(`price_changed(${prevPrice}->${newPrice})`);
  }

  // ---- universal_data diff (if analyses are available) ----
  if (prevAnalysis || newAnalysis) {
    const uDiff = diffUniversalData(prevAnalysis, newAnalysis);
    metrics.universalDataDiff = uDiff;
    metrics.universalDataChanged = uDiff.any;
    if (uDiff.any) reasons.push('universal_data_changed');
  }

  // Text evidence: prefer OCR if present, else extracted text
  const evidenceSource = prevOcr || newOcr ? 'ocr' : 'extracted';
  const textEvidence =
    evidenceSource === 'ocr'
      ? buildTextEvidence(prevOcr, newOcr)
      : buildTextEvidence(prevText, newText);
  metrics.textEvidenceSource = evidenceSource;

  // Prompt-driven evidence (verbatim quotes extracted during analysis)
  const evidence_v1 = {
    before: collectEvidenceQuotesFromAnalysis(prevAnalysis),
    after: collectEvidenceQuotesFromAnalysis(newAnalysis),
  };

  // If baseline/new analysis has no stored evidence, rebuild it from snapshot chunks (prompt-driven).
  // This avoids false decisions when older snapshots were saved without evidence_v1.
  const allowEvidenceRebuild = process.env.EVIDENCE_REBUILD_IF_MISSING !== '0';
  const userPrompt = String(newAnalysis?.intent?.userPrompt || prevAnalysis?.intent?.userPrompt || '').trim();
  const promptHash = String(newAnalysis?.intent?.userPromptHash || prevAnalysis?.intent?.userPromptHash || 'adhoc');

  if (allowEvidenceRebuild && userPrompt) {
    const prevChunks = prevSnapshot?.text_chunks_v1?.chunks;
    const newChunks = newSnapshot?.text_chunks_v1?.chunks;
    const sourcePrev = prevSnapshot?.text_chunks_v1?.source || 'ocr_clean';
    const sourceNew = newSnapshot?.text_chunks_v1?.source || 'ocr_clean';

    if ((!Array.isArray(evidence_v1.before) || evidence_v1.before.length === 0) && Array.isArray(prevChunks) && prevChunks.length) {
      try {
        const ev = await extractEvidenceFromChunksLLM({
          userPrompt,
          promptHash,
          chunks: prevChunks,
          source: sourcePrev,
          model: newAnalysis?.model,
          createdAt: new Date().toISOString(),
        });
        evidence_v1.before = (ev?.items || []).map((it) => it.quote).filter(Boolean).slice(0, 8);
      } catch (_) {
        // keep empty
      }
    }

    if ((!Array.isArray(evidence_v1.after) || evidence_v1.after.length === 0) && Array.isArray(newChunks) && newChunks.length) {
      try {
        const ev = await extractEvidenceFromChunksLLM({
          userPrompt,
          promptHash,
          chunks: newChunks,
          source: sourceNew,
          model: newAnalysis?.model,
          createdAt: new Date().toISOString(),
        });
        evidence_v1.after = (ev?.items || []).map((it) => it.quote).filter(Boolean).slice(0, 8);
      } catch (_) {
        // keep empty
      }
    }
  }

  const hasAnyChange = reasons.length > 0;

  // Significance heuristic (cheap + conservative)
  let hasSignificantMachineChange = false;
  if (metrics.screenshotChanged || metrics.pluginPricesChanged) hasSignificantMachineChange = true;
  if (metrics.price && metrics.price.absChange !== 0) hasSignificantMachineChange = true;
  if (metrics.textDiffScore > 0.15) hasSignificantMachineChange = true;
  if (metrics.ocrTextDiffScore > 0.15) hasSignificantMachineChange = true;

  // Chunk diff = istotne przy małych zmianach w dużym tekście
  if (metrics.textChunkDiff?.significant) hasSignificantMachineChange = true;

  if (metrics.universalDataChanged) hasSignificantMachineChange = true;


  const durationMs = Math.round(performance.now() - t0);
  if (durationMs >= 10) {
    log?.info?.('diff_compute_done', {
      prevSnapshotId: prevSnapshot?._id?.toString?.() || null,
      newSnapshotId: newSnapshot?._id?.toString?.() || null,
      durationMs,
      hasAnyChange,
      hasSignificantMachineChange,
    });
  }

  return {
    hasAnyChange,
    hasSignificantMachineChange,
    reasons,
    metrics,
    textEvidence,
    evidence_v1,
    prevSnapshotId: prevSnapshot._id,
    newSnapshotId: newSnapshot._id,
  };
}

