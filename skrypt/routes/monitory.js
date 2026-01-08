import express from 'express';
import { verifyJwt } from '../jwt.js';

const router = express.Router();
router.use(verifyJwt);

const ALLOWED_TRYB = new Set(['static', 'screenshot']);

/**
 * Normalizacja trybu skanu z requestu.
 * Obsługuje:
 * - tryb_skanu: 'static' | 'screenshot' (docelowo)
 * - type: 'static' | 'screenshot' (fallback)
 * - type: 'html' -> 'static' (fallback dla starego frontu)
 */
function normalizeTrybSkanu(body) {
  const raw =
    body?.tryb_skanu ??
    body?.scan_mode ??
    body?.type;

  if (!raw) return null;

  const v = String(raw).trim().toLowerCase();
  if (v === 'html') return 'static';
  if (ALLOWED_TRYB.has(v)) return v;

  return null;
}

router.get('/', async (req, res) => {
  const userId = req.user.id;
  const { q, status } = req.query;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  try {
    const conditions = ['uzytkownik_id = $1'];
    const params = [userId];
    let index = 2;

    if (q) {
      conditions.push(`(nazwa ILIKE $${index} OR url ILIKE $${index})`);
      params.push(`%${q}%`);
      index += 1;
    }
    if (status) {
      if (status === 'active') conditions.push('aktywny = true');
      if (status === 'paused') conditions.push('aktywny = false');
      if (status === 'error') conditions.push('aktywny = true');
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const listSql = `
      SELECT
        id,
        nazwa AS name,
        url,
        interwal_sec AS interval_seconds,
        tryb_skanu AS type,
        CASE WHEN aktywny THEN 'active' ELSE 'paused' END AS status,
        utworzono_at AS last_check_at
      FROM monitory
      ${where}
      ORDER BY utworzono_at DESC
      LIMIT $${index}::int OFFSET $${index + 1}::int
    `;
    const { rows } = await req.pg.query(listSql, [...params, limit, offset]);

    const countSql = `SELECT COUNT(*)::int AS total FROM monitory ${where}`;
    const { rows: countRows } = await req.pg.query(countSql, params);

    res.json({ items: rows, total: countRows[0].total, page, pageSize: limit });
  } catch (err) {
    console.error('Błąd GET /monitory:', err);
    res.status(500).json({ message: 'Błąd serwera przy pobieraniu sond.' });
  }
});

/**
 * Szczegóły pojedynczego monitora (potrzebne do prefilla w modalu Edytuj).
 */
router.get('/:id', async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const { rows } = await req.pg.query(
      `
      SELECT
        id,
        nazwa AS name,
        url,
        llm_prompt AS prompt,
        interwal_sec AS interval_seconds,
        tryb_skanu AS type,
        CASE WHEN aktywny THEN 'active' ELSE 'paused' END AS status,
        utworzono_at
      FROM monitory
      WHERE id = $1 AND uzytkownik_id = $2
      LIMIT 1
      `,
      [id, userId],
    );

    if (rows.length === 0) return res.status(404).json({ message: 'Nie znaleziono sondy.' });

    res.json(rows[0]);
  } catch (err) {
    console.error('Błąd GET /monitory/:id:', err);
    res.status(500).json({ message: 'Błąd serwera przy pobieraniu sondy.' });
  }
});

router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { name, url, interval_seconds, prompt } = req.body;

  if (!name || !url || !interval_seconds) {
    return res.status(400).json({ message: 'Brak wymaganych pól.' });
  }

  const tryb_skanu = normalizeTrybSkanu(req.body) || 'static';

  try {
    const { rows } = await req.pg.query(
      `
      INSERT INTO monitory (uzytkownik_id, nazwa, url, llm_prompt, interwal_sec, aktywny, tryb_skanu)
      VALUES ($1, $2, $3, $4, $5, true, $6)
      RETURNING
        id,
        nazwa AS name,
        url,
        llm_prompt AS prompt,
        interwal_sec AS interval_seconds,
        tryb_skanu AS type,
        aktywny AS active
      `,
      [userId, name, url, prompt || null, interval_seconds, tryb_skanu],
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Błąd POST /monitory:', err);
    res.status(500).json({ message: 'Nie udało się dodać sondy.' });
  }
});

router.patch('/:id', async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  // 1) toggle (Uruchom/Wstrzymaj) - kompatybilność z Twoim obecnym UI
  if (req.body && req.body.toggle === true) {
    try {
      const { rows } = await req.pg.query(
        `
        UPDATE monitory
           SET aktywny = NOT aktywny
         WHERE id = $1 AND uzytkownik_id = $2
         RETURNING id, nazwa AS name, aktywny AS active
        `,
        [id, userId],
      );

      if (rows.length === 0) return res.status(404).json({ message: 'Nie znaleziono sondy.' });

      return res.json({
        message: 'Zmieniono status sondy.',
        item: rows[0],
      });
    } catch (err) {
      console.error('Błąd PATCH /monitory/:id (toggle):', err);
      return res.status(500).json({ message: 'Nie udało się zmienić statusu.' });
    }
  }

  // 2) edycja pól (Zatwierdź w modalu)
  const { name, url, interval_seconds, prompt } = req.body || {};
  const tryb_skanu = normalizeTrybSkanu(req.body);

  if (!name || !url || !interval_seconds) {
    return res.status(400).json({ message: 'Brak wymaganych pól (name, url, interval_seconds).' });
  }
  if (!tryb_skanu) {
    return res.status(400).json({ message: 'Brak lub niepoprawny tryb_skanu (static/screenshot).' });
  }

  try {
    const { rows } = await req.pg.query(
      `
      UPDATE monitory
         SET nazwa = $3,
             url = $4,
             llm_prompt = $5,
             interwal_sec = $6,
             tryb_skanu = $7
       WHERE id = $1 AND uzytkownik_id = $2
       RETURNING
         id,
         nazwa AS name,
         url,
         llm_prompt AS prompt,
         interwal_sec AS interval_seconds,
         tryb_skanu AS type,
         CASE WHEN aktywny THEN 'active' ELSE 'paused' END AS status
      `,
      [id, userId, name, url, prompt || null, interval_seconds, tryb_skanu],
    );

    if (rows.length === 0) return res.status(404).json({ message: 'Nie znaleziono sondy.' });

    res.json({ message: 'Zapisano zmiany.', item: rows[0] });
  } catch (err) {
    console.error('Błąd PATCH /monitory/:id (edit):', err);
    res.status(500).json({ message: 'Nie udało się zapisać zmian.' });
  }
});

router.delete('/:id', async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    await req.pg.query('BEGIN');
    // wykrycia nie mają ON DELETE CASCADE w Twoim schemacie -> usuń je ręcznie
    await req.pg.query(
      'DELETE FROM wykrycia WHERE monitor_id = $1 AND EXISTS (SELECT 1 FROM monitory m WHERE m.id = $1 AND m.uzytkownik_id = $2)',
      [id, userId],
    );

    const result = await req.pg.query(
      'DELETE FROM monitory WHERE id = $1 AND uzytkownik_id = $2',
      [id, userId],
    );

    if (result.rowCount === 0) { await req.pg.query('ROLLBACK'); return res.status(404).json({ message: 'Nie znaleziono sondy.' }); }

    await req.pg.query('COMMIT');

    res.json({ message: 'Usunięto sondę.' });
  } catch (err) {
    try { await req.pg.query('ROLLBACK'); } catch {}
    console.error('Błąd DELETE /monitory:', err);
    res.status(500).json({ message: 'Nie udało się usunąć sondy.' });
  }
});

export default router;

