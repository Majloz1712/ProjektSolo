// skrypt/pipelineZmian.js
import { mongoClient } from "../polaczenieMDB.js";
import { pool } from '../polaczeniePG.js';
import { ObjectId } from "mongodb";
import { ensureSnapshotAnalysis } from "./analizaSnapshotu.js";
import { ensureSnapshotOcr } from "./ocrSnapshotu.js";
import { performance } from "node:perf_hooks";
import {
  getPreviousSnapshot,
  computeMachineDiff,
  getSnapshotAnalysis,
} from "./diffEngine.js";
import {
  evaluateChangeWithLLM,
  saveDetectionAndNotification,
} from "./ocenaZmianyLLM.js";

const db = mongoClient.db("inzynierka");
const snapshotsCol = db.collection("snapshots");

/**
 * Główny pipeline obsługujący nowy snapshot:
 *  - analiza snapshotu (LLM #1)
 *  - diff do poprzedniego
 *  - ocena zmiany (LLM #2)
 *  - zapis wykrycia / powiadomienia
 */
 
 
 
 
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

 
 
 
 
 
export async function handleNewSnapshot(snapshotRef, options = {}) {
  const { forceAnalysis = false, logger } = options;
  const log = logger || console;

  let snapshot;

  if (snapshotRef && typeof snapshotRef === "object" && snapshotRef._id) {
    snapshot = snapshotRef;
  } else {
    const id =
      typeof snapshotRef === "string" ? new ObjectId(snapshotRef) : snapshotRef;

    snapshot = await snapshotsCol.findOne({ _id: id });
  }

  if (!snapshot) {
    log.warn("[pipeline] snapshot not found", snapshotRef);
    return;
  }

  const snapshotIdStr = snapshot._id.toString();

  log.info("pipeline_start", {
    snapshotId: snapshotIdStr,
    forceAnalysis,
    monitorId: snapshot.monitor_id,
  });

  const tPipeline0 = performance.now();

   // 1) OCR nowego snapshotu (tesseract) – zapis do snapshotu + update obiektu w pamięci
  const tOcrNew0 = performance.now();
  const newOcr = await ensureSnapshotOcr(snapshot, { logger });
  log.info("pipeline_step_done", {
    step: "ensureSnapshotOcr_new",
    snapshotId: snapshotIdStr,
    monitorId: snapshot.monitor_id,
    durationMs: Math.round(performance.now() - tOcrNew0),
    ocrPresent: !!newOcr,
  });

  // 2) analiza nowego snapshotu (ma już snapshot.vision_ocr jako fallback)
  const tAnalysis0 = performance.now();
  const newAnalysis = await ensureSnapshotAnalysis(snapshot, {
    force: forceAnalysis,
    logger,
  });

  // ✅ Zapisz w PG link do analizy w Mongo (tylko jeśli mamy zadanieId)
  const zadanieId = newAnalysis?.zadanieId || snapshot?.zadanie_id || snapshot?.zadanieId;
  const analizaId = newAnalysis?._id;

  if (zadanieId) {
      await setTaskAnalysisMongoId(zadanieId, analizaId, { force: forceAnalysis, log });
  } else {
    log.warn('pg_analiza_mongo_id_skip_no_zadanieId', {
      snapshotId: snapshotIdStr,
      analizaId: analizaId ? String(analizaId) : null,
    });
  }

  log.info("pipeline_step_done", {
    step: "ensureSnapshotAnalysis",
    snapshotId: snapshotIdStr,
    monitorId: snapshot.monitor_id,
    durationMs: Math.round(performance.now() - tAnalysis0),
  });


  // 2) poprzedni snapshot
  const tPrev0 = performance.now();
  const prevSnapshot = await getPreviousSnapshot(snapshot, { logger });
  log.info("pipeline_step_done", {
    step: "getPreviousSnapshot",
    snapshotId: snapshotIdStr,
    monitorId: snapshot.monitor_id,
    durationMs: Math.round(performance.now() - tPrev0),
  });



  // 3) OCR jako extractor (tesseract) – tylko czytanie i zapis do snapshotu
  // 3) OCR poprzedniego snapshotu (tesseract) – żeby diff + LLM miały prevOcr
  let prevOcr = null;
  if (prevSnapshot) {
    const tOcrPrev0 = performance.now();
    prevOcr = await ensureSnapshotOcr(prevSnapshot, { logger });
    log.info("pipeline_step_done", {
      step: "ensureSnapshotOcr_prev",
      snapshotId: snapshotIdStr,
      monitorId: snapshot.monitor_id,
      durationMs: Math.round(performance.now() - tOcrPrev0),
      ocrPresent: !!prevOcr,
    });
  }

  // 3) diff
  const tDiff0 = performance.now();
  const diff = await computeMachineDiff(prevSnapshot, snapshot, { logger });
  log.info("pipeline_step_done", {
    step: "computeMachineDiff",
    snapshotId: snapshotIdStr,
    monitorId: snapshot.monitor_id,
    durationMs: Math.round(performance.now() - tDiff0),
    hasAnyChange: !!diff?.hasAnyChange,
  });

  const screenshotChanged = !!diff?.metrics?.screenshotChanged;

  if (!diff?.hasAnyChange && !screenshotChanged) {
    log.info("[pipeline] Brak zmian – kończę na warstwie 2.", {
      snapshotId: snapshotIdStr,
      monitorId: snapshot.monitor_id,
    });

    log.info("pipeline_done", {
      snapshotId: snapshotIdStr,
      monitorId: snapshot.monitor_id,
      result: "no_change",
      durationMs: Math.round(performance.now() - tPipeline0),
    });

    return;
  }

  // 4) poprzednia analiza LLM (jeśli była)
  // 4) poprzednia analiza LLM (jeśli była; jeśli nie – dobuduj, bo mamy już prevSnapshot.vision_ocr)
  let prevAnalysis = null;
  if (prevSnapshot) {
    const tPrevAnalysis0 = performance.now();
    prevAnalysis = await getSnapshotAnalysis(prevSnapshot._id, { logger });

    if (!prevAnalysis) {
      prevAnalysis = await ensureSnapshotAnalysis(prevSnapshot, { force: false, logger });
    }

    log.info("pipeline_step_done", {
      step: "prevAnalysis_ready",
      snapshotId: snapshotIdStr,
      durationMs: Math.round(performance.now() - tPrevAnalysis0),
      found: !!prevAnalysis,
    });
  }


  const tLlm0 = performance.now();
const llmDecision = await evaluateChangeWithLLM(
  {
    monitorId: snapshot.monitor_id,
    zadanieId, // <- spójnie: to samo co poszło do PG (analiza_mongo_id)
    url: snapshot.url,
    prevAnalysis,
    newAnalysis,
    diff,
    prevOcr: prevOcr || null,
    newOcr: newOcr || null,
  },
  { logger },
);



  log.info("pipeline_step_done", {
    step: "evaluateChangeWithLLM",
    snapshotId: snapshotIdStr,
    durationMs: Math.round(performance.now() - tLlm0),
    importantByLLM: !!llmDecision?.parsed?.important,
  });

  const pluginPricesChanged = !!(
    diff &&
    diff.metrics &&
    diff.metrics.pluginPricesChanged
  );

const importantByLLM = !!(llmDecision?.parsed?.important);


const machinePriceChanged = !!(diff?.metrics?.price && diff.metrics.price.absChange !== 0);
const isImportant = pluginPricesChanged || machinePriceChanged || importantByLLM;


  if (!isImportant) {
    log.info("pipeline_done", {
      snapshotId: snapshotIdStr,
      monitorId: snapshot.monitor_id,
      result: "not_important",
      durationMs: Math.round(performance.now() - tPipeline0),
    });

    return;
  }

  // Jeśli dotarliśmy tutaj, to albo LLM, albo twarde reguły mówią "ważne"
  const fallbackDecision = {
    important: true,
    category: pluginPricesChanged ? "price_change" : "llm_error",
    importance_reason: pluginPricesChanged
      ? "Wymuszona istotność na podstawie diff.metrics.pluginPricesChanged == true."
      : "Brak decyzji LLM; zapis wymuszony regułą.",
    short_title: pluginPricesChanged
      ? "Zmiana cen na monitorowanej stronie"
      : "Zmiana uznana za istotną przez reguły",
    short_description: pluginPricesChanged
      ? "Wykryto zmianę cen (plugin_prices) na monitorowanej stronie."
      : "Zmiana uznana za istotną na podstawie twardych reguł.",
  };

const decisionToSave = llmDecision?.parsed || fallbackDecision;

  const tSave0 = performance.now();
const { detectionId: wykrycieId } = await saveDetectionAndNotification(
  {
    monitorId: snapshot.monitor_id,
    zadanieId, // <- spójnie
    url: snapshot.url,
    snapshotMongoId: snapshot._id,
    diff,
    prevOcr: prevSnapshot?.vision_ocr || null,
    newOcr: snapshot?.vision_ocr || null,
    llmDecision: decisionToSave,
  },
  { logger },
);

  log.info("pipeline_step_done", {
    step: "saveDetectionAndNotification",
    snapshotId: snapshotIdStr,
    durationMs: Math.round(performance.now() - tSave0),
    wykrycieId,
  });

  log.info("pipeline_done", {
    snapshotId: snapshotIdStr,
    monitorId: snapshot.monitor_id,
    result: "important_saved",
    durationMs: Math.round(performance.now() - tPipeline0),
  });
}
