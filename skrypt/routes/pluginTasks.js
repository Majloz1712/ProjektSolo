// skrypt/routes/pluginTasks.js
import express from "express";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

import { pool } from "../polaczeniePG.js";
import { mongoClient } from "../polaczenieMDB.js";
import { fetchAndExtract } from "../../orchestrator/extractOrchestrator.js";
import { handleNewSnapshot } from "../llm/pipelineZmian.js";
import { createTaskLogger } from "../loggerZadan.js";

const router = express.Router();

// UWAGA: zadziała tylko jeśli router jest montowany przed globalnym express.json(),
router.use(express.json({ limit: "50mb" }));

async function ensureMongoDb() {
  try {
    const connected =
      mongoClient?.topology?.isConnected?.() ||
      mongoClient?.topology?.s?.state === "connected";

    if (!connected) await mongoClient.connect();
  } catch {
    await mongoClient.connect();
  }

  const dbName = process.env.MONGO_DB || "inzynierka";
  return mongoClient.db(dbName);
}

function normalizeB64(b64) {
  if (!b64) return null;
  let s = String(b64).trim();

  const idx = s.indexOf("base64,");
  if (idx !== -1) s = s.slice(idx + 7);

  if (s.startsWith("data:")) {
    const comma = s.indexOf(",");
    if (comma !== -1) s = s.slice(comma + 1);
  }

  s = s.trim();
  return s.length ? s : null;
}

function sha1(str) {
  if (!str) return null;
  return crypto.createHash("sha1").update(str).digest("hex");
}

async function loadMonitorPrompt(client, monitorId) {
  if (!monitorId) return null;
  const { rows } = await client.query(
    `SELECT llm_prompt
       FROM monitory
      WHERE id = $1`,
    [monitorId],
  );
  return rows[0]?.llm_prompt || null;
}

async function safeLoadMonitorPrompt(pg, monitorId, logger, label) {
  if (!monitorId) return null;
  try {
    return await loadMonitorPrompt(pg, monitorId);
  } catch (err) {
    logger?.warn?.(`${label}_monitor_prompt_failed`, {
      monitorId,
      error: String(err?.message || err),
    });
    return null;
  }
}

// Bezpieczne: działa niezależnie czy w URL jest plugin_tasks.id czy zadanie_id
async function resolvePluginTaskByAnyId(client, anyId) {
  const { rows } = await client.query(
    `SELECT id, monitor_id, zadanie_id, url, mode, status
       FROM plugin_tasks
      WHERE id::text = $1 OR zadanie_id::text = $1
      ORDER BY utworzone_at DESC
      LIMIT 1`,
    [String(anyId)],
  );
  return rows[0] || null;
}

async function setPluginTaskStatus(client, pluginTaskId, status, bladOpis = null) {
  await client.query(
    `UPDATE plugin_tasks
        SET status = $2,
            blad_opis = $3,
            zaktualizowane_at = NOW()
      WHERE id = $1`,
    [pluginTaskId, status, bladOpis],
  );
}

async function finishScanTask(
  client,
  zadanieId,
  { status, blad_opis = null, snapshot_mongo_id = null },
) {
  if (!zadanieId) return;

  await client.query(
    `UPDATE zadania_skanu
        SET status = $2,
            zakonczenie_at = NOW(),
            blad_opis = $3,
            snapshot_mongo_id = $4
      WHERE id = $1`,
    [zadanieId, status, blad_opis, snapshot_mongo_id],
  );
}

