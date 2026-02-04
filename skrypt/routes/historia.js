import express from 'express';
import { ObjectId } from 'mongodb';
import { verifyJwt } from '../jwt.js';

const router = express.Router();
router.use(verifyJwt);

// helpers
function isValidObjectId(id) {
  return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
}

function safeStringId(v) {
  if (v == null) return null;
  try { return String(v); } catch { return null; }
}

function normalizeMongoDoc(doc) {
  if (!doc) return null;
  // nie mutuj oryginału z drivera
  const out = { ...doc };
  if (out._id) out._id = safeStringId(out._id);
  return out;
}

async function ensureTaskAccess(req, taskId) {
  const userId = req.user.id;

  const { rows } = await req.pg.query(
    `
    SELECT
      z.id,
      z.monitor_id,
      m.nazwa AS monitor_name,
      m.url AS monitor_url,
      z.status,
      z.blad_opis,
      z.zaplanowano_at,
      z.rozpoczecie_at,
      z.zakonczenie_at,
      z.snapshot_mongo_id,
      z.analiza_mongo_id
    FROM zadania_skanu z
    JOIN monitory m ON m.id = z.monitor_id
    WHERE z.id = $1 AND m.uzytkownik_id = $2
    LIMIT 1
    `,
    [taskId, userId],
  );

  return rows[0] || null;
}

function buildMeta(row) {
  const start = row.rozpoczecie_at ? new Date(row.rozpoczecie_at) : null;
  const end = row.zakonczenie_at ? new Date(row.zakonczenie_at) : null;
  const durationSeconds =
    start && end ? Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000)) : null;

  return {
    id: row.id,
    monitor_id: row.monitor_id,
    monitor_name: row.monitor_name,
    monitor_url: row.monitor_url,
    status: row.status,
    blad_opis: row.blad_opis ?? null,
    zaplanowano_at: row.zaplanowano_at ?? null,
    rozpoczecie_at: row.rozpoczecie_at ?? null,
    zakonczenie_at: row.zakonczenie_at ?? null,
    duration_seconds: durationSeconds,
    snapshot_mongo_id: row.snapshot_mongo_id ?? null,
    analiza_mongo_id: row.analiza_mongo_id ?? null,
  };
}

async function fetchSnapshot(mongo, taskRow) {
  if (!mongo) return null;

  // NOWA kolekcja: snapshots (u Ciebie nie ma już migawki)
  const col = mongo.collection('snapshots');

  // UWAGA: screenshot_b64 potrafi być gigantyczne (base64) — nie wysyłamy tego do frontu / downloadów.
  const projection = { screenshot_b64: 0 };

  // 1) prefer: snapshots.zadanieId = uuid (string)
  let doc = await col.findOne({ zadanieId: taskRow.id }, { projection });

  // 2) fallback: snapshots._id = snapshot_mongo_id (ObjectId)
  if (!doc && taskRow.snapshot_mongo_id && isValidObjectId(taskRow.snapshot_mongo_id)) {
    doc = await col.findOne({ _id: new ObjectId(taskRow.snapshot_mongo_id) }, { projection });
  }

  return normalizeMongoDoc(doc);
}

async function fetchAnaliza(mongo, taskRow) {
  if (!mongo) return null;
  const analizy = mongo.collection('analizy');

  // 1) analizy.zadanieId = uuid
  let doc = await analizy.findOne({ zadanieId: taskRow.id });

  // 2) fallback: analizy._id = analiza_mongo_id (ObjectId)
  if (!doc && taskRow.analiza_mongo_id && isValidObjectId(taskRow.analiza_mongo_id)) {
    doc = await analizy.findOne({ _id: new ObjectId(taskRow.analiza_mongo_id) });
  }

  return normalizeMongoDoc(doc);
}

async function fetchOcena(mongo, taskRow) {
  if (!mongo) return null;
  const oceny = mongo.collection('oceny_zmian');

  // 1) oceny_zmian.zadanieId = uuid
  let doc = await oceny.findOne({ zadanieId: taskRow.id });

  // 2) fallback: oceny_zmian._id = analiza_mongo_id (czasem tam to było)
  if (!doc && taskRow.analiza_mongo_id && isValidObjectId(taskRow.analiza_mongo_id)) {
    doc = await oceny.findOne({ _id: new ObjectId(taskRow.analiza_mongo_id) });
  }

  return normalizeMongoDoc(doc);
}

