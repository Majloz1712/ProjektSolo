// skrypt/routes/monitory.js
const express = require('express');
const { verifyJwt } = require('../jwt');
const router = express.Router();

function isValidUrl(value) {
  try { const u = new URL(value); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

// Każda trasa poniżej wymaga JWT
// PRZYKŁADOWY handler GET /api/monitory
router.use(verifyJwt);
router.get('/', async (req, res) => {
  try {
    // 1) Autoryzowany użytkownik
    const authUserId = req.user?.id;
    if (!authUserId) {
      return res.status(401).json({ ok:false, message:'Brak user.id w tokenie.' });
    }

    // 2) Filtry i paginacja
    const q       = (req.query.q || '').trim();
    const status  = (req.query.status || '').trim(); // 'active' | 'paused' | 'error' | ''
    const page    = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit   = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset  = (page - 1) * limit;

    // 3) WHERE i parametry
    const where = ['uzytkownik_id = $1'];
    const params = [authUserId];

    if (q) {
      params.push(`%${q}%`);
      where.push(`(name ILIKE $${params.length} OR url ILIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // 4) Licznik
    const countSql = `SELECT COUNT(*)::int AS cnt FROM monitory ${whereSql}`;
    const { rows: cntRows } = await req.pg.query(countSql, params);
    const total = cntRows[0]?.cnt ?? 0;

    // 5) Dane
    params.push(limit);
    params.push(offset);
    const dataSql = `
      SELECT id, name, url, interval_seconds, status, last_check_at
      FROM monitory
      ${whereSql}
      ORDER BY id DESC
      LIMIT $${params.length-1} OFFSET $${params.length}
    `;
    const { rows } = await req.pg.query(dataSql, params);

    return res.json({ ok:true, items: rows, total, page, pageSize: limit });
  } catch (err) {
    console.error('GET /api/monitory error:', err);
    return res.status(500).json({
      ok:false,
      message:'Nie udało się pobrać listy.',
      // w dev możesz ujawnić więcej:
      detail: process.env.NODE_ENV === 'production' ? undefined : String(err)
    });
  }
});


router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const uid = req.user?.id;
    const r = await req.pg.query('DELETE FROM monitory WHERE id = $1 AND user_id = $2 RETURNING id', [id, uid]);
    if (!r.rowCount) return res.status(404).json({ ok: false, message: 'Nie znaleziono.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/monitory/:id error:', err);
    res.status(500).json({ ok: false, message: 'Nie udało się usunąć.' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const uid = req.user?.id;

    if (req.body?.toggle) {
      const cur = await req.pg.query('SELECT status FROM monitory WHERE id = $1 AND user_id = $2', [id, uid]);
      if (!cur.rowCount) return res.status(404).json({ ok: false, message: 'Nie znaleziono.' });
      const next = cur.rows[0].status === 'paused' ? 'active' : 'paused';
      const upd = await req.pg.query(
        'UPDATE monitory SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING id, status',
        [next, id, uid]
      );
      return res.json({ ok: true, monitor: upd.rows[0] });
    }

    res.status(400).json({ ok: false, message: 'Brak wspieranej operacji.' });
  } catch (err) {
    console.error('PATCH /api/monitory/:id error:', err);
    res.status(500).json({ ok: false, message: 'Nie udało się zaktualizować.' });
  }
});
















// POST /api/monitory
router.post('/', async (req, res) => {
  try {
    const pg = req.pg;
    const userId = req.user.id; // ← z JWT

    const { name, url, interval_seconds, prompt } = req.body || {};
    if (!name || String(name).trim().length < 2)
      return res.status(400).json({ ok: false, message: 'Podaj nazwę sondy.' });
    if (!isValidUrl(url))
      return res.status(400).json({ ok: false, message: 'Podaj poprawny URL (http/https).' });

    const interwal = Number(interval_seconds);
    if (!interwal || interwal < 1 || !Number.isFinite(interwal))
      return res.status(400).json({ ok: false, message: 'Częstotliwość musi być liczbą dodatnią (sekundy).' });

    const { rows } = await pg.query(
      `INSERT INTO public.monitory
         (uzytkownik_id, nazwa, url, llm_prompt, interwal_sec)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, uzytkownik_id, nazwa, url, llm_prompt, interwal_sec, aktywny, utworzono_at`,
      [userId, String(name).trim(), String(url).trim(), (prompt?.trim() || null), interwal]
    );

    return res.status(201).json({ ok: true, monitor: rows[0] });
  } catch (err) {
    if (err?.code === '23503') {
      return res.status(400).json({ ok: false, message: 'Nieprawidłowy uzytkownik_id (FK).' });
    }
    console.error('Add monitor error:', err);
    return res.status(500).json({ ok: false, message: 'Nie udało się dodać sondy.' });
  }
});

module.exports = router;