// ==========================================================
// GET /api/plugin-tasks/next
// ==========================================================
router.get("/next", async (req, res) => {
  const t0 = performance.now();
  const client = await pool.connect();

  try {
    // Atomowe "claim"
    const { rows } = await client.query(
      `WITH picked AS (
         SELECT id
           FROM plugin_tasks
          WHERE status = 'pending'
          ORDER BY utworzone_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE plugin_tasks p
          SET status = 'in_progress',
              zaktualizowane_at = NOW()
         FROM picked
        WHERE p.id = picked.id
       RETURNING p.id, p.monitor_id, p.zadanie_id, p.url, p.mode`,
    );

    if (!rows.length) {
      console.log("[plugin-tasks] next_empty", {
        durationMs: Math.round(performance.now() - t0),
      });
      return res.status(204).send();
    }

    const task = rows[0];

    console.log("[plugin-tasks] next_done", {
      taskId: task.id,
      monitorId: task.monitor_id,
      durationMs: Math.round(performance.now() - t0),
      mode: task.mode,
    });

    return res.json({
      task_id: task.id,
      monitor_id: task.monitor_id,
      zadanie_id: task.zadanie_id,
      url: task.url,
      mode: task.mode || "fallback",
    });
  } catch (err) {
    console.error("[plugin-tasks] /next error", err);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  } finally {
    client.release();
  }
});

