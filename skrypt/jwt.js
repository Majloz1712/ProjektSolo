import jwt from 'jsonwebtoken';

function requireSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set in environment variables');
  return secret;
}

export function signJwt(payload, opts = {}) {
  const expiresIn = opts.expiresIn || process.env.JWT_EXPIRES || '1h';
  return jwt.sign(payload, requireSecret(), { expiresIn });
}

export function verifyJwt(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    console.warn('[JWT] Missing/Bad Authorization header:', req.headers.authorization);
    return res.status(401).json({ ok: false, msg: 'Brak tokenu JWT' });
  }
  const token = auth.split(' ')[1];
  try {
    const payload = jwt.verify(token, requireSecret(), { clockTolerance: 30 });
    req.user = payload;
    return next();
  } catch (err) {
    console.warn('[JWT] verify error:', err?.name, err?.message);
    const msg = err?.name === 'TokenExpiredError' ? 'Token wygasł' : 'Nieprawidłowy token';
    return res.status(401).json({ ok: false, msg });
  }
}

export default { signJwt, verifyJwt };
