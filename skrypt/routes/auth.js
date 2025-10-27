// skrypt/routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const { signJwt } = require("../jwt");
const router = express.Router();

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// POST /auth/register
router.post("/register", async (req, res) => {
  const { fullname, email, password, password2, terms } = req.body || {};

  if (!fullname || fullname.trim().length < 2)
    return res.status(400).json({ ok: false, msg: "Podaj imię i nazwisko." });
  if (!isEmail(email))
    return res.status(400).json({ ok: false, msg: "Podaj poprawny e-mail." });
  if (!password || password.length < 8)
    return res.status(400).json({ ok: false, msg: "Hasło musi mieć min. 8 znaków." });
  if (password !== password2)
    return res.status(400).json({ ok: false, msg: "Hasła nie są takie same." });
  if (!terms)
    return res.status(400).json({ ok: false, msg: "Musisz zaakceptować regulamin." });

  try {
    const emailNorm = email.toLowerCase().trim();

    const { rows: existing } = await req.pg.query(
      "SELECT id FROM public.uzytkownicy WHERE email = $1",
      [emailNorm]
    );
    if (existing.length)
      return res.status(409).json({ ok: false, msg: "E-mail jest już zajęty." });

    const hash = await bcrypt.hash(password, 10);

    const { rows } = await req.pg.query(
      `INSERT INTO public.uzytkownicy (pelna_nazwa, email, haslo_hash)
       VALUES ($1, $2, $3)
       RETURNING id, pelna_nazwa, email, utworzono_at`,
      [fullname.trim(), emailNorm, hash]
    );

    const u = rows[0];
    // ▶️ JWT
    const token = signJwt({ id: u.id, email: u.email });

    return res.status(201).json({
      ok: true,
      token,
      user: {
        id: u.id,
        fullname: u.pelna_nazwa,
        email: u.email,
        createdAt: u.utworzono_at,
      },
    });
  } catch (err) {
    if (err.code === "23505")
      return res.status(409).json({ ok: false, msg: "E-mail jest już zajęty." });
    console.error("Register error:", err);
    return res.status(500).json({ ok: false, msg: "Błąd serwera." });
  }
});

// POST /auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email))
    return res.status(400).json({ ok: false, msg: "Podaj poprawny e-mail." });
  if (!password)
    return res.status(400).json({ ok: false, msg: "Podaj hasło." });

  try {
    const emailNorm = email.toLowerCase().trim();

    const { rows } = await req.pg.query(
      `SELECT id, pelna_nazwa, email, haslo_hash, utworzono_at
       FROM public.uzytkownicy
       WHERE email = $1`,
      [emailNorm]
    );
    if (!rows.length)
      return res.status(401).json({ ok: false, msg: "Nieprawidłowy e-mail lub hasło." });

    const u = rows[0];

    const ok = await bcrypt.compare(password, u.haslo_hash);
    if (!ok)
      return res.status(401).json({ ok: false, msg: "Nieprawidłowy e-mail lub hasło." });

    // ▶️ JWT
    const token = signJwt({ id: u.id, email: u.email });

    return res.json({
      ok: true,
      token,
      user: {
        id: u.id,
        fullname: u.pelna_nazwa,
        email: u.email,
        createdAt: u.utworzono_at,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ ok: false, msg: "Błąd serwera." });
  }
});

module.exports = router;