// ==========================================================
// POST /api/plugin-tasks/:id/result
// (DOM + opcjonalnie screenshot) - tryb ogólny
// ==========================================================
router.post("/:id/result", async (req, res) => {
  const t0 = performance.now();
  const { id } = req.params;

  const {
    monitor_id: monitorId,
    zadanie_id: zadanieIdFromBody,
    screenshot_b64: screenshotB64,
    url,
    html,
    text,
  } = req.body || {};

  const hasScreenshot = typeof screenshotB64 === "string" && screenshotB64.length > 0;
  const hasDom =
    (typeof html === "string" && html.length > 0) ||
    (typeof text === "string" && text.length > 0);

  if (!monitorId || (!hasScreenshot && !hasDom)) {
    return res.status(400).json({ error: "MISSING_FIELDS" });
  }

  let logger = console;
  try {
    logger = await createTaskLogger({ monitorId, zadanieId: zadanieIdFromBody || id });
  } catch {
    // ignore
  }

  const pg = await pool.connect();
  let pluginTask = null;
  let scanTaskId = null;

  try {
    pluginTask = await resolvePluginTaskByAnyId(pg, id);
    if (!pluginTask) return res.status(404).json({ error: "PLUGIN_TASK_NOT_FOUND" });

    // finalne zadanie (UI patrzy na zadania_skanu)
    scanTaskId = zadanieIdFromBody || pluginTask.zadanie_id || null;

    // ktoś mógł strzelić endpoint z palca
    if (pluginTask.status === "pending") {
      await setPluginTaskStatus(pg, pluginTask.id, "in_progress", null);
    }

    const monitorPrompt = await safeLoadMonitorPrompt(pg, monitorId, logger, "plugin_result");
    const db = await ensureMongoDb();
    const snapshots = db.collection("snapshots");
    const now = new Date();

    // 1) Extractory, jeśli dostaliśmy DOM
    let extracted = null;
    if (hasDom) {
      try {
        const htmlForExtractors =
          typeof html === "string" && html.length > 0
            ? html
            : `<html><body>${String(text || "")}</body></html>`;

        const tExtract0 = performance.now();
        extracted = await fetchAndExtract(url || "", {
          render: false,
          correlationId: `plugin-result-${pluginTask.id}`,
          html: htmlForExtractors,
        });

        logger?.info?.("plugin_result_extract_done", {
          pluginTaskId: pluginTask.id,
          durationMs: Math.round(performance.now() - tExtract0),
          extractor: extracted?.extractor ?? null,
          confidence: extracted?.confidence ?? null,
        });
      } catch (err) {
        logger?.warn?.("plugin_result_extract_failed", {
          pluginTaskId: pluginTask.id,
          error: String(err?.message || err),
        });
      }
    }

    // 2) Screenshot meta
    const normShot = hasScreenshot ? normalizeB64(screenshotB64) : null;
    const screenshotSha1 = normShot ? sha1(normShot) : null;
    const screenshotLen = normShot ? normShot.length : 0;

    // 3) Upsert snapshot
    let snapshot = null;
    if (scanTaskId) {
      snapshot = await snapshots
        .find({ monitor_id: monitorId, zadanie_id: scanTaskId })
        .sort({ ts: -1 })
        .limit(1)
        .next();
    }

    let snapshotIdStr = null;

    if (snapshot) {
      const $set = {
        mode: "plugin",
        blocked: false,
        block_reason: null,
        final_url: url || snapshot.final_url || null,
        plugin_result_at: now,
        ...(monitorPrompt ? { llm_prompt: monitorPrompt } : {}),
      };

      if (hasDom) {
        $set.plugin_dom_text = text || null;
        $set.plugin_dom_fetched_at = now;
      }

      if (hasScreenshot) {
        $set.screenshot_b64 = normShot;
        $set.screenshot_b64_len = screenshotLen;
        $set.screenshot_sha1 = screenshotSha1;
        $set.plugin_screenshot_at = now;
        $set.plugin_screenshot_source = "chrome_extension";
        $set.plugin_screenshot_fullpage = true;
      }

      if (extracted) $set.extracted_v2 = extracted;

      await snapshots.updateOne({ _id: snapshot._id }, { $set });
      snapshotIdStr = snapshot._id.toString();

      logger?.info?.("plugin_result_mongo_update_done", {
        pluginTaskId: pluginTask.id,
        snapshotId: snapshotIdStr,
        hasDom,
        hasScreenshot,
        screenshotLen,
      });
    } else {
      const doc = {
        monitor_id: monitorId,
        zadanie_id: scanTaskId,
        url: url || pluginTask.url || null,
        ts: now,
        mode: "plugin",
        final_url: url || pluginTask.url || null,
        llm_prompt: monitorPrompt || null,
        blocked: false,
        block_reason: null,

        plugin_dom_text: hasDom ? text || null : null,
        plugin_dom_fetched_at: hasDom ? now : null,

        screenshot_b64: hasScreenshot ? normShot : null,
        screenshot_b64_len: hasScreenshot ? screenshotLen : 0,
        screenshot_sha1: hasScreenshot ? screenshotSha1 : null,
        plugin_screenshot_at: hasScreenshot ? now : null,
        plugin_screenshot_source: hasScreenshot ? "chrome_extension" : null,
        plugin_screenshot_fullpage: hasScreenshot ? true : null,

        extracted_v2: extracted || null,
      };

      const { insertedId } = await snapshots.insertOne(doc);
      snapshotIdStr = insertedId.toString();

      logger?.info?.("plugin_result_mongo_insert_done", {
        pluginTaskId: pluginTask.id,
        snapshotId: snapshotIdStr,
        hasDom,
        hasScreenshot,
        screenshotLen,
      });
    }

    // 4) Pipeline
    try {
      const tPipe0 = performance.now();
      await handleNewSnapshot(snapshotIdStr, { logger, userPrompt: monitorPrompt });
      logger?.info?.("plugin_result_pipeline_done", {
        snapshotId: snapshotIdStr,
        durationMs: Math.round(performance.now() - tPipe0),
      });
    } catch (err) {
      const errMsg = String(err?.message || err).slice(0, 300);

      await setPluginTaskStatus(pg, pluginTask.id, "error", `PIPELINE_ERROR: ${errMsg}`);
      await finishScanTask(pg, scanTaskId, {
        status: "blad",
        blad_opis: `PIPELINE_ERROR: ${errMsg}`.slice(0, 500),
        snapshot_mongo_id: snapshotIdStr,
      });

      logger?.error?.("plugin_result_pipeline_error", {
        snapshotId: snapshotIdStr,
        error: String(err?.message || err),
      });
      return res.status(500).json({ error: "PIPELINE_ERROR" });
    }

    // 5) done
    await setPluginTaskStatus(pg, pluginTask.id, "done", null);
    await finishScanTask(pg, scanTaskId, {
      status: "ok",
      blad_opis: null,
      snapshot_mongo_id: snapshotIdStr,
    });

    logger?.info?.("plugin_result_done", {
      pluginTaskId: pluginTask.id,
      durationMs: Math.round(performance.now() - t0),
    });

    return res.json({ ok: true, snapshot_id: snapshotIdStr });
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 500);

    try {
      if (pluginTask?.id) await setPluginTaskStatus(pg, pluginTask.id, "error", msg);
      if (scanTaskId) {
        await finishScanTask(pg, scanTaskId, {
          status: "blad",
          blad_opis: `PLUGIN_RESULT_ERROR: ${msg}`.slice(0, 500),
          snapshot_mongo_id: null,
        });
      }
    } catch {
      // ignore
    }

    console.error("[plugin-tasks] /:id/result error", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  } finally {
    pg.release();
    try {
      logger?.close?.();
    } catch {
      // ignore
    }
  }
});

