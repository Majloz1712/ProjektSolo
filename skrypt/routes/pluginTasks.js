// routes/pluginTasks.js
import express from "express";
import { pool } from "../polaczeniePG.js";
import { mongoClient } from "../polaczenieMDB.js";
import { fetchAndExtract } from "../../orchestrator/extractOrchestrator.js";
import { handleNewSnapshot } from "../llm/pipelineZmian.js";
import { createTaskLogger } from "../loggerZadan.js";
import { performance } from "node:perf_hooks";

const router = express.Router();

async function ensureMongoDb() {
  if (!mongoClient.topology || !mongoClient.topology.isConnected?.()) {
    await mongoClient.connect();
  }
  const dbName = process.env.MONGO_DB || "inzynierka";
  return mongoClient.db(dbName);
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

// POST /api/plugin-tasks/:id/result  (screenshot z pluginu)
router.post("/:id/result", async (req, res) => {
  const t0 = performance.now();
  const { id } = req.params;
  const {
    monitor_id: monitorId,
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

    // 3) zbuduj dokument snapshotu (oddzielny, typ "plugin")
    const doc = {
      monitor_id: monitorId,
      url: url || null,
      ts: now,
      mode: "plugin",
      final_url: url || null,
      blocked: false,
      block_reason: null,
      plugin_dom_text: hasDom ? text || null : null,
      plugin_dom_fetched_at: hasDom ? now : null,
      screenshot_b64: hasScreenshot ? screenshotB64 : null,
      extracted_v2: extracted || null,
    };
    const tMongo0 = performance.now();
    const { insertedId } = await snapshots.insertOne(doc);
    console.log("[plugin-tasks] result_mongo_insert_done", {
      id,
      snapshotId: insertedId?.toString?.() ?? null,
      durationMs: Math.round(performance.now() - tMongo0),
    });

    try {
      const tPipe0 = performance.now();
      await handleNewSnapshot(insertedId, { logger: console });

      console.log("[plugin-tasks] result_pipeline_done", {
        id,
        snapshotId: insertedId?.toString?.() ?? null,
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
      snapshot_id: insertedId?.toString() ?? null,
    });
  } catch (err) {
    console.error("[plugin-tasks] /:id/result mongo error", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// POST /api/plugin-tasks/:id/price  (price_only z DOM)
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

    // >>> tutaj tworzymy logger dla tego zadania
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

    // 2) oznaczamy zadanie jako zakończone
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

    // 3) bierzemy snapshot po monitor_id + zadanie_id (TEN SAM co zrobił agent)
    const tFind0 = performance.now();
    const snapshot = await snapshots.findOne({
      monitor_id: monitorId,
      zadanie_id: zadanieId,
    });
    logger?.info("plugin_price_mongo_find_done", {
      monitorId,
      zadanieId,
      found: !!snapshot,
      durationMs: Math.round(performance.now() - tFind0),
    });

    if (!snapshot) {
      if (logger) {
        logger.warn("plugin_price_snapshot_not_found", {
          monitorId,
          zadanieId,
          url,
        });
      } else {
        console.warn("[plugin-tasks] /:id/price snapshot NOT FOUND", {
          monitorId,
          zadanieId,
          url,
        });
      }
      console.log("[plugin-tasks] result_done", {
        id,
        durationMs: Math.round(performance.now() - t0),
      });
      return res.json({ ok: true, snapshot_id: null });
    }

    // log znalezionego snapshota
    const snapshotId = snapshot._id.toString();

    if (logger) {
      logger.info("plugin_price_found_snapshot", {
        snapshotId,
        monitorId,
        zadanieId,
        url,
      });
    } else {
      console.log(
        "[plugin-tasks] /:id/price FOUND snapshot",
        snapshotId,
        "for monitor_id=",
        monitorId,
        "zadanie_id=",
        zadanieId,
      );
    }

    // 4) aktualizujemy snapshot o ceny z pluginu
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

    // 5) odpalamy pipeline zmian Z TYM snapshotem i loggerem
    const tPipe0 = performance.now();
    await handleNewSnapshot(snapshotId, { logger });
    logger?.info("plugin_price_pipeline_done", {
      snapshotId,
      durationMs: Math.round(performance.now() - tPipe0),
    });

    if (logger) {
      logger.info("plugin_price_saved", {
        snapshotId,
        monitorId,
        zadanieId,
        pricesCount: prices.length,
      });
    } else {
      console.log(
        "[plugin-tasks] /:id/price saved plugin_prices for snapshot",
        snapshotId,
        "count=",
        prices.length,
      );
    }
    logger?.info("plugin_price_done", {
      pluginZadanieId: id,
      durationMs: Math.round(performance.now() - t0),
    });

    return res.json({ ok: true });
  } catch (err) {
    if (logger) {
      logger.error("plugin_price_error", {
        error: String(err?.message || err),
        durationMs: Math.round(performance.now() - t0),
      });
    } else {
      console.error("[plugin-tasks] /:id/price error:", err);
    }
    return res.status(500).json({ error: "internal error" });
  }
});

export default router;
