import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { HttpError, badRequest, forbidden, notFound, str } from './util.js';

const SESSION_DAYS = 30;
const COOKIE = 'sid';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

export function validatePassword(password) {
  const p = str(password, 'password', { required: true, max: 200 });
  if (p.length < 8) throw badRequest('password must be at least 8 characters');
  return p;
}

export const PUBLIC_USER_FIELDS = 'u.id, u.name, u.email, u.role, u.location_id, u.position, u.hourly_rate, u.active';

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function loadUser(db) {
  const stmt = db.prepare(`
    SELECT ${PUBLIC_USER_FIELDS} FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`);
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = token ? stmt.get(token) ?? null : null;
    req.sessionToken = req.user ? token : null;
    next();
  };
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  next();
}

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(forbidden());

export const requireManager = requireRole('admin', 'manager');
export const requireAdmin = requireRole('admin');

export const isManager = (user) => user.role === 'admin' || user.role === 'manager';

export function assertLocation(req, locationId) {
  const loc = req.db.prepare('SELECT id FROM locations WHERE id = ?').get(locationId);
  if (!loc) throw notFound('Location');
  if (req.user.role !== 'admin' && req.user.location_id !== locationId) {
    throw forbidden('You do not have access to this location');
  }
}

// Location from the request, defaulting to the user's own site.
export function resolveLocation(req, raw) {
  const locationId = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : req.user.location_id;
  if (!Number.isInteger(locationId) || locationId < 1) throw badRequest('location_id is required');
  assertLocation(req, locationId);
  return locationId;
}

export function registerAuthRoutes(router, db) {
  router.post('/auth/login', (req, res) => {
    const email = str(req.body?.email, 'email', { required: true });
    const password = str(req.body?.password, 'password', { required: true });
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'Incorrect email or password');
    }
    const token = randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
      .run(token, user.id, `+${SESSION_DAYS} days`);
    db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SESSION_DAYS * 24 * 3600 * 1000,
      path: '/',
    });
    res.json({ user: db.prepare(`SELECT ${PUBLIC_USER_FIELDS} FROM users u WHERE id = ?`).get(user.id) });
  });

  router.post('/auth/logout', (req, res) => {
    if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/auth/me', (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please sign in');
    res.json({ user: req.user });
  });

  router.post('/auth/password', (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please sign in');
    const current = str(req.body?.current_password, 'current_password', { required: true });
    const next = validatePassword(req.body?.new_password);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current, row.password_hash)) throw badRequest('Current password is incorrect');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
    res.json({ ok: true });
  });
}
