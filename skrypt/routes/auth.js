import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

import { signJwt } from '../jwt.js';

const router = express.Router();

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ===== MAILER (SMTP) =====
function createMailTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  // Jeśli chcesz port 465 -> ustaw SMTP_SECURE=true
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

function getBaseUrl(req) {
  // publiczny adres apki (np. https://trackly.pl) - w dev może być localhost
  return (process.env.APP_BASE_URL || '').trim() || `${req.protocol}://${req.get('host')}`;
}

function buildResetUrl(req, token) {
  const base = getBaseUrl(req);
  return `${base}/resetHasla.html?token=${encodeURIComponent(token)}`;
}

async function sendPasswordResetEmail({ to, resetUrl }) {
  const transporter = createMailTransporter();
  if (!transporter) throw new Error('Brak konfiguracji SMTP w .env (SMTP_HOST/SMTP_USER/SMTP_PASS).');

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!from) throw new Error('Brak SMTP_FROM/SMTP_USER w .env');

  const subject = 'Reset hasła – Trackly';

  const text = `
Cześć!

Otrzymaliśmy prośbę o reset hasła do Trackly.

Kliknij w link, aby ustawić nowe hasło:
${resetUrl}

Link jest ważny przez 60 minut.

Jeśli to nie Ty — zignoruj tę wiadomość.

Pozdrawiam,
Trackly
`.trim();

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
  });
}

// ====================== REGISTER ======================
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

// ====================== LOGIN ======================
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

// ====================== PASSWORD RESET: REQUEST ======================
// Zwraca 200 nawet gdy email nie istnieje (anty-enumeracja).
router.post('/password-reset/request', async (req, res) => {
  const { email } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ ok: false, msg: 'Podaj poprawny e-mail.' });

  const emailNorm = email.toLowerCase().trim();

  try {
    const { rows } = await req.pg.query(
      `SELECT id, email FROM public.uzytkownicy WHERE email = $1`,
      [emailNorm],
    );

    // Zawsze udajemy "ok" (żeby nie dało się sprawdzać czy email istnieje)
    if (!rows.length) {
      await new Promise((r) => setTimeout(r, 150));
      return res.json({ ok: true, msg: 'Jeśli konto istnieje, wyślemy link resetujący.' });
    }

    const userId = rows[0].id;

    // token raw -> user dostaje, w DB trzymamy hash
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);

    // ważność 60 minut
    const insertRes = await req.pg.query(
      `
      INSERT INTO public.password_resets (user_id, token_hash, expires_at)
      VALUES ($1, $2, now() + interval '60 minutes')
      RETURNING id
      `,
      [userId, tokenHash],
    );

    const resetId = insertRes.rows?.[0]?.id;
    const resetUrl = buildResetUrl(req, token);

    try {
      await sendPasswordResetEmail({ to: emailNorm, resetUrl });
    } catch (mailErr) {
      // jeśli mail nie poszedł — usuń token, żeby nie zostawały "martwe" wpisy
      if (resetId) {
        await req.pg.query(`DELETE FROM public.password_resets WHERE id = $1`, [resetId]);
      }
      console.error('Password reset email error:', mailErr);
      return res.status(500).json({ ok: false, msg: 'Nie udało się wysłać maila resetującego.' });
    }

    return res.json({ ok: true, msg: 'Jeśli konto istnieje, wyślemy link resetujący.' });
  } catch (err) {
    console.error('Password reset request error:', err);
    return res.status(500).json({ ok: false, msg: 'Błąd serwera.' });
  }
});

// ====================== PASSWORD RESET: CONFIRM ======================
router.post('/password-reset/confirm', async (req, res) => {
  const { token, password, password2 } = req.body || {};

  if (!token || typeof token !== 'string' || token.length < 10) {
    return res.status(400).json({ ok: false, msg: 'Brak tokenu resetu.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ ok: false, msg: 'Hasło musi mieć min. 8 znaków.' });
  }
  if (password !== password2) {
    return res.status(400).json({ ok: false, msg: 'Hasła nie są takie same.' });
  }

  const tokenHash = sha256(token);

  try {
    // 1) sprawdź token
    const { rows } = await req.pg.query(
      `
      SELECT pr.id AS reset_id, pr.user_id
        FROM public.password_resets pr
       WHERE pr.token_hash = $1
         AND pr.used_at IS NULL
         AND pr.expires_at > now()
       LIMIT 1
      `,
      [tokenHash],
    );

    if (!rows.length) {
      return res.status(400).json({ ok: false, msg: 'Token nieprawidłowy lub wygasł.' });
    }

    const resetId = rows[0].reset_id;
    const userId = rows[0].user_id;

    const newHash = await bcrypt.hash(password, 10);

    await req.pg.query('BEGIN');

    await req.pg.query(
      `UPDATE public.uzytkownicy
          SET haslo_hash = $1
        WHERE id = $2`,
      [newHash, userId],
    );

    await req.pg.query(
      `UPDATE public.password_resets
          SET used_at = now()
        WHERE id = $1`,
      [resetId],
    );

    // unieważnij inne tokeny usera
    await req.pg.query(
      `UPDATE public.password_resets
          SET used_at = now()
        WHERE user_id = $1
          AND used_at IS NULL
          AND expires_at > now()`,
      [userId],
    );

    await req.pg.query('COMMIT');

    return res.json({ ok: true, msg: 'Hasło zostało zmienione.' });
  } catch (err) {
    try { await req.pg.query('ROLLBACK'); } catch {}
    console.error('Password reset confirm error:', err);
    return res.status(500).json({ ok: false, msg: 'Błąd serwera.' });
  }
});

export default router;