function detailsToText(details) {
  // czytelny .txt do pobrania
  return [
    'TRACKLY — Szczegóły wykonania',
    '============================',
    '',
    'META:',
    JSON.stringify(details.meta, null, 2),
    '',
    'SNAPSHOT (Mongo: snapshots):',
    details.snapshot ? JSON.stringify(details.snapshot, null, 2) : 'Brak dokumentu.',
    '',
    'ANALIZA (Mongo: analizy):',
    details.analiza ? JSON.stringify(details.analiza, null, 2) : 'Brak dokumentu.',
    '',
    'OCENA ZMIAN (Mongo: oceny_zmian):',
    details.ocena ? JSON.stringify(details.ocena, null, 2) : 'Brak dokumentu.',
    '',
  ].join('\n');
}

/**
 * LISTA historii (zakończone: ok/blad/anulowane)
 * GET /api/historia?page&limit&q&status&from&to&monitorId
 */
router.get('/', async (req, res) => {
  const userId = req.user.id;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const { q, status, from, to, monitorId } = req.query;

  try {
    const conditions = [
      'm.uzytkownik_id = $1',
      "z.status IN ('ok','blad','anulowane')",
      'z.zakonczenie_at IS NOT NULL',
    ];
    const params = [userId];
    let idx = 2;

    if (q) {
      conditions.push(`(m.nazwa ILIKE $${idx} OR m.url ILIKE $${idx})`);
      params.push(`%${q}%`);
      idx += 1;
    }

    if (status) {
      conditions.push(`z.status = $${idx}`);
      params.push(status);
      idx += 1;
    }

    if (monitorId) {
      conditions.push(`z.monitor_id = $${idx}`);
      params.push(monitorId);
      idx += 1;
    }

    if (from) {
      conditions.push(`z.rozpoczecie_at >= $${idx}`);
      params.push(new Date(from));
      idx += 1;
    }

    if (to) {
      conditions.push(`z.zakonczenie_at <= $${idx}`);
      params.push(new Date(to));
      idx += 1;
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const listSql = `
      SELECT
        z.id,
        z.monitor_id,
        m.nazwa AS monitor_name,
        m.url   AS monitor_url,
        z.status,
        z.rozpoczecie_at,
        z.zakonczenie_at,
        EXTRACT(EPOCH FROM (z.zakonczenie_at - z.rozpoczecie_at))::int AS duration_seconds
      FROM zadania_skanu z
      JOIN monitory m ON m.id = z.monitor_id
      ${where}
      ORDER BY z.zakonczenie_at DESC
      LIMIT $${idx}::int OFFSET $${idx + 1}::int
    `;

    const { rows } = await req.pg.query(listSql, [...params, limit, offset]);

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM zadania_skanu z
      JOIN monitory m ON m.id = z.monitor_id
      ${where}
    `;
    const { rows: countRows } = await req.pg.query(countSql, params);

    res.json({
      items: rows,
      total: countRows[0]?.total ?? 0,
      page,
      pageSize: limit,
    });
  } catch (err) {
    console.error('Błąd GET /api/historia:', err);
    res.status(500).json({ message: 'Nie udało się pobrać historii.' });
  }
});

/**
 * SZCZEGÓŁY (JEDEN JSON): meta + snapshots + analizy + oceny_zmian
 * GET /api/historia/:id/details
 */
router.get('/:id', async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const { rows } = await req.pg.query(
      `
      SELECT
        z.id,
        m.nazwa AS monitor_name,
        z.status,
        z.tresc_hash,
        z.rozpoczecie_at,
        z.zakonczenie_at,
        z.snapshot_mongo_id,
        z.analiza_mongo_id
      FROM zadania_skanu z
      JOIN monitory m ON m.id = z.monitor_id
      WHERE z.id = $1
        AND m.uzytkownik_id = $2
      LIMIT 1
      `,
      [id, userId]
    );

    if (!rows.length) return res.status(404).json({ message: 'Nie znaleziono wykonania.' });

    // (opcjonalnie) duration_seconds:
    const row = rows[0];
    const s = row.rozpoczecie_at ? new Date(row.rozpoczecie_at).getTime() : null;
    const e = row.zakonczenie_at ? new Date(row.zakonczenie_at).getTime() : null;
    row.duration_seconds = (s && e) ? Math.max(0, Math.floor((e - s) / 1000)) : null;

    res.json(row);
  } catch (err) {
    console.error('Błąd GET /api/historia/:id', err);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});
 

router.get('/:id/details', async (req, res) => {
  const { id } = req.params;

  try {
    const row = await ensureTaskAccess(req, id);
    if (!row) return res.status(404).json({ message: 'Nie znaleziono wykonania.' });

    const mongo = req.mongo;
    if (!mongo) return res.status(500).json({ message: 'Brak połączenia z MongoDB.' });

    const [snapshot, analiza, ocena] = await Promise.all([
      fetchSnapshot(mongo, row),
      fetchAnaliza(mongo, row),
      fetchOcena(mongo, row),
    ]);

    res.json({
      meta: buildMeta(row),
      snapshot,
      analiza,
      ocena,
    });
  } catch (err) {
    console.error('Błąd GET /api/historia/:id/details:', err);
    res.status(500).json({ message: 'Nie udało się pobrać szczegółów.' });
  }
});

/**
 * Pobranie TXT z tym co jest w Mongo (bez "logów" z plików)
 * GET /api/historia/:id/download
 */
router.get('/:id/download', async (req, res) => {
  const { id } = req.params;

  try {
    const row = await ensureTaskAccess(req, id);
    if (!row) return res.status(404).send('Nie znaleziono wykonania.');

    const mongo = req.mongo;
    if (!mongo) return res.status(500).send('Brak połączenia z MongoDB.');

    const [snapshot, analiza, ocena] = await Promise.all([
      fetchSnapshot(mongo, row),
      fetchAnaliza(mongo, row),
      fetchOcena(mongo, row),
    ]);

    const details = {
      meta: buildMeta(row),
      snapshot,
      analiza,
      ocena,
    };

    const txt = detailsToText(details);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trackly_${id}.txt"`);
    res.send(txt);
  } catch (err) {
    console.error('Błąd GET /api/historia/:id/download:', err);
    res.status(500).send('Nie udało się wygenerować pliku.');
  }
});

