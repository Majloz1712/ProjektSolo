// skrypt/llm/pipelineZmian.js
// Refactor: Lazy Evaluation
// Lazy Evaluation:
// 1) If OCR-only and OCR text missing -> run OCR first (so diffLite is meaningful)
// 2) computeMachineDiff (lite)
// 3) only then full OCR/analysis/judge if needed


import { mongoClient } from '../polaczenieMDB.js';
import { pool } from '../polaczeniePG.js';
import { ObjectId } from 'mongodb';
import { performance } from 'node:perf_hooks';

import { ensureSnapshotAnalysis } from './analizaSnapshotu.js';
import { ensureSnapshotOcr } from './ocrSnapshotu.js';
import { normalizeUserPrompt, hashUserPrompt } from './analysisUtils.js';

import {
  getPreviousSnapshot,
  computeMachineDiff,
  getSnapshotAnalysis,
  getAnalysisById,
} from "./diffEngine.js";

import { evaluateChangeWithLLM, saveDetectionAndNotification } from './ocenaZmianyLLM.js';

const db = mongoClient.db(process.env.MONGO_DB || 'inzynierka');
const snapshotsCol = db.collection('snapshots');

function isGoodAnalysisForBaseline(doc) {
  if (!doc || doc.error) return false;
  const chunkingEnabled = process.env.LLM_CHUNKING_ENABLED === '1';
  if (!chunkingEnabled) return true;

  const ct = doc.chunk_template;
  if (!ct || ct.error) return false;
  if (!Array.isArray(ct.chunks) || ct.chunks.length < 1) return false;

  const minFit = Number(process.env.LLM_CHUNK_MIN_FIT_RATIO_BASELINE || 0.55);
  if (typeof ct.fitRatio === 'number' && Number.isFinite(ct.fitRatio) && ct.fitRatio < minFit) {
    return false;
  }
  return true;
}

async function setTaskAnalysisMongoId(zadanieId, analizaId, opts = {}) {
  const { force = false, log = console } = opts;
  if (!zadanieId || !analizaId) return;

  try {
    await pool.query(
      `UPDATE zadania_skanu
         SET analiza_mongo_id = $2
       WHERE id = $1
         AND (
           $3::boolean = true
           OR analiza_mongo_id IS NULL
           OR analiza_mongo_id = ''
         )`,
      [zadanieId, String(analizaId), !!force],
    );

    log?.info?.('pg_analiza_mongo_id_updated', {
      zadanieId,
      analiza_mongo_id: String(analizaId),
    });
  } catch (err) {
    log?.warn?.('pg_analiza_mongo_id_update_failed', {
      zadanieId,
      analiza_mongo_id: String(analizaId),
      error: err?.message || String(err),
    });
  }
}

async function getMonitorLastGoodAnalysisId(monitorId, opts = {}) {
  const { log = console } = opts;
  if (!monitorId) return null;

  try {
    const { rows } = await pool.query(
      'SELECT id_ostatniej_dobrej_analizy FROM monitory WHERE id = $1 LIMIT 1',
      [monitorId],
    );
    const id = rows?.[0]?.id_ostatniej_dobrej_analizy;
    return id ? String(id) : null;
  } catch (err) {
    log?.warn?.('pg_last_good_analysis_read_failed', {
      monitorId: String(monitorId),
      error: String(err?.message || err),
    });
    return null;
  }
}

async function setMonitorLastGoodAnalysisId(monitorId, analizaId, expectedCurrentId, opts = {}) {
  const { log = console } = opts;
  if (!monitorId || !analizaId) return;

  try {
    await pool.query(
      'UPDATE monitory SET id_ostatniej_dobrej_analizy = $2 WHERE id = $1 AND id_ostatniej_dobrej_analizy IS NOT DISTINCT FROM $3',
      [monitorId, String(analizaId), expectedCurrentId ? String(expectedCurrentId) : null],
    );


    log?.info?.('pg_last_good_analysis_updated', {
      monitorId: String(monitorId),
      analizaId: String(analizaId),
    });
  } catch (err) {
    log?.warn?.('pg_last_good_analysis_update_failed', {
      monitorId: String(monitorId),
      analizaId: String(analizaId),
      error: String(err?.message || err),
    });
  }
}



function shouldEarlyExit(diff, { forceAnalysis, hasUserPrompt, focusEnabled } = {}) {
  if (!diff) return true;
  if (!diff.hasAnyChange) return true;
  if (forceAnalysis) return false;

  // Gdy mamy focus (prompt niezmieniony + important_chunk_ids), ufamy diff.hasSignificantMachineChange
  // (uwzględnia focusChanged + discovery).
  if (focusEnabled) {
    if (diff.hasSignificantMachineChange === false) return true;
    return false;
  }

  // Bez focus: jeśli nie ma promptu i zmiana nieistotna -> exit.
  if (!hasUserPrompt && diff.hasSignificantMachineChange === false) return true;

  return false;
}



