// routes/pluginTasks.js
// ZMIANA (krok 1 w pluginTasks.js):
// 1) Lepsze wyszukiwanie snapshota: zawsze bierz NAJNOWSZY (sort po ts desc), bo mogą istnieć duplikaty.
// 2) Meta dla screenshotów: zapisujemy screenshot_b64_len + screenshot_sha1 (debug + stabilniejsze porównania).
// 3) (Opcjonalnie) lokalny JSON limit dla tego routera – pomoże tylko jeśli ten router jest montowany PRZED globalnym express.json().
//    Jeśli masz globalne express.json() z małym limitem, musisz też zwiększyć limit tam.

import express from "express";
import crypto from "node:crypto";
import { pool } from "../polaczeniePG.js";
import { mongoClient } from "../polaczenieMDB.js";
import { fetchAndExtract } from "../../orchestrator/extractOrchestrator.js";
import { handleNewSnapshot } from "../llm/pipelineZmian.js";
import { createTaskLogger } from "../loggerZadan.js";
import { performance } from "node:perf_hooks";

const router = express.Router();

// UWAGA: zadziała tylko jeśli router jest montowany przed globalnym express.json(),
// inaczej request może być odrzucony wcześniej (413 Payload Too Large).
router.use(express.json({ limit: "50mb" }));