/**
 * (Kompatybilność) Migawka
 * GET /api/historia/:id/migawka
 */
router.get('/:id/migawka', async (req, res) => {
  const { id } = req.params;

  try {
    const row = await ensureTaskAccess(req, id);
    if (!row) return res.status(404).json({ message: 'Nie znaleziono wykonania.' });

    const mongo = req.mongo;
    if (!mongo) return res.status(500).json({ message: 'Brak połączenia z MongoDB.' });

    const doc = await fetchSnapshot(mongo, row);
    if (!doc) return res.status(404).json({ message: 'Brak snapshotu.' });

    res.json(doc);
  } catch (err) {
    console.error('Błąd GET /api/historia/:id/migawka:', err);
    res.status(500).json({ message: 'Nie udało się pobrać snapshotu.' });
  }
});

/**
 * (Kompatybilność) Analiza + ocena (zwracamy obie, jeśli są)
 * GET /api/historia/:id/analiza
 */
router.get('/:id/analiza', async (req, res) => {
  const { id } = req.params;

  try {
    const row = await ensureTaskAccess(req, id);
    if (!row) return res.status(404).json({ message: 'Nie znaleziono wykonania.' });

    const mongo = req.mongo;
    if (!mongo) return res.status(500).json({ message: 'Brak połączenia z MongoDB.' });

    const [analiza, ocena] = await Promise.all([
      fetchAnaliza(mongo, row),
      fetchOcena(mongo, row),
    ]);

    if (!analiza && !ocena) {
      return res.status(404).json({ message: 'Brak analizy i oceny.' });
    }

    res.json({ analiza, ocena });
  } catch (err) {
    console.error('Błąd GET /api/historia/:id/analiza:', err);
    res.status(500).json({ message: 'Nie udało się pobrać analizy.' });
  }
});

/**
 * (Kompatybilność) LOG — NIE plikowy.
 * Zwraca to samo co /download, żeby frontend nie dostawał 404.
 * GET /api/historia/:id/log
 */
router.get('/:id/log', async (req, res) => {
  const { id } = req.params;

  try {
    const row = await ensureTaskAccess(req, id);
    if (!row) return res.status(404).send('Nie znaleziono wykonania.');

    const mongo = req.mongo;
    if (!mongo) return res.status(500).send('Brak połączenia z MongoDB.');

    const [snapshot, analiza, ocena] = await Promise.all([
      fetchSnapshot(mongo, row),
      fetchAnaliza(mongo, row),
      fetchOcena(mongo, row),
    ]);

    const details = {
      meta: buildMeta(row),
      snapshot,
      analiza,
      ocena,
    };

    const txt = detailsToText(details);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(txt);
  } catch (err) {
    console.error('Błąd GET /api/historia/:id/log:', err);
    res.status(500).send('Nie udało się pobrać danych.');
  }
});

export default router;