// ==========================================================
// POST /api/plugin-tasks/:id/price
// (price_only - same ceny / lista cen)
// ==========================================================
router.post("/:id/price", async (req, res) => {
  const t0 = performance.now();
  const { id } = req.params;

  const { monitor_id: monitorId, zadanie_id: zadanieId, url, prices } = req.body || {};

  if (!monitorId || !zadanieId || !url || !Array.isArray(prices)) {
    return res.status(400).json({ error: "MISSING_FIELDS" });
  }

  let logger = console;
  try {
    logger = await createTaskLogger({ monitorId, zadanieId });
  } catch {
    // ignore
  }

  const pg = await pool.connect();
  let pluginTask = null;

  try {
    pluginTask = await resolvePluginTaskByAnyId(pg, id);
    if (!pluginTask) return res.status(404).json({ error: "PLUGIN_TASK_NOT_FOUND" });

    const monitorPrompt = await safeLoadMonitorPrompt(pg, monitorId, logger, "plugin_price");
    const db = await ensureMongoDb();
    const snapshots = db.collection("snapshots");

    // znajdź NAJNOWSZY snapshot (monitor_id + zadanie_id)
    const tFind0 = performance.now();
    const snapshot = await snapshots
      .find({ monitor_id: monitorId, zadanie_id: zadanieId })
      .sort({ ts: -1 })
      .limit(1)
      .next();

    logger?.info?.("plugin_price_mongo_find_done", {
      monitorId,
      zadanieId,
      found: !!snapshot,
      durationMs: Math.round(performance.now() - tFind0),
      pricesCount: prices.length,
    });

    if (!snapshot) {
      await setPluginTaskStatus(pg, pluginTask.id, "done", "SNAPSHOT_NOT_FOUND");
      return res.json({ ok: true, snapshot_id: null });
    }

    const snapshotIdStr = snapshot._id.toString();

    // dopisz ceny
    const tUpd0 = performance.now();
    const $set = {
      plugin_prices: prices,
      plugin_price_enriched_at: new Date(),
      ...(monitorPrompt ? { llm_prompt: monitorPrompt } : {}),
    };

    await snapshots.updateOne({ _id: snapshot._id }, { $set });

    logger?.info?.("plugin_price_mongo_update_done", {
      snapshotId: snapshotIdStr,
      durationMs: Math.round(performance.now() - tUpd0),
    });

    // pipeline
    try {
      const tPipe0 = performance.now();
      await handleNewSnapshot(snapshotIdStr, { logger, userPrompt: monitorPrompt });
      logger?.info?.("plugin_price_pipeline_done", {
        snapshotId: snapshotIdStr,
        durationMs: Math.round(performance.now() - tPipe0),
      });
    } catch (err) {
      const errMsg = String(err?.message || err).slice(0, 300);

      await setPluginTaskStatus(pg, pluginTask.id, "error", `PIPELINE_ERROR: ${errMsg}`);
      await finishScanTask(pg, zadanieId, {
        status: "blad",
        blad_opis: `PIPELINE_ERROR: ${errMsg}`.slice(0, 500),
        snapshot_mongo_id: snapshotIdStr,
      });

      logger?.error?.("plugin_price_pipeline_error", {
        snapshotId: snapshotIdStr,
        error: String(err?.message || err),
      });
      return res.status(500).json({ error: "PIPELINE_ERROR" });
    }

    // done
    await setPluginTaskStatus(pg, pluginTask.id, "done", null);
    await finishScanTask(pg, zadanieId, {
      status: "ok",
      blad_opis: null,
      snapshot_mongo_id: snapshotIdStr,
    });

    logger?.info?.("plugin_price_done", {
      pluginTaskId: pluginTask.id,
      durationMs: Math.round(performance.now() - t0),
    });

    return res.json({ ok: true, snapshot_id: snapshotIdStr });
  } catch (err) {
    try {
      if (pluginTask?.id) {
        await setPluginTaskStatus(pg, pluginTask.id, "error", String(err?.message || err).slice(0, 500));
      }
    } catch {
      // ignore
    }

    logger?.error?.("plugin_price_error", {
      error: String(err?.message || err),
      durationMs: Math.round(performance.now() - t0),
    });

    return res.status(500).json({ error: "SERVER_ERROR" });
  } finally {
    pg.release();
    try {
      logger?.close?.();
    } catch {
      // ignore
    }
  }
});

