import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ALL_PERMISSIONS, parsePermissions } from './permissions.js';
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

export const PUBLIC_USER_FIELDS = 'u.id, u.name, u.email, u.role, u.location_id, u.position, u.hourly_rate, u.active, u.permission_set_id, u.all_sites, u.rota_group';

// Joins a user's permission set, or the built-in set for their role when they don't have one.
export const ACCESS_JOIN = `LEFT JOIN permission_sets ps ON ps.id = u.permission_set_id
  LEFT JOIN permission_sets dps ON u.permission_set_id IS NULL AND dps.built_in = u.role`;
// Someone given their own permissions (ticked one by one) uses those instead of their set's.
export const ACCESS_FIELDS = `CASE WHEN u.role = 'admin' THEN 'Admin' WHEN u.custom_permissions IS NOT NULL THEN COALESCE(ps.name, dps.name) || ' (own permissions)'
    ELSE COALESCE(ps.name, dps.name) END AS access_name,
  COALESCE(ps.id, dps.id) AS access_set_id, u.custom_permissions IS NOT NULL AS custom_access,
  COALESCE(u.custom_permissions, ps.permissions, dps.permissions) AS permissions_json`;

/** Adds a user's permissions (every permission for admins) and removes the raw JSON column. */
export function withPermissions(u) {
  if (!u) return u;
  const { permissions_json: json, ...rest } = u;
  return { ...rest, custom_access: !!rest.custom_access && u.role !== 'admin', permissions: u.role === 'admin' ? [...ALL_PERMISSIONS] : parsePermissions(json) };
}

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
    SELECT ${PUBLIC_USER_FIELDS}, ${ACCESS_FIELDS} FROM sessions s JOIN users u ON u.id = s.user_id ${ACCESS_JOIN}
    WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`);
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = token ? withPermissions(stmt.get(token)) ?? null : null;
    if (req.user) req.user.site_ids = siteIdsFor(db, req.user);
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

export const requireAdmin = requireRole('admin');

/** Whether the user has a permission. Admins have every permission. */
export const can = (user, permission) => !!user && (user.role === 'admin' || user.permissions?.includes(permission));

/** Allows the request if the user has any of the permissions. */
export const requirePerm = (...permissions) => (req, _res, next) =>
  (permissions.some((p) => can(req.user, p)) ? next() : next(forbidden()));

/**
 * The sites someone can work with: every site for admins and people with all-site access (the default),
 * otherwise their home site plus the sites they've been given.
 */
export function siteIdsFor(db, user) {
  if (user.role === 'admin' || user.all_sites) return db.prepare('SELECT id FROM locations ORDER BY name').all().map((l) => l.id);
  const ids = db.prepare(`SELECT location_id AS id FROM user_sites WHERE user_id = ?`).all(user.id).map((r) => r.id);
  if (user.location_id && !ids.includes(user.location_id)) ids.unshift(user.location_id);
  return ids;
}

export function assertLocation(req, locationId) {
  const loc = req.db.prepare('SELECT id FROM locations WHERE id = ?').get(locationId);
  if (!loc) throw notFound('Location');
  if (!req.user.site_ids.includes(locationId)) throw forbidden('You do not have access to this location');
}

// Location from the request, defaulting to the user's home site (or the first site they can access).
export function resolveLocation(req, raw) {
  const home = req.user.site_ids.includes(req.user.location_id) ? req.user.location_id : req.user.site_ids[0];
  const locationId = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : home;
  if (!Number.isInteger(locationId) || locationId < 1) throw badRequest('location_id is required');
  assertLocation(req, locationId);
  return locationId;
}

/**
 * The active sites a report covers: the one asked for, or with no location_id every active site the user can
 * access. Returns [{ id, name, square_location_id }].
 */
export function reportLocations(req, raw) {
  const db = req.db;
  if (raw !== undefined && raw !== null && raw !== '') {
    return [db.prepare('SELECT id, name, square_location_id FROM locations WHERE id = ?').get(resolveLocation(req, raw))];
  }
  const ids = new Set(req.user.site_ids);
  const rows = db.prepare('SELECT id, name, square_location_id FROM locations WHERE active = 1 ORDER BY name').all().filter((l) => ids.has(l.id));
  if (!rows.length) throw forbidden('You do not have access to any sites');
  return rows;
}

// Failed sign-ins are limited per address and per email, so passwords can't be guessed by trying many.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = { ip: 20, email: 10 };
const loginFails = new Map();

function recentFails(key, now) {
  const list = (loginFails.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (list.length) loginFails.set(key, list);
  else loginFails.delete(key);
  return list;
}

function checkLoginLimit(keys, now) {
  for (const [key, max] of keys) {
    const list = recentFails(key, now);
    if (list.length >= max) {
      const minutes = Math.ceil((LOGIN_WINDOW_MS - (now - list[0])) / 60000);
      throw new HttpError(429, `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
  }
}

/** Signs someone in on this device (a cookie lasting 30 days) and returns them as the app sees them. */
export function startSession(db, req, res, userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .run(token, userId, `+${SESSION_DAYS} days`);
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(userId);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
    path: '/',
  });
  return withPermissions(db.prepare(`SELECT ${PUBLIC_USER_FIELDS}, ${ACCESS_FIELDS} FROM users u ${ACCESS_JOIN} WHERE u.id = ?`).get(userId));
}

export function registerAuthRoutes(router, db) {
  router.post('/auth/login', (req, res) => {
    const email = str(req.body?.email, 'email', { required: true });
    const password = str(req.body?.password, 'password', { required: true });
    const now = Date.now();
    const keys = [[`ip:${req.ip}`, MAX_FAILS.ip], [`email:${email.toLowerCase()}`, MAX_FAILS.email]];
    checkLoginLimit(keys, now);
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      for (const [key] of keys) loginFails.set(key, [...recentFails(key, now), now]);
      throw new HttpError(401, 'Incorrect email or password');
    }
    loginFails.delete(keys[1][0]);
    res.json({ user: startSession(db, req, res, user.id) });
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
