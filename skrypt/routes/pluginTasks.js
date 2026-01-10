// routes/pluginTasks.js

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
// inaczej request może być odrzucony wcześniej (413 Payload Too Large).
router.use(express.json({ limit: "50mb" }));

async function ensureMongoDb() {
  try {
    // kompatybilnie z różnymi wersjami drivera
    const connected =
      mongoClient?.topology?.isConnected?.() ||
      mongoClient?.topology?.s?.state === "connected";

    if (!connected) {
      await mongoClient.connect();
    }
  } catch {
    await mongoClient.connect();
  }

  const dbName = process.env.MONGO_DB || "inzynierka";
  return mongoClient.db(dbName);
}

function normalizeB64(b64) {
  if (!b64) return null;
  let s = String(b64).trim();

  // obetnij "data:image/...;base64,"
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

async function finishScanTask(client, zadanieId, {
  status,
  blad_opis = null,
  snapshot_mongo_id = null,
}) {
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
    // Atomowe "claim": nie ma wyścigów przy wielu klientach pluginu
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
    zadanie_id: zadanieId,
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
    logger = await createTaskLogger({ monitorId, zadanieId: zadanieId || id });
  } catch {
    // ignore
  }

  const pg = await pool.connect();
  let pluginTask = null;

  try {
    pluginTask = await resolvePluginTaskByAnyId(pg, id);
    if (!pluginTask) {
      return res.status(404).json({ error: "PLUGIN_TASK_NOT_FOUND" });
    }

    // zostawiamy in_progress (już jest), ale jakby ktoś strzelił "z palca" endpoint:
    if (pluginTask.status === "pending") {
      await setPluginTaskStatus(pg, pluginTask.id, "in_progress", null);
    }

    // do domykania PG taska (UI patrzy na zadania_skanu)
    const scanTaskId = zadanieId || pluginTask.zadanie_id || null;

  } catch (err) {
    pg.release();
    logger?.error?.("plugin_result_pg_resolve_error", { error: String(err?.message || err) });
    return res.status(500).json({ error: "PG_ERROR" });
  } finally {
    // pg będzie zwolniony niżej (po status update done/error)
  }

  try {
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

    // 3) Najpierw spróbuj zaktualizować snapshot (po monitor+zadanie, najnowszy)
    let snapshotIdStr = null;

    let existing = null;
    if (zadanieId) {
      existing = await snapshots
        .find({ monitor_id: monitorId, zadanie_id: zadanieId })
        .sort({ ts: -1 })
        .limit(1)
        .next();
    }

    if (existing) {
      const $set = {
        mode: "plugin",
        blocked: false,
        block_reason: null,
        final_url: url || existing.final_url || null,
        plugin_result_at: now,
      };

      if (hasDom) {
        $set.plugin_dom_text = text || null;
        $set.plugin_dom_fetched_at = now;
        // opcjonalnie trzymaj html (jeśli chcesz) – ale to bywa duże
        // $set.plugin_dom_html = typeof html === "string" ? html : null;
      }

      if (hasScreenshot) {
        $set.screenshot_b64 = normShot;
        $set.screenshot_b64_len = screenshotLen;
        $set.screenshot_sha1 = screenshotSha1;
        $set.plugin_screenshot_at = now;
        $set.plugin_screenshot_source = "chrome_extension";
        $set.plugin_screenshot_fullpage = true;
      }

      if (extracted) {
        $set.extracted_v2 = extracted;
      }

      await snapshots.updateOne({ _id: existing._id }, { $set });
      snapshotIdStr = existing._id?.toString?.() ?? null;

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
        zadanie_id: zadanieId || null,
        url: url || pluginTask.url || null,
        ts: now,
        mode: "plugin",
        final_url: url || pluginTask.url || null,
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
      snapshotIdStr = insertedId?.toString?.() ?? null;

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
      await handleNewSnapshot(snapshotIdStr, { logger });
      logger?.info?.("plugin_result_pipeline_done", {
        snapshotId: snapshotIdStr,
        durationMs: Math.round(performance.now() - tPipe0),
      });
    } catch (err) {
      logger?.error?.("plugin_result_pipeline_error", {
        snapshotId: snapshotIdStr,
        error: String(err?.message || err),
      });
      // pipeline error -> status error (żeby było widać, że coś nie pykło)
      // pipeline error -> status error (żeby było widać, że coś nie pykło)
      const errMsg = (err?.message || err).toString().slice(0, 300);
      await setPluginTaskStatus(pg, pluginTask.id, "error", `PIPELINE_ERROR: ${errMsg}`);

      await finishScanTask(pg, scanTaskId, {
        status: "blad",
        blad_opis: `PIPELINE_ERROR: ${errMsg}`.slice(0, 500),
        snapshot_mongo_id: snapshotIdStr,
      });

      return res.status(500).json({ error: "PIPELINE_ERROR" });

    }


    // 5) Finalnie: done
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


    return res.json({ ok: true, snapshot_id: snapshotIdStr });
  } catch (err) {
    // zawsze kończ taska, żeby nie wisiał
    try {
      if (pluginTask?.id) {
        const msg = String(err?.message || err).slice(0, 500);
        await setPluginTaskStatus(pg, pluginTask.id, "error", msg);

        // scanTaskId może istnieć (dodany wyżej)
        try {
          await finishScanTask(pg, scanTaskId, {
            status: "blad",
            blad_opis: `PLUGIN_RESULT_ERROR: ${msg}`.slice(0, 500),
            snapshot_mongo_id: null,
          });
        } catch {
          // ignore
        }
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
    if (!pluginTask) {
      return res.status(404).json({ error: "PLUGIN_TASK_NOT_FOUND" });
    }
  } catch (err) {
    pg.release();
    logger?.error?.("plugin_price_pg_resolve_error", { error: String(err?.message || err) });
    return res.status(500).json({ error: "PG_ERROR" });
  }

  try {
    const db = await ensureMongoDb();
    const snapshots = db.collection("snapshots");

    // znajdź NAJNOWSZY snapshot agenta (monitor_id + zadanie_id)
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
      // brak snapshotu – nie ma czego wzbogacać, ale task kończymy żeby nie wisiał
      await setPluginTaskStatus(pg, pluginTask.id, "done", "SNAPSHOT_NOT_FOUND");
      return res.json({ ok: true, snapshot_id: null });
    }

    const snapshotIdStr = snapshot._id.toString();

    // dopisz ceny
    const tUpd0 = performance.now();
    await snapshots.updateOne(
      { _id: snapshot._id },
      { $set: { plugin_prices: prices, plugin_price_enriched_at: new Date() } },
    );

    logger?.info?.("plugin_price_mongo_update_done", {
      snapshotId: snapshotIdStr,
      durationMs: Math.round(performance.now() - tUpd0),
    });

    // pipeline
    try {
      const tPipe0 = performance.now();
      await handleNewSnapshot(snapshotIdStr, { logger });
      logger?.info?.("plugin_price_pipeline_done", {
        snapshotId: snapshotIdStr,
        durationMs: Math.round(performance.now() - tPipe0),
      });
    } catch (err) {
      const errMsg = (err?.message || err).toString().slice(0, 300);
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

    return res.json({ ok: true });

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
    if (!pluginTask) {
      return res.status(404).json({ error: "PLUGIN_TASK_NOT_FOUND" });
    }
  } catch (err) {
    pg.release();
    logger?.error?.("plugin_screenshot_pg_resolve_error", { error: String(err?.message || err) });
    return res.status(500).json({ error: "PG_ERROR" });
  }

  try {
    const db = await ensureMongoDb();
    const snapshots = db.collection("snapshots");

    // znajdź NAJNOWSZY snapshot agenta (monitor_id + zadanie_id)
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

    let snapshotIdStr = null;
    const now = new Date();

    if (snapshot) {
      const tUpd0 = performance.now();
      await snapshots.updateOne(
        { _id: snapshot._id },
        {
          $set: {
            // to jest wynik pluginu, nie blokada
            mode: "plugin_screenshot",
            blocked: false,
            block_reason: null,

            screenshot_b64: normShot,
            screenshot_b64_len: screenshotLen,
            screenshot_sha1: screenshotSha1,

            plugin_screenshot_at: now,
            plugin_screenshot_source: "chrome_extension",
            plugin_screenshot_fullpage: true,

            final_url: url || snapshot.final_url || null,
          },
        },
      );
      snapshotIdStr = snapshot._id.toString();

      logger?.info?.("plugin_screenshot_mongo_update_done", {
        snapshotId: snapshotIdStr,
        durationMs: Math.round(performance.now() - tUpd0),
      });
    } else {
      // jeśli brak snapshotu (rzadkie) – tworzymy nowy
      const doc = {
        monitor_id: monitorId,
        zadanie_id: zadanieId,
        url: url || pluginTask.url || null,
        ts: now,

        mode: "plugin_screenshot",
        final_url: url || pluginTask.url || null,
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
      await handleNewSnapshot(snapshotIdStr, { logger });
      logger?.info?.("plugin_screenshot_pipeline_done", {
        snapshotId: snapshotIdStr,
        durationMs: Math.round(performance.now() - tPipe0),
      });
    } catch (err) {
      const errMsg = (err?.message || err).toString().slice(0, 300);
      await setPluginTaskStatus(pg, pluginTask.id, "error", `PIPELINE_ERROR: ${errMsg}`);

      await finishScanTask(pg, zadanieId, {
        status: "blad",
        blad_opis: `PIPELINE_ERROR: ${errMsg}`.slice(0, 500),
        snapshot_mongo_id: snapshotIdStr,
      });

      logger?.error?.("plugin_screenshot_pipeline_error", {
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