// ==========================================================
// POST /api/plugin-tasks/:id/screenshot
// (plugin screenshot – tylko obraz)
// ==========================================================
router.post("/:id/screenshot", async (req, res) => {
  const t0 = performance.now();
  const { id } = req.params;

  const {
    monitor_id: monitorId,
    zadanie_id: zadanieId,
    url,
    screenshot_b64: screenshotB64,
  } = req.body || {};

  const hasScreenshot = typeof screenshotB64 === "string" && screenshotB64.length > 0;
  if (!monitorId || !zadanieId || !hasScreenshot) {
    return res.status(400).json({ error: "MISSING_FIELDS" });
  }

  const normShot = normalizeB64(screenshotB64);
  const screenshotSha1 = normShot ? sha1(normShot) : null;
  const screenshotLen = normShot ? normShot.length : 0;

  let logger = console;
  try {
    logger = await createTaskLogger({ monitorId, zadanieId });
  } catch {
    // ignore
  }

  const pg = await pool.connect();
  let pluginTask = null;

  try {
    pluginTask = await resolvePluginTaskByAnyId(pg, id);
    if (!pluginTask) return res.status(404).json({ error: "PLUGIN_TASK_NOT_FOUND" });

    const monitorPrompt = await safeLoadMonitorPrompt(pg, monitorId, logger, "plugin_screenshot");
    const db = await ensureMongoDb();
    const snapshots = db.collection("snapshots");

    // znajdź NAJNOWSZY snapshot (monitor_id + zadanie_id)
    const tFind0 = performance.now();
    const snapshot = await snapshots
      .find({ monitor_id: monitorId, zadanie_id: zadanieId })
      .sort({ ts: -1 })
      .limit(1)
      .next();

    logger?.info?.("plugin_screenshot_mongo_find_done", {
      monitorId,
      zadanieId,
      found: !!snapshot,
      durationMs: Math.round(performance.now() - tFind0),
      screenshotLen,
    });

    const now = new Date();

    // LAZY: identyczny screenshot => skip pipeline
    if (snapshot && snapshot.screenshot_sha1 && screenshotSha1 && snapshot.screenshot_sha1 === screenshotSha1) {
      const snapshotIdStr = snapshot._id.toString();

      await snapshots.updateOne(
        { _id: snapshot._id },
        {
          $set: {
            plugin_screenshot_at: now,
            final_url: url || snapshot.final_url || null,
            ...(monitorPrompt ? { llm_prompt: monitorPrompt } : {}),
          },
        },
      );

      await setPluginTaskStatus(pg, pluginTask.id, "done", null);
      await finishScanTask(pg, zadanieId, {
        status: "ok",
        blad_opis: null,
        snapshot_mongo_id: snapshotIdStr,
      });

      logger?.info?.("plugin_screenshot_lazy_skip", {
        snapshotId: snapshotIdStr,
        reason: "same_screenshot_sha1",
      });

      return res.json({ ok: true, snapshot_id: snapshotIdStr, skipped: true });
    }

    // update albo insert
    let snapshotIdStr = null;

    if (snapshot) {
      const tUpd0 = performance.now();
      const $set = {
        mode: snapshot.mode || "plugin_screenshot",
        final_url: url || snapshot.final_url || pluginTask.url || null,
        screenshot_b64: normShot,
        screenshot_b64_len: screenshotLen,
        screenshot_sha1: screenshotSha1,
        plugin_screenshot_at: now,
        plugin_screenshot_source: "chrome_extension",
        plugin_screenshot_fullpage: true,
        ...(monitorPrompt ? { llm_prompt: monitorPrompt } : {}),
      };

      await snapshots.updateOne({ _id: snapshot._id }, { $set });
      snapshotIdStr = snapshot._id.toString();

      logger?.info?.("plugin_screenshot_mongo_update_done", {
        snapshotId: snapshotIdStr,
        durationMs: Math.round(performance.now() - tUpd0),
      });
    } else {
      const doc = {
        monitor_id: monitorId,
        zadanie_id: zadanieId,
        url: url || pluginTask.url || null,
        ts: now,
        mode: "plugin_screenshot",
        final_url: url || pluginTask.url || null,
        llm_prompt: monitorPrompt || null,
        blocked: false,
        block_reason: null,

        screenshot_b64: normShot,
        screenshot_b64_len: screenshotLen,
        screenshot_sha1: screenshotSha1,

        plugin_screenshot_at: now,
        plugin_screenshot_source: "chrome_extension",
        plugin_screenshot_fullpage: true,

        extracted_v2: null,
      };

      const tIns0 = performance.now();
      const { insertedId } = await snapshots.insertOne(doc);
      snapshotIdStr = insertedId.toString();

      logger?.info?.("plugin_screenshot_mongo_insert_done", {
        snapshotId: snapshotIdStr,
        durationMs: Math.round(performance.now() - tIns0),
      });
    }

    // pipeline
    try {
      const tPipe0 = performance.now();
      await handleNewSnapshot(snapshotIdStr, { logger, userPrompt: monitorPrompt });
      logger?.info?.("plugin_screenshot_pipeline_done", {
        snapshotId: snapshotIdStr,
        durationMs: Math.round(performance.now() - tPipe0),
      });
    } catch (err) {
      const errMsg = String(err?.message || err).slice(0, 300);

      await setPluginTaskStatus(pg, pluginTask.id, "error", `PIPELINE_ERROR: ${errMsg}`);
      await finishScanTask(pg, zadanieId, {
        status: "blad",
        blad_opis: `PIPELINE_ERROR: ${errMsg}`.slice(0, 500),
        snapshot_mongo_id: snapshotIdStr,
      });

logger.error('plugin_screenshot_pipeline_error', {
  err: String(err),
  stack: err?.stack,
  monitorId,
  zadanieId,
});

      return res.status(500).json({ error: "PIPELINE_ERROR" });
    }

    // done
    await setPluginTaskStatus(pg, pluginTask.id, "done", null);
    await finishScanTask(pg, zadanieId, {
      status: "ok",
      blad_opis: null,
      snapshot_mongo_id: snapshotIdStr,
    });

    logger?.info?.("plugin_screenshot_done", {
      pluginTaskId: pluginTask.id,
      snapshotId: snapshotIdStr,
      durationMs: Math.round(performance.now() - t0),
    });

    return res.json({ ok: true, snapshot_id: snapshotIdStr });
  } catch (err) {
    try {
      if (pluginTask?.id) {
        await setPluginTaskStatus(pg, pluginTask.id, "error", String(err?.message || err).slice(0, 500));
      }
    } catch {
      // ignore
    }

    console.error("[plugin-tasks] /:id/screenshot error", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  } finally {
    pg.release();
    try {
      logger?.close?.();
    } catch {
      // ignore
    }
  }
});

export default router;