function shouldRunOcr(snapshot) {
  // OCR ma być tylko źródłem danych, gdy nie mamy żadnego sensownego tekstu z DOM.
  const hasScreenshot = Boolean(snapshot?.screenshot_b64);
  if (!hasScreenshot) return false;

  const ocrText = String(snapshot?.vision_ocr?.clean_text || snapshot?.vision_ocr?.text || '').trim();
  if (ocrText.length > 0 && snapshot?.vision_ocr?.ok !== false) return false;

  const extractedText = String(snapshot?.extracted_v2?.text || '').trim();
  return extractedText.length === 0;
}


export async function handleNewSnapshot(snapshotRef, options = {}) {
  const { forceAnalysis = false, logger, userPrompt } = options;
  const log = logger || console;

  // ---- Load snapshot ----
  let snapshot;
  if (snapshotRef && typeof snapshotRef === 'object' && snapshotRef._id) {
    snapshot = snapshotRef;
  } else {
    const id = typeof snapshotRef === 'string' ? new ObjectId(snapshotRef) : snapshotRef;
    // upewnij się, że mongo jest połączone (bezpieczne dla różnych wersji drivera)
try {
  const connected =
    mongoClient?.topology?.isConnected?.() ||
    mongoClient?.topology?.s?.state === 'connected';
  if (!connected) await mongoClient.connect();
} catch {
  await mongoClient.connect();
}

snapshot = await snapshotsCol.findOne({ _id: id });

  }

  if (!snapshot) {
    log?.warn?.('pipeline_snapshot_not_found', { snapshotRef });
    return;
  }

  const snapshotIdStr = snapshot._id.toString();
const tPipeline0 = performance.now();
const normalizedUserPrompt = normalizeUserPrompt(userPrompt || snapshot?.llm_prompt);
const promptHash = hashUserPrompt(normalizedUserPrompt);


const monitorId = snapshot.monitor_id;

// --- BASELINE: poprzednia *dobra* analiza (trzymamy tylko ID w Postgres)
const lastGoodAnalysisId = await getMonitorLastGoodAnalysisId(monitorId, { log });
let baselineAnalysis = null;
if (lastGoodAnalysisId) {
  baselineAnalysis = await getAnalysisById(lastGoodAnalysisId, { logger: log });
  if (baselineAnalysis?.error) baselineAnalysis = null; // baseline ma być tylko "dobra"
}

log.info('pipeline_baseline_loaded', {
  monitorId: String(monitorId),
  lastGoodAnalysisId: lastGoodAnalysisId || null,
  baselineFound: !!baselineAnalysis,
});


  log?.info?.('pipeline_start', {
    snapshotId: snapshotIdStr,
    monitorId: snapshot.monitor_id,
    forceAnalysis,
  });

  // ---- 1) Previous snapshot + machine diff (cheap) ----
  const tPrev0 = performance.now();
const prevSnapshot = await getPreviousSnapshot(snapshot, { logger: log });
log?.info?.('pipeline_step_done', {
  step: 'getPreviousSnapshot',
  snapshotId: snapshotIdStr,
  monitorId: snapshot.monitor_id,
  durationMs: Math.round(performance.now() - tPrev0),
  hasPrev: !!prevSnapshot,
});

// Baseline (pierwszy snapshot) => stop OD RAZU (żeby nie odpalać OCR na null)
if (!prevSnapshot) {
  log?.info?.('pipeline_done', {
    snapshotId: snapshotIdStr,
    monitorId: snapshot.monitor_id,
    result: 'no_prev_snapshot',
    durationMs: Math.round(performance.now() - tPipeline0),
  });
  return;
}


const baselineChunkTemplate = baselineAnalysis?.chunk_template || null;


let focusChunkIds = null;

if (promptHash && baselineAnalysis) {
  const baselinePromptHash =
    baselineAnalysis?.prompt_hash || baselineAnalysis?.intent?.userPromptHash || null;

  if (
    baselinePromptHash === promptHash &&
    Array.isArray(baselineAnalysis?.important_chunk_ids) &&
    baselineAnalysis.important_chunk_ids.length
  ) {
    focusChunkIds = baselineAnalysis.important_chunk_ids;
  }
}

log?.info?.('pipeline_focus_chunks', {
  monitorId: String(monitorId),
  hasUserPrompt: !!normalizedUserPrompt,
  promptHash: promptHash || null,
  focusEnabled: !!focusChunkIds,
  focusChunkIdsCount: Array.isArray(focusChunkIds) ? focusChunkIds.length : 0,
});





// ---- 1.5) Ensure OCR text BEFORE diffLite for OCR-only monitors ----
const prevExtractedText = String(prevSnapshot?.extracted_v2?.text || '').trim();
const newExtractedText = String(snapshot?.extracted_v2?.text || '').trim();

const prevOcrText = String(
  prevSnapshot?.vision_ocr?.clean_text || prevSnapshot?.vision_ocr?.text || ''
).trim();
const newOcrText = String(
  snapshot?.vision_ocr?.clean_text || snapshot?.vision_ocr?.text || ''
).trim();

// Jeśli któraś strona NIE MA ŻADNEGO tekstu (ani extracted ani OCR) -> dobuduj OCR przed diffLite
const needPrevOcrForDiff = !prevExtractedText && !prevOcrText;
const needNewOcrForDiff  = !newExtractedText && !newOcrText;

if (needPrevOcrForDiff || needNewOcrForDiff) {
  const tOcr0 = performance.now();

  if (needPrevOcrForDiff) await ensureSnapshotOcr(prevSnapshot, { logger: log });
  if (needNewOcrForDiff)  await ensureSnapshotOcr(snapshot, { logger: log });

  log?.info?.('pipeline_step_done', {
    step: 'ensureSnapshotOcr_for_diffLite',
    snapshotId: snapshotIdStr,
    monitorId: snapshot.monitor_id,
    durationMs: Math.round(performance.now() - tOcr0),
    needPrevOcrForDiff,
    needNewOcrForDiff,
  });
}



const tDiff0 = performance.now();
const diffLite = await computeMachineDiff(prevSnapshot, snapshot, {
  logger: log,
  prevAnalysis: null,
  newAnalysis: null,
  focusChunkIds: focusChunkIds || null,
  chunkTemplate: baselineAnalysis?.chunk_template || null,
});

log?.info?.('pipeline_step_done', {
  step: 'computeMachineDiff_lite',
  snapshotId: snapshotIdStr,
  monitorId: snapshot.monitor_id,
  durationMs: Math.round(performance.now() - tDiff0),
  hasAnyChange: !!diffLite?.hasAnyChange,
  hasSignificantMachineChange: !!diffLite?.hasSignificantMachineChange,
});


if (shouldEarlyExit(diffLite, { forceAnalysis, hasUserPrompt: !!normalizedUserPrompt, focusEnabled: !!focusChunkIds })) {


    log?.info?.('pipeline_done', {
      snapshotId: snapshotIdStr,
      monitorId: snapshot.monitor_id,
      result: diffLite?.hasAnyChange ? 'negligible_change' : 'no_change',
      durationMs: Math.round(performance.now() - tPipeline0),
    });
    return;
  }

await ensureSnapshotOcr(prevSnapshot, { logger: log });
await ensureSnapshotOcr(snapshot, { logger: log });


const needOcr = shouldRunOcr(snapshot);


// jeśli OCR potrzebny dla new, to prawie zawsze potrzebny też dla prev (żeby diff OCR miał sens)
if (needOcr) {
  const tOcr0 = performance.now();

  prevOcr = await ensureSnapshotOcr(prevSnapshot, { logger: log });
  newOcr = await ensureSnapshotOcr(snapshot, { logger: log });

  log?.info?.('pipeline_step_done', {
    step: 'ensureSnapshotOcr_prev_and_new',
    snapshotId: snapshotIdStr,
    monitorId: snapshot.monitor_id,
    durationMs: Math.round(performance.now() - tOcr0),
    prevOcrPresent: !!prevOcr,
    newOcrPresent: !!newOcr,
  });
}

  // ---- 3) Analyses (LLM) – only now ----
  const tAnalysis0 = performance.now();
  const newAnalysis = await ensureSnapshotAnalysis(snapshot, {
    force: forceAnalysis,
    logger: log,
    userPrompt: normalizedUserPrompt,
    // Reuse semantic chunk template from the baseline (last good analysis) to avoid re-chunking each run.
    reuseChunkTemplate: baselineChunkTemplate || null,

    // Reuse prompt-driven watch spec (extraction schema) from baseline, if available.
    baselineAnalysis: baselineAnalysis || null,
    watchSpec: baselineAnalysis?.watch_spec || null,
    reuseImportantChunkIds: focusChunkIds || null,
    reuseImportantPromptHash: promptHash || null,


  });

  const zadanieId = newAnalysis?.zadanieId || snapshot?.zadanie_id || snapshot?.zadanieId;
  if (zadanieId && newAnalysis?._inserted === true && newAnalysis?._id) {
    await setTaskAnalysisMongoId(zadanieId, newAnalysis._id, { force: forceAnalysis, log });
  }
  
  // Aktualizuj w PG ID ostatniej DOBREJ analizy tylko jeśli obecna analiza jest wystarczająco dobra
  // (głównie: gdy chunking jest włączony, nie zapisuj baseline z błędnym template)
  if (newAnalysis?._id && isGoodAnalysisForBaseline(newAnalysis)) {
    await setMonitorLastGoodAnalysisId(monitorId, newAnalysis._id, lastGoodAnalysisId, { log });

  } else {
    log.info('pg_last_good_analysis_skip', {
      monitorId: String(monitorId),
      analizaId: newAnalysis?._id ? String(newAnalysis._id) : null,
      error: newAnalysis?.error || newAnalysis?.chunk_template?.error || null,
      chunkingEnabled: process.env.LLM_CHUNKING_ENABLED === '1',
      chunkTemplateChunks: Array.isArray(newAnalysis?.chunk_template?.chunks)
        ? newAnalysis.chunk_template.chunks.length
        : null,
      chunkTemplateFitRatio: typeof newAnalysis?.chunk_template?.fitRatio === 'number'
        ? newAnalysis.chunk_template.fitRatio
        : null,
    });
  }
  
  log?.info?.('pipeline_step_done', {
    step: 'ensureSnapshotAnalysis_new',
    snapshotId: snapshotIdStr,
    monitorId: snapshot.monitor_id,
    durationMs: Math.round(performance.now() - tAnalysis0),
    ok: !!newAnalysis,
  });

// 4) poprzednia analiza – bierzemy ją z prevSnapshot (nie z baseline), bo tylko to daje poprawny diff universal_data
let prevAnalysis = null;

// NIE generujemy tutaj analizy poprzedniego snapshotu — tylko próbujemy odczytać z Mongo
if (prevSnapshot) {
  const tPrevAnalysis0 = performance.now();
  prevAnalysis = await getSnapshotAnalysis(prevSnapshot._id, { logger: log });
  log.info('pipeline_step_done', {
    step: 'prevAnalysis_from_prevSnapshot',
    snapshotId: snapshotIdStr,
    durationMs: Math.round(performance.now() - tPrevAnalysis0),
    found: !!prevAnalysis,
  });
}



  // ---- 4) Enriched diff (includes universal_data changes) ----
  const tDiff1 = performance.now();
  const diff = await computeMachineDiff(prevSnapshot, snapshot, {
    logger: log,
    prevAnalysis,
    newAnalysis,
    focusChunkIds: focusChunkIds || null,
    chunkTemplate: baselineAnalysis?.chunk_template || null,
  });

  log?.info?.('pipeline_step_done', {
    step: 'computeMachineDiff_full',
    snapshotId: snapshotIdStr,
    monitorId: snapshot.monitor_id,
    durationMs: Math.round(performance.now() - tDiff1),
    hasAnyChange: !!diff?.hasAnyChange,
  });

  // ---- 5) Judge / decision ----
  const tJudge0 = performance.now();
  const llmDecision = await evaluateChangeWithLLM(
    {
      monitorId: snapshot.monitor_id,
      zadanieId,
      url: snapshot.url,
      prevAnalysis,
      newAnalysis,
      diff,
      userPrompt: normalizedUserPrompt,
      watchSpec: newAnalysis?.watch_spec || baselineAnalysis?.watch_spec || null,
    },
    { logger: log },
  );

  log?.info?.('pipeline_step_done', {
    step: 'evaluateChangeWithLLM',
    snapshotId: snapshotIdStr,
    durationMs: Math.round(performance.now() - tJudge0),
    importantByLLM: !!llmDecision?.parsed?.important,
  });

  if (!llmDecision?.parsed?.important) {
    log?.info?.('pipeline_done', {
      snapshotId: snapshotIdStr,
      monitorId: snapshot.monitor_id,
      result: 'not_important',
      durationMs: Math.round(performance.now() - tPipeline0),
    });
    return;
  }

  // ---- 6) Save detection + notification ----
  const tSave0 = performance.now();
  const { detectionId: wykrycieId } = await saveDetectionAndNotification(
    {
      monitorId: snapshot.monitor_id,
      zadanieId,
      url: snapshot.url,
      snapshotMongoId: snapshot._id,
      diff: {
        ...diff,
        evidence_used: llmDecision?.parsed?.evidence_used || [],
      },
      llmDecision: llmDecision.parsed,
    },
    { logger: log },
  );

  log?.info?.('pipeline_step_done', {
    step: 'saveDetectionAndNotification',
    snapshotId: snapshotIdStr,
    durationMs: Math.round(performance.now() - tSave0),
    wykrycieId,
  });

  log?.info?.('pipeline_done', {
    snapshotId: snapshotIdStr,
    monitorId: snapshot.monitor_id,
    result: 'important_saved',
    durationMs: Math.round(performance.now() - tPipeline0),
  });
}