async function ensureMongoDb() {
  if (!mongoClient.topology || !mongoClient.topology.isConnected?.()) {
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

// GET /api/plugin-tasks/next
router.get("/next", async (req, res) => {
  const t0 = performance.now();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, monitor_id, zadanie_id, url, mode
       FROM plugin_tasks
       WHERE status = 'pending'
       ORDER BY utworzone_at
       LIMIT 1`,
    );

    if (!rows.length) {
      console.log("[plugin-tasks] next_empty", {
        durationMs: Math.round(performance.now() - t0),
      });
      return res.status(204).send();
    }
    const task = rows[0];

    await client.query(
      `UPDATE plugin_tasks
         SET status = 'in_progress',
             zaktualizowane_at = NOW()
       WHERE id = $1`,
      [task.id],
    );
    console.log("[plugin-tasks] next_done", {
      taskId: task.id,
      monitorId: task.monitor_id,
      durationMs: Math.round(performance.now() - t0),
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
    if (client) client.release();
  }
});

// POST /api/plugin-tasks/:id/result  (DOM lub screenshot fallback)
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

  const hasScreenshot =
    typeof screenshotB64 === "string" && screenshotB64.length > 0;
  const hasDom =
    (typeof html === "string" && html.length > 0) ||
    (typeof text === "string" && text.length > 0);

  if (!monitorId || (!hasScreenshot && !hasDom)) {
    return res.status(400).json({ error: "MISSING_FIELDS" });
  }

  // 1) oznacz task jako done w PG
  const tPg0 = performance.now();
  const client = await pool.connect();

  try {
    await client.query(
      `UPDATE plugin_tasks
       SET status = 'done',
           zaktualizowane_at = NOW()
     WHERE id = $1`,
      [id],
    );

    console.log("[plugin-tasks] result_pg_done", {
      id,
      durationMs: Math.round(performance.now() - tPg0),
    });
  } catch (err) {
    console.error("[plugin-tasks] /:id/result PG update error", err);
  } finally {
    if (client) client.release();
  }

  try {
    const db = await ensureMongoDb();
    const snapshots = db.collection("snapshots");

    const now = new Date();

    // 2) jeśli mamy DOM – przepuść przez extractory
    let extracted = null;
    if (hasDom) {
      try {
        const htmlForExtractors =
          typeof html === "string" && html.length > 0
            ? html
            : `<html><body>${text}</body></html>`;

        const tExtract0 = performance.now();
        extracted = await fetchAndExtract(url || "", {
          render: false,
          correlationId: `plugin-${id}`,
          html: htmlForExtractors,
        });
        console.log("[plugin-tasks] result_extract_done", {
          id,
          url,
          durationMs: Math.round(performance.now() - tExtract0),
          confidence: extracted?.confidence ?? null,
          extractor: extracted?.extractor ?? null,
        });
      } catch (err) {
        console.warn("[plugin-tasks] /:id/result extractors failed", err);
      }
    }

    // screenshot meta (hash + len)
    const normShot = hasScreenshot ? normalizeB64(screenshotB64) : null;
    const screenshotSha1 = normShot ? sha1(normShot) : null;
    const screenshotLen = normShot ? normShot.length : 0;

    // 3) Najpierw spróbuj zaktualizować istniejący snapshot (TEN SAM zadanie_id),
    //    a jeśli ich jest kilka, bierzemy NAJNOWSZY.
    let snapshotIdStr = null;
    const tMongo0 = performance.now();

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
      }
      if (hasScreenshot) {
        $set.screenshot_b64 = normShot;
        $set.screenshot_b64_len = screenshotLen;
        $set.screenshot_sha1 = screenshotSha1;
        $set.plugin_screenshot_at = now;
        $set.plugin_screenshot_source = "chrome_extension";
        $set.plugin_screenshot_fullpage = true; // po zmianie background.js robisz fullpage
      }
      if (extracted) {
        $set.extracted_v2 = extracted;
      }

      await snapshots.updateOne({ _id: existing._id }, { $set });
      snapshotIdStr = existing._id?.toString?.() ?? null;
      console.log("[plugin-tasks] result_mongo_update_done", {
        id,
        snapshotId: snapshotIdStr,
        durationMs: Math.round(performance.now() - tMongo0),
        hasDom,
        hasScreenshot,
        screenshotLen,
      });
    } else {
      const doc = {
        monitor_id: monitorId,
        zadanie_id: zadanieId || null,
        url: url || null,
        ts: now,
        mode: "plugin",
        final_url: url || null,
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
      console.log("[plugin-tasks] result_mongo_insert_done", {
        id,
        snapshotId: snapshotIdStr,
        durationMs: Math.round(performance.now() - tMongo0),
        hasDom,
        hasScreenshot,
        screenshotLen,
      });
    }

    try {
      const tPipe0 = performance.now();
      await handleNewSnapshot(snapshotIdStr, { logger: console });

      console.log("[plugin-tasks] result_pipeline_done", {
        id,
        snapshotId: snapshotIdStr,
        durationMs: Math.round(performance.now() - tPipe0),
      });
    } catch (err) {
      console.error("[plugin] LLM pipeline error (result mode):", err);
    }

    console.log("[plugin-tasks] result_done", {
      id,
      durationMs: Math.round(performance.now() - t0),
    });

    return res.json({
      ok: true,
      snapshot_id: snapshotIdStr,
    });
  } catch (err) {
    console.error("[plugin-tasks] /:id/result mongo error", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// POST /api/plugin-tasks/:id/price  (price_only z DOM)
router.post("/:id/price", async (req, res) => {
  const t0 = performance.now();
  const { id } = req.params;
  const { url, prices } = req.body || {};
  if (!prices || !Array.isArray(prices) || prices.length === 0) {
    return res.status(400).json({ error: "Brak prices w body" });
  }

  let client;
  let monitorId;
  let zadanieId;
  let logger;

  try {
    client = await pool.connect();
    const tPgSelect0 = performance.now();
    const { rows } = await client.query(
      "SELECT * FROM plugin_tasks  WHERE id = $1",
      [id],
    );

    if (!rows[0]) {
      console.log("[plugin-tasks] /:id/price brak plugin_tasks , id=", id);
      return res.status(404).json({ error: "plugin_tasks  not found" });
    }

    const row = rows[0];
    monitorId = row.monitor_id;
    zadanieId = row.zadanie_id;

    logger = await createTaskLogger({ monitorId, zadanieId });

    logger.info("plugin_price_pg_select_done", {
      pluginZadanieId: id,
      durationMs: Math.round(performance.now() - tPgSelect0),
    });

    logger.info("plugin_price_raw_body", {
      pluginZadanieId: id,
      url,
      pricesCount: Array.isArray(prices) ? prices.length : 0,
    });

    console.log("[plugin-tasks] /:id/price TASK FROM DB =", {
      id,
      monitorId,
      zadanieId,
    });

    const tPgUpdate0 = performance.now();
    await client.query(
      `UPDATE plugin_tasks
         SET status = 'done',
             zaktualizowane_at = NOW()
       WHERE id = $1`,
      [id],
    );
    logger?.info("plugin_price_pg_update_done", {
      pluginZadanieId: id,
      durationMs: Math.round(performance.now() - tPgUpdate0),
    });
  } catch (err) {
    if (logger) {
      logger.error("plugin_price_pg_error", {
        error: String(err?.message || err),
      });
    } else {
      console.error("[plugin-tasks] /:id/price PG error", err);
    }
    return res.status(500).json({ error: "PG_ERROR" });
  } finally {
    if (client) client.release();
  }

  try {
    const db = await ensureMongoDb();
    const snapshots = db.collection("snapshots");

    // 3) bierzemy NAJNOWSZY snapshot po monitor_id + zadanie_id
    const tFind0 = performance.now();
    const snapshot = await snapshots
      .find({ monitor_id: monitorId, zadanie_id: zadanieId })
      .sort({ ts: -1 })
      .limit(1)
      .next();

    logger?.info("plugin_price_mongo_find_done", {
      monitorId,
      zadanieId,
      found: !!snapshot,
      durationMs: Math.round(performance.now() - tFind0),
    });

    if (!snapshot) {
      logger?.warn?.("plugin_price_snapshot_not_found", {
        monitorId,
        zadanieId,
        url,
      });
      console.log("[plugin-tasks] result_done", {
        id,
        durationMs: Math.round(performance.now() - t0),
      });
      return res.json({ ok: true, snapshot_id: null });
    }

    const snapshotId = snapshot._id.toString();

    logger?.info("plugin_price_found_snapshot", {
      snapshotId,
      monitorId,
      zadanieId,
      url,
    });

    const update = {
      plugin_prices: prices,
      plugin_price_enriched_at: new Date(),
    };
    const tUpd0 = performance.now();
    await snapshots.updateOne({ _id: snapshot._id }, { $set: update });
    logger?.info("plugin_price_mongo_update_done", {
      snapshotId,
      durationMs: Math.round(performance.now() - tUpd0),
    });

    const tPipe0 = performance.now();
    await handleNewSnapshot(snapshotId, { logger });
    logger?.info("plugin_price_pipeline_done", {
      snapshotId,
      durationMs: Math.round(performance.now() - tPipe0),
    });

    logger?.info("plugin_price_saved", {
      snapshotId,
      monitorId,
      zadanieId,
      pricesCount: prices.length,
    });

    logger?.info("plugin_price_done", {
      pluginZadanieId: id,
      durationMs: Math.round(performance.now() - t0),
    });

    return res.json({ ok: true });
  } catch (err) {
    logger?.error?.("plugin_price_error", {
      error: String(err?.message || err),
      durationMs: Math.round(performance.now() - t0),
    });
    return res.status(500).json({ error: "internal error" });
  }
});

// POST /api/plugin-tasks/:id/screenshot  (plugin screenshot – tylko obraz)
router.post("/:id/screenshot", async (req, res) => {
  const t0 = performance.now();
  const { id } = req.params;
  const {
    monitor_id: monitorId,
    zadanie_id: zadanieId,
    url,
    screenshot_b64: screenshotB64,
  } = req.body || {};

  const hasScreenshot =
    typeof screenshotB64 === "string" && screenshotB64.length > 0;

  if (!monitorId || !zadanieId || !hasScreenshot) {
    return res.status(400).json({ error: "MISSING_FIELDS" });
  }

  const normShot = normalizeB64(screenshotB64);
  const screenshotSha1 = normShot ? sha1(normShot) : null;
  const screenshotLen = normShot ? normShot.length : 0;

  // 1) oznacz task jako done w PG
  let client;
  try {
    client = await pool.connect();
    await client.query(
      `UPDATE plugin_tasks
         SET status = 'done',
             zaktualizowane_at = NOW()
       WHERE id = $1`,
      [id],
    );
  } catch (err) {
    console.error("[plugin-tasks] /:id/screenshot PG update error", err);
  } finally {
    if (client) client.release();
  }

  let logger = console;
  try {
    logger = await createTaskLogger({ monitorId, zadanieId });
  } catch {
    // ignore
  }

  try {
    const db = await ensureMongoDb();
    const snapshots = db.collection("snapshots");

    // 2) znajdź NAJNOWSZY snapshot stworzony przez agenta (po monitor_id + zadanie_id)
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

    let snapshotIdStr;

    if (snapshot) {
      const tUpd0 = performance.now();
      await snapshots.updateOne(
        { _id: snapshot._id },
        {
          $set: {
            screenshot_b64: normShot,
            screenshot_b64_len: screenshotLen,
            screenshot_sha1: screenshotSha1,
            plugin_screenshot_at: new Date(),
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
      const doc = {
        monitor_id: monitorId,
        zadanie_id: zadanieId,
        url: url || null,
        ts: new Date(),
        mode: "plugin_screenshot",
        final_url: url || null,
        blocked: false,
        block_reason: null,
        screenshot_b64: normShot,
        screenshot_b64_len: screenshotLen,
        screenshot_sha1: screenshotSha1,
        plugin_screenshot_at: new Date(),
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

    // 3) odpal pipeline na snapshot
    const tPipe0 = performance.now();
    await handleNewSnapshot(snapshotIdStr, { logger });
    logger?.info?.("plugin_screenshot_pipeline_done", {
      snapshotId: snapshotIdStr,
      durationMs: Math.round(performance.now() - tPipe0),
    });

    logger?.info?.("plugin_screenshot_done", {
      pluginZadanieId: id,
      snapshotId: snapshotIdStr,
      durationMs: Math.round(performance.now() - t0),
    });

    return res.json({ ok: true, snapshot_id: snapshotIdStr });
  } catch (err) {
    console.error("[plugin-tasks] /:id/screenshot error", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

export default router;
