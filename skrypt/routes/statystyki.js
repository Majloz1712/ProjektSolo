import express from 'express';
import { verifyJwt } from '../jwt.js';

const router = express.Router();
router.use(verifyJwt);

async function getUserMonitors(req, userId){
  const { rows } = await req.pg.query('SELECT id, nazwa FROM monitory WHERE uzytkownik_id = $1', [userId]);
  const ids = rows.map(r => r.id);
  const names = new Map(rows.map(r => [r.id, r.nazwa]));
  return { ids, names };
}

router.get('/', async (req, res) => {
  const userId = req.user.id;

  try {
    const { ids: monitorIds, names: monitorNames } = await getUserMonitors(req, userId);

    // ====== Zadania skanu (PG) ======
    const { rows: scanCountRows } = await req.pg.query(
      `
      SELECT z.status, COUNT(*)::int AS count
        FROM zadania_skanu z
        JOIN monitory m ON m.id = z.monitor_id
       WHERE m.uzytkownik_id = $1
       GROUP BY z.status
      `,
      [userId],
    );

    const scan_by_status = {};
    for (const r of scanCountRows) scan_by_status[r.status] = r.count;
    const scan_total = scanCountRows.reduce((a, r) => a + Number(r.count || 0), 0);

    const { rows: scanInProgress } = await req.pg.query(
      `
      SELECT
        z.id,
        z.monitor_id,
        m.nazwa AS monitor_name,
        z.status,
        z.rozpoczecie_at,
        z.zakonczenie_at,
        EXTRACT(EPOCH FROM (NOW() - z.rozpoczecie_at))::int AS duration_seconds
      FROM zadania_skanu z
      JOIN monitory m ON m.id = z.monitor_id
      WHERE m.uzytkownik_id = $1
        AND z.status = 'w_trakcie'
      ORDER BY z.rozpoczecie_at ASC
      LIMIT 200
      `,
      [userId],
    );

    // ====== Plugin tasks (PG) ======
    // statusy w Twojej tabeli: pending / running / done / error (+ ewentualnie cancelled)
    const { rows: plugCountRows } = await req.pg.query(
      `
      SELECT p.status, COUNT(*)::int AS count
        FROM plugin_tasks p
        JOIN monitory m ON m.id = p.monitor_id
       WHERE m.uzytkownik_id = $1
       GROUP BY p.status
      `,
      [userId],
    );
    const plugin_by_status = {};
    for (const r of plugCountRows) plugin_by_status[r.status] = r.count;

    const { rows: pluginInProgress } = await req.pg.query(
      `
      SELECT
        p.id,
        p.monitor_id,
        m.nazwa AS monitor_name,
        p.status,
        p.utworzone_at,
        p.zaktualizowane_at,
        EXTRACT(EPOCH FROM (NOW() - p.utworzone_at))::int AS duration_seconds
      FROM plugin_tasks p
      JOIN monitory m ON m.id = p.monitor_id
      WHERE m.uzytkownik_id = $1
        AND p.status IN ('pending','running')
      ORDER BY p.utworzone_at ASC
      LIMIT 200
      `,
      [userId],
    );

    // Dodatkowo: ostatnie wykonania pluginu, żeby coś było w tabeli nawet gdy nic nie "running"
    const { rows: pluginRecent } = await req.pg.query(
      `
      SELECT
        p.id,
        p.monitor_id,
        m.nazwa AS monitor_name,
        p.status,
        p.utworzone_at,
        p.zaktualizowane_at
      FROM plugin_tasks p
      JOIN monitory m ON m.id = p.monitor_id
      WHERE m.uzytkownik_id = $1
      ORDER BY p.utworzone_at DESC
      LIMIT 50
      `,
      [userId],
    );

    // ====== Analizy ======
    // Linked w PG (analiza_mongo_id != null)
    const { rows: linkedRows } = await req.pg.query(
      `
      SELECT COUNT(*)::int AS linked
      FROM zadania_skanu z
      JOIN monitory m ON m.id = z.monitor_id
      WHERE m.uzytkownik_id = $1
        AND z.analiza_mongo_id IS NOT NULL
      `,
      [userId],
    );
    const analyses_linked = linkedRows?.[0]?.linked ?? 0;

    // Total w Mongo (jeśli jest) — działa też dla starszych analiz, o ile mają monitorId
    let analyses_total = analyses_linked;
    if (req.mongo && monitorIds.length) {
      try {
        const col = req.mongo.collection('analizy');
        analyses_total = await col.countDocuments({ monitorId: { $in: monitorIds.map(String) } });
      } catch {
        // ignore
      }
    }

    res.json({
      generated_at: new Date().toISOString(),
      monitors_total: monitorIds.length,
      analyses: { total: analyses_total, linked: analyses_linked },
      scan_tasks: {
        total: scan_total,
        by_status: scan_by_status,
        in_progress_count: scanInProgress.length,
        in_progress: scanInProgress,
      },
      plugin_tasks: {
        by_status: plugin_by_status,
        in_progress_count: pluginInProgress.length,
        in_progress: pluginInProgress,
        recent: pluginRecent,
      },
    });
  } catch (err) {
    console.error('Błąd GET /api/statystyki:', err);
    res.status(500).json({ message: 'Nie udało się pobrać statystyk.' });
  }
});

