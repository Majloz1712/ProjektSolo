const express = require("express");
const router = express.Router();
const { verifyJwt } = require("../jwt");

// 🔐 Middleware – wymaga JWT
router.use(verifyJwt);

// 📋 Pobierz listę sond użytkownika
router.get("/", async (req, res) => {
  const userId = req.user.id;
  const { q, status } = req.query;

  // BEZPIECZNE liczby
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  try {
    const conds = ["uzytkownik_id = $1"];
    const params = [userId];
    let i = 2;

    if (q) { conds.push(`(nazwa ILIKE $${i} OR url ILIKE $${i})`); params.push(`%${q}%`); i++; }
    if (status) {
      if (status === "active") conds.push("aktywny = true");
      if (status === "paused") conds.push("aktywny = false");
      if (status === "error")  conds.push("aktywny = true"); // placeholder
    }
    const where = `WHERE ${conds.join(" AND ")}`;

    const listSql = `
      SELECT 
        id,
        nazwa AS name,
        url,
        interwal_sec AS interval_seconds,
        CASE WHEN aktywny THEN 'active' ELSE 'paused' END AS status,
        utworzono_at AS last_check_at
      FROM monitory
      ${where}
      ORDER BY utworzono_at DESC
      LIMIT $${i}::int OFFSET $${i+1}::int
    `;
    const { rows } = await req.pg.query(listSql, [...params, limit, offset]);

    const countSql = `SELECT COUNT(*)::int AS total FROM monitory ${where}`;
    const { rows: cnt } = await req.pg.query(countSql, params);

    res.json({ items: rows, total: cnt[0].total, page, pageSize: limit });
  } catch (err) {
    console.error("Błąd GET /monitory:", err);
    res.status(500).json({ message: "Błąd serwera przy pobieraniu sond." });
  }
});


// ➕ Dodaj sondę
router.post("/", async (req, res) => {
  const userId = req.user.id;
  const { name, url, interval_seconds, prompt } = req.body;

  if (!name || !url || !interval_seconds)
    return res.status(400).json({ message: "Brak wymaganych pól." });

  try {
    const { rows } = await req.pg.query(
      `
      INSERT INTO monitory (uzytkownik_id, nazwa, url, llm_prompt, interwal_sec, aktywny)
      VALUES ($1, $2, $3, $4, $5, true)
      RETURNING id, nazwa AS name, url, interwal_sec AS interval_seconds, aktywny AS active
      `,
      [userId, name, url, prompt || null, interval_seconds]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Błąd POST /monitory:", err);
    res.status(500).json({ message: "Nie udało się dodać sondy." });
  }
});

// 🔄 Zmień status (toggle)
router.patch("/:id", async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const { rows } = await req.pg.query(
      `
      UPDATE monitory
      SET aktywny = NOT aktywny
      WHERE id = $1 AND uzytkownik_id = $2
      RETURNING id, nazwa AS name, aktywny AS active
      `,
      [id, userId]
    );

    if (rows.length === 0)
      return res.status(404).json({ message: "Nie znaleziono sondy." });

    res.json({
      message: "Zmieniono status sondy.",
      item: rows[0],
    });
  } catch (err) {
    console.error("Błąd PATCH /monitory:", err);
    res.status(500).json({ message: "Nie udało się zmienić statusu." });
  }
});

// ❌ Usuń sondę
router.delete("/:id", async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const r = await req.pg.query(
      `DELETE FROM monitory WHERE id = $1 AND uzytkownik_id = $2`,
      [id, userId]
    );

    if (r.rowCount === 0)
      return res.status(404).json({ message: "Nie znaleziono sondy." });

    res.json({ message: "Usunięto sondę." });
  } catch (err) {
    console.error("Błąd DELETE /monitory:", err);
    res.status(500).json({ message: "Nie udało się usunąć sondy." });
  }
});

module.exports = router;

