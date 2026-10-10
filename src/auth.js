import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ALL_PERMISSIONS, parsePermissions } from './permissions.js';
import { HttpError, badRequest, forbidden, notFound, str } from './util.js';
import { logActivity } from './activity.js';

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

export const PUBLIC_USER_FIELDS = 'u.id, u.name, u.email, u.role, u.location_id, u.position, u.hourly_rate, u.active, u.permission_set_id, u.all_sites, u.rota_group, u.paid_breaks, u.tour_done_at';

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
    SELECT ${PUBLIC_USER_FIELDS}, ${ACCESS_FIELDS}, s.view_as_user_id FROM sessions s JOIN users u ON u.id = s.user_id ${ACCESS_JOIN}
    WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`);
  const byId = db.prepare(`SELECT ${PUBLIC_USER_FIELDS}, ${ACCESS_FIELDS} FROM users u ${ACCESS_JOIN} WHERE u.id = ? AND u.active = 1`);
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const row = token ? stmt.get(token) : null;
    req.user = null;
    req.realUser = null;
    if (row) {
      const { view_as_user_id: viewAs, ...me } = row;
      const self = withPermissions(me);
      // An admin viewing as someone: the app sees that person (with their access); changes are blocked below.
      const other = viewAs && self.role === 'admin' ? withPermissions(byId.get(viewAs)) : null;
      if (other && other.id !== self.id) {
        req.realUser = { ...self, site_ids: siteIdsFor(db, self) };
        req.user = { ...other, viewed_by: self.name };
      } else req.user = self;
      req.user.site_ids = siteIdsFor(db, req.user);
    }
    req.sessionToken = req.user ? token : null;
    next();
  };
}

// Saves that quietly do nothing while viewing as someone (opening pages makes them), rather than showing an error.
const VIEW_AS_QUIET = /^\/(notifications\/read|auth\/tour)$/;
/** While an admin views Atlas as someone else, nothing can be changed (except stopping, or signing out). */
export function blockWhileViewingAs(req, res, next) {
  if (!req.realUser || ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || /^\/auth\/(view-as\/stop|logout)$/.test(req.path)) return next();
  if (VIEW_AS_QUIET.test(req.path)) return res.json({ ok: true });
  next(new HttpError(403, `You’re viewing Atlas as ${req.user.name}, so changes are switched off. Tap “Stop viewing” to make changes.`));
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
      const known = user ?? db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      logActivity(db, req, { kind: 'sign_in_failed', action: 'Failed sign-in', user_id: known?.id ?? null, detail: known ? (user ? 'Wrong password' : 'Account switched off') : `Unknown email: ${email}` });
      throw new HttpError(401, 'Incorrect email or password');
    }
    loginFails.delete(keys[1][0]);
    logActivity(db, req, { kind: 'sign_in', action: 'Signed in', user_id: user.id });
    res.json({ user: startSession(db, req, res, user.id) });
  });

  router.post('/auth/logout', (req, res) => {
    if (req.user) logActivity(db, req, { kind: 'sign_out', action: 'Signed out', user_id: (req.realUser ?? req.user).id });
    if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/auth/me', (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please sign in');
    res.json({ user: req.user });
  });

  // An admin starts or stops seeing Atlas as someone else would (look only – changes are blocked).
  router.post('/auth/view-as', (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please sign in');
    const admin = req.realUser ?? req.user;
    if (admin.role !== 'admin') throw forbidden('Only admins can view Atlas as someone else');
    const target = db.prepare('SELECT id, name, role, active FROM users WHERE id = ?').get(Number(req.body?.user_id));
    if (!target || !target.active) throw notFound('Person');
    if (target.id === admin.id) throw badRequest('That’s you – choose someone else to view Atlas as');
    db.prepare('UPDATE sessions SET view_as_user_id = ? WHERE token = ?').run(target.id, req.sessionToken);
    logActivity(db, req, { kind: 'change', area: 'Setup', action: 'Started viewing Atlas as someone', detail: target.name, user_id: admin.id, path: 'POST /auth/view-as' });
    res.json({ ok: true });
  });

  router.post('/auth/view-as/stop', (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please sign in');
    if (req.realUser) {
      db.prepare('UPDATE sessions SET view_as_user_id = NULL WHERE token = ?').run(req.sessionToken);
      logActivity(db, req, { kind: 'change', area: 'Setup', action: 'Stopped viewing Atlas as someone', detail: req.user.name, user_id: req.realUser.id, path: 'POST /auth/view-as/stop' });
    }
    res.json({ ok: true });
  });

  // The guided tour is done (finished or skipped), so it isn't shown again on sign-in.
  router.post('/auth/tour', (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please sign in');
    db.prepare(`UPDATE users SET tour_done_at = datetime('now') WHERE id = ?`).run(req.user.id);
    res.json({ ok: true });
  });

  router.post('/auth/password', (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please sign in');
    const current = str(req.body?.current_password, 'current_password', { required: true });
    const next = validatePassword(req.body?.new_password);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current, row.password_hash)) throw badRequest('Current password is incorrect');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
    logActivity(db, req, { kind: 'password', action: 'Changed their password' });
    res.json({ ok: true });
  });
}
