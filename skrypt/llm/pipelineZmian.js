// skrypt/pipelineZmian.js
import { mongoClient } from "../polaczenieMDB.js";
import { ObjectId } from "mongodb";
import { ensureSnapshotAnalysis } from "./analizaSnapshotu.js";
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

  // 1) analiza nowego snapshotu
  const tAnalysis0 = performance.now();
  const newAnalysis = await ensureSnapshotAnalysis(snapshot, {
    force: forceAnalysis,
    logger,
  });
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

  if (!diff.hasAnyChange) {
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
  let prevAnalysis = null;
  if (prevSnapshot) {
    const tPrevAnalysis0 = performance.now();
    prevAnalysis = await getSnapshotAnalysis(prevSnapshot._id, { logger });
    log.info("pipeline_step_done", {
      step: "getSnapshotAnalysis",
      snapshotId: snapshotIdStr,
      durationMs: Math.round(performance.now() - tPrevAnalysis0),
    });
  }

  const tLlm0 = performance.now();
  const llmDecision = await evaluateChangeWithLLM(
    {
      monitorId: snapshot.monitor_id,
      zadanieId: snapshot.zadanie_id,
      url: snapshot.url,
      prevAnalysis,
      newAnalysis,
      diff,
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

  const importantByLLM = !!(llmDecision.parsed && llmDecision.parsed.important);

  const isImportant = pluginPricesChanged || importantByLLM;

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

  const decisionToSave = llmDecision.parsed || fallbackDecision;

  const tSave0 = performance.now();
  const { detectionId: wykrycieId } = await saveDetectionAndNotification(
    {
      monitorId: snapshot.monitor_id,
      zadanieId: snapshot.zadanie_id,
      url: snapshot.url,
      snapshotMongoId: snapshot._id,
      diff,
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
