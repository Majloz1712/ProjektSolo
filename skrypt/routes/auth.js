import express from 'express';
import bcrypt from 'bcryptjs';

import { signJwt } from '../jwt.js';

const router = express.Router();

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

router.post('/register', async (req, res) => {
  const { fullname, email, password, password2, terms } = req.body || {};

  if (!fullname || fullname.trim().length < 2) return res.status(400).json({ ok: false, msg: 'Podaj imię i nazwisko.' });
  if (!isEmail(email)) return res.status(400).json({ ok: false, msg: 'Podaj poprawny e-mail.' });
  if (!password || password.length < 8) return res.status(400).json({ ok: false, msg: 'Hasło musi mieć min. 8 znaków.' });
  if (password !== password2) return res.status(400).json({ ok: false, msg: 'Hasła nie są takie same.' });
  if (!terms) return res.status(400).json({ ok: false, msg: 'Musisz zaakceptować regulamin.' });

  try {
    const emailNorm = email.toLowerCase().trim();

    const { rows: existing } = await req.pg.query(
      'SELECT id FROM public.uzytkownicy WHERE email = $1',
      [emailNorm],
    );
    if (existing.length) return res.status(409).json({ ok: false, msg: 'E-mail jest już zajęty.' });

    const hash = await bcrypt.hash(password, 10);

    const { rows } = await req.pg.query(
      `INSERT INTO public.uzytkownicy (pelna_nazwa, email, haslo_hash)
       VALUES ($1, $2, $3)
       RETURNING id, pelna_nazwa, email, utworzono_at`,
      [fullname.trim(), emailNorm, hash],
    );

    const user = rows[0];
    const token = signJwt({ id: user.id, email: user.email });

    return res.status(201).json({
      ok: true,
      token,
      user: {
        id: user.id,
        fullname: user.pelna_nazwa,
        email: user.email,
        createdAt: user.utworzono_at,
      },
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ ok: false, msg: 'E-mail jest już zajęty.' });
    console.error('Register error:', err);
    return res.status(500).json({ ok: false, msg: 'Błąd serwera.' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ ok: false, msg: 'Podaj poprawny e-mail.' });
  if (!password) return res.status(400).json({ ok: false, msg: 'Podaj hasło.' });

  try {
    const emailNorm = email.toLowerCase().trim();

    const { rows } = await req.pg.query(
      `SELECT id, pelna_nazwa, email, haslo_hash, utworzono_at
         FROM public.uzytkownicy
        WHERE email = $1`,
      [emailNorm],
    );
    if (!rows.length) return res.status(401).json({ ok: false, msg: 'Nieprawidłowy e-mail lub hasło.' });

    const user = rows[0];

    const ok = await bcrypt.compare(password, user.haslo_hash);
    if (!ok) return res.status(401).json({ ok: false, msg: 'Nieprawidłowy e-mail lub hasło.' });

    const token = signJwt({ id: user.id, email: user.email });

    return res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        fullname: user.pelna_nazwa,
        email: user.email,
        createdAt: user.utworzono_at,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ ok: false, msg: 'Błąd serwera.' });
  }
});

export default router;