// ====== STOP: zadanie skanu (PG) ======
router.post('/zadania/:id/stop', async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const r = await req.pg.query(
      `
      UPDATE zadania_skanu z
         SET status = 'anulowane',
             zakonczenie_at = COALESCE(zakonczenie_at, NOW()),
             blad_opis = COALESCE(blad_opis, 'Anulowane przez użytkownika')
      FROM monitory m
      WHERE z.monitor_id = m.id
        AND m.uzytkownik_id = $1
        AND z.id = $2
        AND z.status = 'w_trakcie'
      RETURNING z.id, z.status, z.zakonczenie_at
      `,
      [userId, id],
    );

    if (r.rowCount === 0) return res.status(404).json({ message: 'Nie znaleziono zadania w trakcie.' });
    res.json({ message: 'Zatrzymano zadanie.', item: r.rows[0] });
  } catch (err) {
    console.error('Błąd stop zadania:', err);
    res.status(500).json({ message: 'Nie udało się zatrzymać zadania.' });
  }
});

router.post('/zadania/stop-all', async (req, res) => {
  const userId = req.user.id;

  try {
    const r = await req.pg.query(
      `
      UPDATE zadania_skanu z
         SET status = 'anulowane',
             zakonczenie_at = COALESCE(zakonczenie_at, NOW()),
             blad_opis = COALESCE(blad_opis, 'Anulowane przez użytkownika')
      FROM monitory m
      WHERE z.monitor_id = m.id
        AND m.uzytkownik_id = $1
        AND z.status = 'w_trakcie'
      RETURNING z.id
      `,
      [userId],
    );
    res.json({ message: 'Zatrzymano zadania skanu.', stopped: r.rowCount });
  } catch (err) {
    console.error('Błąd stop-all zadania:', err);
    res.status(500).json({ message: 'Nie udało się zatrzymać listy zadań.' });
  }
});

// ====== STOP: plugin task (PG) ======
router.post('/plugin-tasks/:id/stop', async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const r = await req.pg.query(
      `
      UPDATE plugin_tasks p
         SET status = 'cancelled',
             blad_opis = COALESCE(blad_opis, 'Anulowane przez użytkownika'),
             zaktualizowane_at = NOW()
      FROM monitory m
      WHERE p.monitor_id = m.id
        AND m.uzytkownik_id = $1
        AND p.id = $2
        AND p.status IN ('pending','running')
      RETURNING p.id, p.status, p.zaktualizowane_at
      `,
      [userId, id],
    );

    if (r.rowCount === 0) return res.status(404).json({ message: 'Nie znaleziono plugin taska w trakcie.' });
    res.json({ message: 'Zatrzymano plugin task.', item: r.rows[0] });
  } catch (err) {
    console.error('Błąd stop plugin:', err);
    res.status(500).json({ message: 'Nie udało się zatrzymać plugin taska.' });
  }
});

router.post('/plugin-tasks/stop-all', async (req, res) => {
  const userId = req.user.id;

  try {
    const r = await req.pg.query(
      `
      UPDATE plugin_tasks p
         SET status = 'cancelled',
             blad_opis = COALESCE(blad_opis, 'Anulowane przez użytkownika'),
             zaktualizowane_at = NOW()
      FROM monitory m
      WHERE p.monitor_id = m.id
        AND m.uzytkownik_id = $1
        AND p.status IN ('pending','running')
      RETURNING p.id
      `,
      [userId],
    );

    res.json({ message: 'Zatrzymano plugin tasks.', stopped: r.rowCount });
  } catch (err) {
    console.error('Błąd stop-all plugin:', err);
    res.status(500).json({ message: 'Nie udało się zatrzymać listy plugin tasks.' });
  }
});

export default router;
