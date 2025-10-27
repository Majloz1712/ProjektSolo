// skrypt/jwt.js
const jwt = require('jsonwebtoken');

function requireSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set in environment variables');
  return s;
}

function signJwt(payload, opts = {}) {
  const expiresIn = opts.expiresIn || process.env.JWT_EXPIRES || '1h';
  return jwt.sign(payload, requireSecret(), { expiresIn });
}

function verifyJwt(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    console.warn('[JWT] Missing/Bad Authorization header:', req.headers.authorization);
    return res.status(401).json({ ok:false, msg:'Brak tokenu JWT' });
  }
  const token = auth.split(' ')[1];
  try {
    const payload = jwt.verify(token, requireSecret(), { clockTolerance: 30 });
    req.user = payload;
    return next();
  } catch (err) {
    console.warn('[JWT] verify error:', err?.name, err?.message);
    const msg = err?.name === 'TokenExpiredError' ? 'Token wygasł' : 'Nieprawidłowy token';
    return res.status(401).json({ ok:false, msg });
  }
}

module.exports = { signJwt, verifyJwt };

