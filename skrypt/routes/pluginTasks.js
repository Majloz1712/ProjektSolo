// routes/pluginTasks.js
import express from 'express';
import { pool } from '../polaczeniePG.js';
import { mongoClient } from '../polaczenieMDB.js';

const router = express.Router();

async function ensureMongoDb() {
  if (!mongoClient.topology || !mongoClient.topology.isConnected?.()) {
    await mongoClient.connect();
  }
  const dbName = process.env.MONGO_DB || 'monitor';
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
       LIMIT 1`
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
  const { monitor_id: monitorId, screenshot_b64: screenshotB64, url } = req.body || {};

  if (!monitorId || !screenshotB64) {
    return res.status(400).json({ error: 'MISSING_FIELDS' });
  }

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

    const doc = {
      monitor_id: monitorId,
      url: url || null,
      ts: new Date(),
      mode: 'plugin',
      final_url: url || null,
      html: null,
      meta: null,
      hash: null,
      blocked: false,
      block_reason: null,
      screenshot_b64: screenshotB64,
      extracted_v2: null,
    };

    const { insertedId } = await snapshots.insertOne(doc);

    return res.json({ ok: true, snapshot_id: insertedId?.toString() ?? null });
  } catch (err) {
    console.error('[plugin-tasks] /:id/result mongo error', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// POST /api/plugin-tasks/:id/price  (price_only z DOM)
router.post('/:id/price', async (req, res) => {
  const { id } = req.params;
  const { monitor_id: monitorId, url, prices } = req.body || {};

  if (!monitorId || !Array.isArray(prices) || !prices.length) {
    console.warn('[plugin-tasks] /:id/price missing fields', {
      monitorId,
      hasPrices: !!prices,
    });
    return res.status(400).json({ error: 'MISSING_FIELDS' });
  }

  // 1) oznacz zadanie jako zakończone w PG
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
    console.error('[plugin-tasks] /:id/price PG update error', err);
  } finally {
    client.release();
  }

  try {
    const db = await ensureMongoDb();
    const snapshots = db.collection('snapshots');

    // 2) bierzemy najnowszy snapshot po monitor_id
    const snapshot = await snapshots
      .find({ monitor_id: monitorId })
      .sort({ ts: -1 })
      .limit(1)
      .next();

    if (!snapshot) {
      console.warn(
        '[plugin-tasks] /:id/price snapshot not found for monitor_id=',
        monitorId,
        'url=',
        url,
      );
      return res.json({ ok: true, snapshot_id: null });
    }

    // 3) zapisujemy CAŁĄ tablicę wyników z pluginu w jednym polu
    const update = {
      plugin_prices: prices,               // <--- JEDNO pole z wszystkimi cenami
      plugin_price_enriched_at: new Date()
    };

    await snapshots.updateOne(
      { _id: snapshot._id },
      { $set: update },
    );

    console.log(
      '[plugin-tasks] /:id/price saved plugin_prices for snapshot',
      snapshot._id.toString(),
      'count=',
      prices.length,
    );

    return res.json({ ok: true, snapshot_id: snapshot._id.toString() });
  } catch (err) {
    console.error('[plugin-tasks] /:id/price mongo error', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;

