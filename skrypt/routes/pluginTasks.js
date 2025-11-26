// routes/pluginTasks.js
import express from 'express';
import { pool } from '../polaczeniePG.js';
import { mongoClient } from '../polaczenieMDB.js';
import { fetchAndExtract } from '../../orchestrator/extractOrchestrator.js';
import { handleNewSnapshot } from '../llm/pipelineZmian.js';

const router = express.Router();

async function ensureMongoDb() {
  if (!mongoClient.topology || !mongoClient.topology.isConnected?.()) {
    await mongoClient.connect();
  }
  const dbName = process.env.MONGO_DB || 'inzynierka';
  return mongoClient.db(dbName);
}

// GET /api/plugin-tasks/next
router.get('/next', async (req, res) => {
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
      return res.status(204).send(); // brak zadań
    }

    const task = rows[0];

    await client.query(
      `UPDATE plugin_tasks
         SET status = 'in_progress',
             zaktualizowane_at = NOW()
       WHERE id = $1`,
      [task.id],
    );

    return res.json({
      task_id: task.id,
      monitor_id: task.monitor_id,
      zadanie_id: task.zadanie_id,
      url: task.url,
      mode: task.mode || 'fallback',
    });
  } catch (err) {
    console.error('[plugin-tasks] /next error', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

// POST /api/plugin-tasks/:id/result  (screenshot z pluginu)
router.post('/:id/result', async (req, res) => {
  const { id } = req.params;
  const {
    monitor_id: monitorId,
    screenshot_b64: screenshotB64,
    url,
    html,
    text,
  } = req.body || {};

  const hasScreenshot =
    typeof screenshotB64 === 'string' && screenshotB64.length > 0;
  const hasDom =
    (typeof html === 'string' && html.length > 0) ||
    (typeof text === 'string' && text.length > 0);

  if (!monitorId || (!hasScreenshot && !hasDom)) {
    return res.status(400).json({ error: 'MISSING_FIELDS' });
  }

  // 1) oznacz task jako done w PG
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE plugin_tasks
         SET status = 'done',
             zaktualizowane_at = NOW()
       WHERE id = $1`,
      [id],
    );
  } catch (err) {
    console.error('[plugin-tasks] /:id/result PG update error', err);
  } finally {
    client.release();
  }

  try {
    const db = await ensureMongoDb();
    const snapshots = db.collection('snapshots');

    const now = new Date();

    // 2) jeśli mamy DOM – przepuść przez extractory
    let extracted = null;
    if (hasDom) {
      try {
        const htmlForExtractors =
          typeof html === 'string' && html.length > 0
            ? html
            : `<html><body>${text}</body></html>`;

        extracted = await fetchAndExtract(url || '', {
          render: false,
          correlationId: `plugin-${id}`,
          html: htmlForExtractors,
        });
      } catch (err) {
        console.warn('[plugin-tasks] /:id/result extractors failed', err);
      }
    }

    // 3) zbuduj dokument snapshotu (oddzielny, typ "plugin")
    const doc = {
      monitor_id: monitorId,
      url: url || null,
      ts: now,
      mode: 'plugin',
      final_url: url || null,
      blocked: false,
      block_reason: null,
      plugin_dom_text: hasDom ? text || null : null,
      plugin_dom_fetched_at: hasDom ? now : null,
      screenshot_b64: hasScreenshot ? screenshotB64 : null,
      extracted_v2: extracted || null,
    };

    const { insertedId } = await snapshots.insertOne(doc);
        
    try {
      await handleNewSnapshot(insertedId);
    } catch (err) {
      console.error('[plugin] LLM pipeline error (result mode):', err);
    }

    return res.json({
      ok: true,
      snapshot_id: insertedId?.toString() ?? null,
    });
  } catch (err) {
    console.error('[plugin-tasks] /:id/result mongo error', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /api/plugin-tasks/:id/price  (price_only z DOM)
// POST /api/plugin-tasks/:id/price  (price_only z DOM)
router.post('/:id/price', async (req, res) => {
  const { id } = req.params;
  const { url, prices } = req.body || {};

  console.log('[plugin-tasks] /:id/price RAW BODY =', req.body);

  if (!Array.isArray(prices) || !prices.length) {
    console.warn('[plugin-tasks] /:id/price missing prices', {
      hasPrices: !!prices,
    });
    return res.status(400).json({ error: 'MISSING_PRICES' });
  }

  // 1) wyciągamy monitor_id i zadanie_id z plugin_tasks po ID zadania
  const client = await pool.connect();
  let monitorId;
  let zadanieId;

  try {
    const { rows } = await client.query(
      `SELECT monitor_id, zadanie_id
         FROM plugin_tasks
        WHERE id = $1`,
      [id],
    );

    if (!rows.length) {
      console.warn('[plugin-tasks] /:id/price plugin_task NOT FOUND', { id });
      return res.status(404).json({ error: 'TASK_NOT_FOUND' });
    }

    monitorId = rows[0].monitor_id;
    zadanieId = rows[0].zadanie_id;

    console.log('[plugin-tasks] /:id/price TASK FROM DB =', {
      id,
      monitorId,
      zadanieId,
    });

    // 2) oznaczamy zadanie jako zakończone
    await client.query(
      `UPDATE plugin_tasks
         SET status = 'done',
             zaktualizowane_at = NOW()
       WHERE id = $1`,
      [id],
    );
  } catch (err) {
    console.error('[plugin-tasks] /:id/price PG error', err);
    return res.status(500).json({ error: 'PG_ERROR' });
  } finally {
    client.release();
  }

  try {
    const db = await ensureMongoDb();
    const snapshots = db.collection('snapshots');

    // 3) bierzemy snapshot po monitor_id + zadanie_id (TEN SAM co zrobił agent)
    const snapshot = await snapshots.findOne({
      monitor_id: monitorId,
      zadanie_id: zadanieId,
    });

    if (!snapshot) {
      console.warn(
        '[plugin-tasks] /:id/price snapshot NOT FOUND',
        { monitorId, zadanieId, url },
      );
      return res.json({ ok: true, snapshot_id: null });
    }

    console.log(
      '[plugin-tasks] /:id/price FOUND snapshot',
      snapshot._id.toString(),
      'for monitor_id=',
      monitorId,
      'zadanie_id=',
      zadanieId,
    );

    // 4) aktualizujemy snapshot o ceny z pluginu
    const update = {
      plugin_prices: prices,
      plugin_price_enriched_at: new Date(),
    };

    await snapshots.updateOne(
      { _id: snapshot._id },
      { $set: update },
    );

    const snapshotId = snapshot._id.toString();

    console.log(
      '[plugin-tasks] /:id/price saved plugin_prices for snapshot',
      snapshotId,
      'count=',
      prices.length,
    );

    // 5) odpalamy pipeline LLM (tu możesz mieć już swoją wersję handleNewSnapshot)
    try {
      console.log('[plugin] calling handleNewSnapshot for', snapshotId);
      await handleNewSnapshot(snapshotId, { forceAnalysis: true });
      console.log('[plugin] LLM pipeline finished for snapshot', snapshotId);
    } catch (err) {
      console.error('[plugin] LLM pipeline error:', err);
    }

    return res.json({ ok: true, snapshot_id: snapshotId });
  } catch (err) {
    console.error('[plugin-tasks] /:id/price mongo error', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});


export default router;

