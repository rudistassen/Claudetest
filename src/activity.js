// Setup → Staff log: who signed in (or tried to), and every change people make in Atlas, in plain English.
// Sign-ins are logged by the auth routes; changes by a middleware that runs before each API request that saves
// something and records it once the request succeeds.
import { requirePerm } from './auth.js';
import { badRequest, date, id } from './util.js';

const KEEP_DAYS = 365;
// The same action on the same thing by the same person within this many minutes is one entry (e.g. counting stock).
const MERGE_MINUTES = 10;

/** A short description of the device from its browser's user agent, e.g. "iPhone · Safari". */
export function deviceOf(ua = '') {
  const s = String(ua);
  if (!s) return null;
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : null;
  const browser = /Edg\//.test(s) ? 'Edge' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /CriOS|Chrome\//.test(s) ? 'Chrome'
    : /FxiOS|Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : null;
  return [os, browser].filter(Boolean).join(' · ') || null;
}

/** Adds an entry to the staff log: { user_id, kind ('sign_in', 'sign_in_failed', 'sign_out', 'change'), area, action, detail, path }. */
export function logActivity(db, req, entry) {
  try {
    const row = {
      user_id: entry.user_id ?? req?.user?.id ?? null,
      kind: entry.kind ?? 'change',
      area: entry.area ?? null,
      action: entry.action,
      detail: entry.detail ? String(entry.detail).slice(0, 300) : null,
      path: entry.path ?? null,
      ip: req?.ip ? String(req.ip).replace(/^::ffff:/, '') : null,
      device: deviceOf(req?.headers?.['user-agent']),
    };
    const same = row.kind === 'change' && row.user_id ? db.prepare(`SELECT id FROM activity_log WHERE user_id = ? AND kind = 'change' AND action = ?
      AND path IS ? AND created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 1`).get(row.user_id, row.action, row.path, `-${MERGE_MINUTES} minutes`) : null;
    if (same) {
      db.prepare(`UPDATE activity_log SET times = times + 1, created_at = datetime('now'), detail = COALESCE(?, detail) WHERE id = ?`).run(row.detail, same.id);
      return;
    }
    db.prepare(`INSERT INTO activity_log (user_id, kind, area, action, detail, path, ip, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.user_id, row.kind, row.area, row.action, row.detail, row.path, row.ip, row.device);
    if (Math.random() < 0.02) db.prepare(`DELETE FROM activity_log WHERE created_at < datetime('now', ?)`).run(`-${KEEP_DAYS} days`);
  } catch {
    // The log must never stop someone doing their job.
  }
}

// ---- Describing each change ----

const nameOf = (db, table, col, rowId) => (rowId ? db.prepare(`SELECT ${col} AS v FROM ${table} WHERE id = ?`).get(Number(rowId))?.v ?? null : null);
const person = (db, userId) => nameOf(db, 'users', 'name', userId);
const fmtDay = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? ''))) return '';
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};
const join = (...parts) => parts.filter(Boolean).join(' · ') || null;
const shift = (db, shiftId) => {
  const s = shiftId ? db.prepare(`SELECT s.date, s.start_time, s.end_time, u.name, l.name AS site FROM shifts s LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN locations l ON l.id = s.location_id WHERE s.id = ?`).get(Number(shiftId)) : null;
  return s ? join(s.name ?? 'Open shift', `${fmtDay(s.date)} ${s.start_time}–${s.end_time}`, s.site) : null;
};
const leave = (db, leaveId) => {
  const l = leaveId ? db.prepare('SELECT l.start_date, l.end_date, u.name FROM leave_requests l JOIN users u ON u.id = l.user_id WHERE l.id = ?').get(Number(leaveId)) : null;
  return l ? join(l.name, l.start_date === l.end_date ? fmtDay(l.start_date) : `${fmtDay(l.start_date)} – ${fmtDay(l.end_date)}`) : null;
};
const site = (db, locationId) => nameOf(db, 'locations', 'name', locationId);
const week = (b) => (b?.week ? `week of ${fmtDay(b.week)}` : b?.week_start ? `week of ${fmtDay(b.week_start)}` : null);

// [method, path pattern, area, what they did, details (db, params, body) → text]. The first match wins.
const ACTIONS = [
  // Rota
  ['POST', '/shifts', 'Rota', 'Added a shift', (db, p, b) => join(b.user_id ? person(db, b.user_id) : 'Open shift', `${fmtDay(b.date)} ${b.start_time ?? ''}–${b.end_time ?? ''}`, site(db, b.location_id))],
  ['PUT', '/shifts/:id', 'Rota', 'Changed a shift', (db, p) => shift(db, p.id)],
  ['DELETE', '/shifts/:id', 'Rota', 'Deleted a shift', (db, p) => shift(db, p.id)],
  ['POST', '/shifts/:id/drop', 'Rota', 'Dropped a shift', (db, p) => shift(db, p.id)],
  ['POST', '/shifts/:id/open', 'Rota', 'Made a shift open for anyone to pick up', (db, p) => shift(db, p.id)],
  ['POST', '/shifts/:id/publish', 'Rota', 'Published a shift', (db, p) => shift(db, p.id)],
  ['POST', '/shifts/:id/restore', 'Rota', 'Put back a deleted shift', (db, p) => shift(db, p.id)],
  ['POST', '/shifts/:id/sickness', 'Rota', 'Recorded sickness on a shift', (db, p) => shift(db, p.id)],
  ['POST', '/rota/publish', 'Rota', 'Published the rota', (db, p, b) => join(week(b), b.date ? fmtDay(b.date) : null, site(db, b.location_id))],
  ['POST', '/rota/copy-week', 'Rota', 'Copied a week of the rota', (db, p, b) => join(week(b), site(db, b.location_id))],
  ['POST', '/rota/discard', 'Rota', 'Discarded unpublished rota changes', (db, p, b) => join(week(b), site(db, b.location_id))],
  ['POST', '/rota/undo', 'Rota', 'Undid a rota change'],
  ['POST', '/rota/import/read', 'Rota', 'Uploaded a rota for Claude to read'],
  ['POST', '/rota/import/apply', 'Rota', 'Added shifts from an uploaded rota', (db, p, b) => (Array.isArray(b.shifts) ? `${b.shifts.length} shift${b.shifts.length === 1 ? '' : 's'}` : null)],
  ['PUT', '/sales-budgets', 'Rota', 'Published a sales budget', (db, p, b) => join(week(b), site(db, b.location_id))],
  ['POST', '/shift-drops', 'Rota', 'Asked to drop a shift', (db, p, b) => shift(db, b.shift_id)],
  ['POST', '/shift-drops/:id/approve', 'Rota', 'Approved a request to drop a shift'],
  ['POST', '/shift-drops/:id/decline', 'Rota', 'Declined a request to drop a shift'],
  ['POST', '/shift-drops/:id/cancel', 'Rota', 'Cancelled their request to drop a shift'],
  ['POST', '/shift-drops/:id/claim', 'Rota', 'Asked to pick up an open shift'],
  ['POST', '/shift-drops/:id/cancel-claim', 'Rota', 'Cancelled their request to pick up a shift'],
  ['POST', '/shift-drops/:id/approve-claim', 'Rota', 'Approved a request to pick up a shift'],
  ['POST', '/shift-drops/:id/decline-claim', 'Rota', 'Declined a request to pick up a shift'],
  ['POST', '/shift-drops/:id/withdraw', 'Rota', 'Withdrew from an open shift'],
  ['PUT', '/timecards/:id/breaks', 'Rota', 'Changed the breaks on a timecard'],
  ['PUT', '/timecards/:id/location', 'Rota', 'Changed the site on a timecard'],
  // Time off and availability
  ['POST', '/leave', 'Time off', 'Asked for holiday', (db, p, b) => join(b.start_date === b.end_date ? fmtDay(b.start_date) : `${fmtDay(b.start_date)} – ${fmtDay(b.end_date)}`)],
  ['POST', '/leave/:id/decide', 'Time off', (b) => (b.status === 'approved' ? 'Approved holiday' : 'Declined holiday'), (db, p) => leave(db, p.id)],
  ['POST', '/leave/:id/cancel', 'Time off', 'Cancelled holiday', (db, p) => leave(db, p.id)],
  ['POST', '/leave/add', 'Time off', 'Added holiday for someone', (db, p, b) => join(person(db, b.user_id), b.start_date === b.end_date || !b.end_date ? fmtDay(b.start_date) : `${fmtDay(b.start_date)} – ${fmtDay(b.end_date)}`)],
  ['PUT', '/leave/:id', 'Time off', 'Changed someone’s holiday', (db, p) => leave(db, p.id)],
  ['POST', '/leave/:id/remove', 'Time off', 'Took someone’s holiday off', (db, p) => leave(db, p.id)],
  ['POST', '/availability/days/clear', 'Time off', 'Cleared their availability'],
  ['POST', '/availability/days', 'Time off', 'Set their availability for a day', (db, p, b) => fmtDay(b.date)],
  ['DELETE', '/availability/days/:id', 'Time off', 'Cleared their availability for a day'],
  ['PUT', '/availability/note', 'Time off', 'Changed their availability note'],
  ['POST', '/availability/patterns', 'Time off', 'Added repeating availability'],
  ['PUT', '/availability/patterns/:id', 'Time off', 'Changed repeating availability'],
  ['DELETE', '/availability/patterns/:id', 'Time off', 'Deleted repeating availability'],
  // Trail
  ['POST', '/safety/checks', 'Trail', 'Completed a check', (db, p, b) => join(nameOf(db, 'safety_tasks', 'title', b.task_id), site(db, b.location_id))],
  ['DELETE', '/safety/checks/:id', 'Trail', 'Removed a completed check'],
  ['POST', '/safety/tasks', 'Trail', 'Added a check to Trail', (db, p, b) => b.title],
  ['PUT', '/safety/tasks/:id', 'Trail', 'Changed a Trail check', (db, p) => nameOf(db, 'safety_tasks', 'title', p.id)],
  ['DELETE', '/safety/tasks/:id', 'Trail', 'Deleted a Trail check', (db, p) => nameOf(db, 'safety_tasks', 'title', p.id)],
  ['POST', '/safety/tasks/:id/:what', 'Trail', 'Changed a Trail check for a site', (db, p) => nameOf(db, 'safety_tasks', 'title', p.id)],
  // Stock and ordering
  ['POST', '/wastage', 'Stock', 'Recorded wastage'],
  ['DELETE', '/wastage/:id', 'Stock', 'Deleted a wastage entry'],
  ['POST', '/stocktakes', 'Stock', 'Started a stock take', (db, p, b) => site(db, b.location_id)],
  ['PUT', '/stocktakes/:id/lines', 'Stock', 'Counted stock'],
  ['POST', '/stocktakes/:id/complete', 'Stock', 'Finished a stock take'],
  ['DELETE', '/stocktakes/:id', 'Stock', 'Deleted a stock take'],
  ['POST', '/orders', 'Ordering', 'Started an order', (db, p, b) => join(nameOf(db, 'suppliers', 'name', b.supplier_id), site(db, b.location_id))],
  ['PUT', '/orders/:id', 'Ordering', 'Changed an order'],
  ['DELETE', '/orders/:id', 'Ordering', 'Deleted an order'],
  ['POST', '/orders/:id/send', 'Ordering', 'Sent an order'],
  ['POST', '/orders/:id/receive', 'Ordering', 'Received an order'],
  ['POST', '/orders/:id/cancel', 'Ordering', 'Cancelled an order'],
  ['POST', '/prep-orders', 'Ordering', 'Started a prep kitchen order'],
  ['PUT', '/prep-orders/:id', 'Ordering', 'Changed a prep kitchen order'],
  ['DELETE', '/prep-orders/:id', 'Ordering', 'Deleted a prep kitchen order'],
  ['POST', '/prep-orders/:id/sent', 'Ordering', 'Sent a prep kitchen order'],
  ['POST', '/invoices/scan', 'Invoices', 'Uploaded an invoice'],
  ['PUT', '/invoices/:id', 'Invoices', 'Changed an invoice'],
  ['DELETE', '/invoices/:id', 'Invoices', 'Deleted an invoice'],
  ['POST', '/invoices/:id/confirm', 'Invoices', 'Confirmed an invoice'],
  ['POST', '/invoices/:id/xero', 'Invoices', 'Sent an invoice to Xero'],
  ['POST', '/invoices/xero', 'Invoices', 'Sent invoices to Xero'],
  ['PUT', '/invoice-inbox', 'Invoices', 'Changed the invoice inbox settings'],
  ['POST', '/products/import', 'Products', 'Imported products'],
  ['POST', '/products/bulk', 'Products', 'Changed products in bulk'],
  ['POST', '/products', 'Products', 'Added a product', (db, p, b) => b.name],
  ['PUT', '/products/:id/pars', 'Products', 'Changed par levels', (db, p) => nameOf(db, 'products', 'name', p.id)],
  ['PUT', '/products/:id', 'Products', 'Changed a product', (db, p) => nameOf(db, 'products', 'name', p.id)],
  ['POST', '/product-categories', 'Products', 'Added a product category', (db, p, b) => b.name],
  ['PUT', '/product-categories/:id', 'Products', 'Changed a product category'],
  ['DELETE', '/product-categories/:id', 'Products', 'Deleted a product category'],
  ['POST', '/suppliers', 'Products', 'Added a supplier', (db, p, b) => b.name],
  ['PUT', '/suppliers/:id/site-refs', 'Products', 'Changed a supplier’s account numbers', (db, p) => nameOf(db, 'suppliers', 'name', p.id)],
  ['PUT', '/suppliers/:id', 'Products', 'Changed a supplier', (db, p) => nameOf(db, 'suppliers', 'name', p.id)],
  // Menu
  ['POST', '/recipes/square-items/refresh', 'Menu', 'Refreshed items from Square'],
  ['POST', '/recipes', 'Menu', 'Added a recipe', (db, p, b) => b.name],
  ['PUT', '/recipes/:id', 'Menu', 'Changed a recipe', (db, p) => nameOf(db, 'recipes', 'name', p.id)],
  // Reporting
  ['POST', '/par-levels/reports', 'Reporting', 'Saved a par level report', (db, p, b) => b.name],
  ['PUT', '/par-levels/reports/:id', 'Reporting', 'Changed a par level report'],
  ['DELETE', '/par-levels/reports/:id', 'Reporting', 'Deleted a par level report'],
  ['POST', '/reports/email/:id/send', 'Reporting', 'Sent an email report'],
  ['POST', '/reports/email', 'Reporting', 'Added an email report'],
  ['PUT', '/reports/email/:id', 'Reporting', 'Changed an email report'],
  ['DELETE', '/reports/email/:id', 'Reporting', 'Deleted an email report'],
  // People
  ['POST', '/learn/:id/submit', 'Training', 'Took a training course', (db, p) => nameOf(db, 'training_courses', 'name', p.id)],
  ['POST', '/training/courses/:id/assign', 'Training', 'Gave a training course to people', (db, p, b) => join(nameOf(db, 'training_courses', 'name', p.id), Array.isArray(b.user_ids) ? `${b.user_ids.length} ${b.user_ids.length === 1 ? 'person' : 'people'}` : null)],
  ['DELETE', '/training/courses/:id/assign/:userId', 'Training', 'Took someone off a training course', (db, p) => join(person(db, p.userId), nameOf(db, 'training_courses', 'name', p.id))],
  ['PUT', '/training/courses/:id/design', 'Training', 'Changed a training course', (db, p) => nameOf(db, 'training_courses', 'name', p.id)],
  ['POST', '/training/courses', 'Training', 'Added a training course', (db, p, b) => b.name],
  ['PUT', '/training/courses/:id', 'Training', 'Changed a training course', (db, p) => nameOf(db, 'training_courses', 'name', p.id)],
  ['DELETE', '/training/courses/:id', 'Training', 'Removed a training course', (db, p) => nameOf(db, 'training_courses', 'name', p.id)],
  ['POST', '/training/attempts/:id/decide', 'Training', (b) => (b.approve ? 'Signed off training' : 'Sent back training to redo')],
  ['POST', '/training/records', 'Training', 'Recorded training', (db, p, b) => join(nameOf(db, 'training_courses', 'name', b.course_id), Array.isArray(b.user_ids) ? `${b.user_ids.length} ${b.user_ids.length === 1 ? 'person' : 'people'}` : null)],
  ['DELETE', '/training/records/:id', 'Training', 'Removed a training record'],
  ['POST', '/performance/reviews', 'People', 'Added a performance review', (db, p, b) => person(db, b.user_id)],
  ['PUT', '/performance/reviews/:id', 'People', 'Changed a performance review'],
  ['DELETE', '/performance/reviews/:id', 'People', 'Deleted a performance review'],
  ['POST', '/areas', 'People', 'Added a work area', (db, p, b) => b.name],
  ['PUT', '/areas/:id/people/:userId', 'People', 'Changed someone’s training in an area', (db, p) => person(db, p.userId)],
  ['PUT', '/areas/:id', 'People', 'Changed a work area'],
  ['DELETE', '/areas/:id', 'People', 'Deleted a work area'],
  ['POST', '/vacancies/:id/candidates', 'Recruitment', 'Added a candidate'],
  ['POST', '/vacancies', 'Recruitment', 'Added a job', (db, p, b) => b.title],
  ['PUT', '/vacancies/:id', 'Recruitment', 'Changed a job'],
  ['DELETE', '/vacancies/:id', 'Recruitment', 'Deleted a job'],
  ['POST', '/candidates/:id/decline', 'Recruitment', 'Turned down a candidate', (db, p) => nameOf(db, 'candidates', 'name', p.id)],
  ['POST', '/candidates/:id/review', 'Recruitment', 'Starred a candidate to review', (db, p) => nameOf(db, 'candidates', 'name', p.id)],
  ['POST', '/candidates/:id/files', 'Recruitment', 'Added a file to a candidate', (db, p) => nameOf(db, 'candidates', 'name', p.id)],
  ['DELETE', '/candidates/:id/files/:fileId', 'Recruitment', 'Removed a candidate’s file', (db, p) => nameOf(db, 'candidates', 'name', p.id)],
  ['POST', '/candidates', 'Recruitment', 'Added a candidate', (db, p, b) => b.name],
  ['PUT', '/candidates/:id', 'Recruitment', 'Changed a candidate', (db, p) => nameOf(db, 'candidates', 'name', p.id)],
  ['DELETE', '/candidates/:id', 'Recruitment', 'Deleted a candidate', (db, p) => nameOf(db, 'candidates', 'name', p.id)],
  ['PUT', '/careers-inbox/template', 'Recruitment', 'Changed the “not this time” email'],
  // Events
  ['POST', '/events/enquiries/:id/messages', 'Events', 'Replied to an enquiry'],
  ['POST', '/events/enquiries/:id/no-reply', 'Events', 'Marked an enquiry as not needing a reply'],
  ['POST', '/events/enquiries/:id/fill', 'Events', 'Filled in an enquiry from its email'],
  ['POST', '/events/enquiries', 'Events', 'Added an enquiry'],
  ['PUT', '/events/enquiries/:id', 'Events', 'Changed an enquiry'],
  ['DELETE', '/events/enquiries/:id', 'Events', 'Deleted an enquiry'],
  ['POST', '/events/marketing/file', 'Events', 'Uploaded a marketing list'],
  ['DELETE', '/events/marketing/senders/:email', 'Events', 'Removed a marketing sender'],
  // News and documents
  ['POST', '/news/:id/read', 'News', 'Confirmed they’d read a news post', (db, p) => nameOf(db, 'news_posts', 'title', p.id)],
  ['POST', '/news', 'News', 'Posted news', (db, p, b) => b.title],
  ['PUT', '/news/:id', 'News', 'Changed a news post', (db, p) => nameOf(db, 'news_posts', 'title', p.id)],
  ['DELETE', '/news/:id', 'News', 'Deleted a news post', (db, p) => nameOf(db, 'news_posts', 'title', p.id)],
  ['POST', '/documents', 'News', 'Added a company document', (db, p, b) => b.title ?? b.name],
  ['PUT', '/documents/:id', 'News', 'Changed a company document'],
  ['DELETE', '/documents/:id', 'News', 'Deleted a company document'],
  // Setup
  ['POST', '/users/invite', 'Setup', 'Invited someone to Atlas', (db, p, b) => b.name ?? b.email],
  ['POST', '/users/bulk', 'Setup', 'Changed staff in bulk', (db, p, b) => (Array.isArray(b.ids) ? `${b.ids.length} people` : null)],
  ['POST', '/users', 'Setup', 'Added a member of staff', (db, p, b) => b.name],
  ['PUT', '/users/:id', 'Setup', 'Changed a member of staff', (db, p) => person(db, p.id)],
  ['POST', '/permission-sets', 'Setup', 'Added a permission set', (db, p, b) => b.name],
  ['PUT', '/permission-sets/:id', 'Setup', 'Changed a permission set', (db, p) => nameOf(db, 'permission_sets', 'name', p.id)],
  ['DELETE', '/permission-sets/:id', 'Setup', 'Deleted a permission set', (db, p) => nameOf(db, 'permission_sets', 'name', p.id)],
  ['POST', '/locations', 'Setup', 'Added a site', (db, p, b) => b.name],
  ['PUT', '/locations/:id/:what', 'Setup', 'Changed a site’s links', (db, p) => site(db, p.id)],
  ['PUT', '/locations/:id', 'Setup', 'Changed a site', (db, p) => site(db, p.id)],
  ['POST', '/square/sync', 'Setup', 'Synced with Square'],
  ['POST', '/square/import-staff', 'Setup', 'Imported staff from Square'],
  ['POST', '/square/import-location', 'Setup', 'Imported a site from Square'],
  ['POST', '/square/cleanup', 'Setup', 'Cleaned up demo data'],
  ['POST', '/xero/disconnect', 'Setup', 'Disconnected Xero'],
  ['PUT', '/xero/settings', 'Setup', 'Changed the Xero settings'],
  ['POST', '/payment-links/:id/cancel', 'Setup', 'Cancelled a payment link'],
  ['POST', '/payment-links/:id/email', 'Setup', 'Emailed a payment link'],
  ['POST', '/payment-links', 'Setup', 'Made a payment link'],
  ['POST', '/push/test', 'Setup', 'Sent themselves a test notification'],
].map(([method, pattern, area, action, detail]) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
  return { method, re, keys, area, action, detail };
});

// Saves that happen in the background or are too small to be worth logging.
const QUIET = /^\/(push\/(subscribe|unsubscribe|prefs)|notifications\/read|auth\/|news\/media|training\/media|.*\/check$|reviews\/sync|payment-links\/\d+\/check)/;

/** What a request does, in words (or null if it isn't worth logging). */
export function describe(db, method, path, body = {}) {
  if (QUIET.test(path)) return null;
  for (const a of ACTIONS) {
    if (a.method !== method) continue;
    const m = a.re.exec(path);
    if (!m) continue;
    const params = Object.fromEntries(a.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    let detail = null;
    try { detail = a.detail ? a.detail(db, params, body ?? {}) : null; } catch { detail = null; }
    return { area: a.area, action: typeof a.action === 'function' ? a.action(body ?? {}) : a.action, detail };
  }
  // Anything not listed above is still logged, in general terms.
  const area = path.split('/')[1] ?? '';
  return { area: 'Other', action: `${{ POST: 'Saved', PUT: 'Changed', PATCH: 'Changed', DELETE: 'Deleted' }[method] ?? 'Changed'} ${area.replace(/-/g, ' ')}`, detail: null };
}

/** Logs each successful save by a signed-in person. Runs before the route (to name things before they're deleted). */
export function activityLogger(db) {
  return (req, res, next) => {
    if (!req.user || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    let what = null;
    try { what = describe(db, req.method, req.path, req.body); } catch { what = null; }
    if (!what) return next();
    // Logged when the reply goes out, and only if it worked.
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if ((res.statusCode ?? 200) < 400) logActivity(db, req, { kind: 'change', ...what, path: `${req.method} ${req.path}` });
    };
    for (const fn of ['json', 'send', 'end']) {
      const original = res[fn];
      if (typeof original !== 'function') continue;
      res[fn] = function patched(...args) {
        finish();
        return original.apply(this, args);
      };
    }
    next();
  };
}

const KINDS = {
  sign_in: 'Signed in',
  sign_in_failed: 'Failed sign-in',
  sign_out: 'Signed out',
  password: 'Changed their password',
};

export function registerActivityRoutes(router, db) {
  // { user_id, kind ('sign_ins' or 'changes'), area, from, to, before (id, for the next page) } → newest first.
  // Admins see everyone; anyone else given the Staff log permission sees people at their own sites (not admins).
  router.get('/staff-log', requirePerm('staff.log'), (req, res) => {
    const q = req.query;
    const where = [];
    const args = [];
    const mine = req.user.role === 'admin' ? '' : `u.role != 'admin' AND u.location_id IN (${req.user.site_ids.map(() => '?').join(', ') || 'NULL'})`;
    if (mine) { where.push(mine); args.push(...req.user.site_ids); }
    const userId = id(q.user_id, 'user_id');
    if (userId) { where.push('a.user_id = ?'); args.push(userId); }
    if (q.kind === 'sign_ins') where.push(`a.kind != 'change'`);
    else if (q.kind === 'changes') where.push(`a.kind = 'change'`);
    else if (q.kind) throw badRequest('Unknown kind');
    if (q.area) { where.push('a.area = ?'); args.push(String(q.area)); }
    const from = date(q.from, 'from');
    const to = date(q.to, 'to');
    if (from) { where.push('a.created_at >= ?'); args.push(`${from} 00:00:00`); }
    if (to) { where.push('a.created_at <= ?'); args.push(`${to} 23:59:59`); }
    const before = id(q.before, 'before');
    if (before) { where.push('a.id < ?'); args.push(before); }
    const limit = 200;
    const rows = db.prepare(`SELECT a.id, a.user_id, a.kind, a.area, a.action, a.detail, a.ip, a.device, a.times, a.created_at,
        u.name AS user_name, l.name AS location_name
      FROM activity_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN locations l ON l.id = u.location_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`).all(...args, limit + 1);
    res.json({
      rows: rows.slice(0, limit).map((r) => ({ ...r, action: r.kind === 'change' ? r.action : KINDS[r.kind] ?? r.action })),
      more: rows.length > limit,
      people: db.prepare(`SELECT DISTINCT u.id, u.name FROM activity_log a JOIN users u ON u.id = a.user_id ${mine ? `WHERE ${mine}` : ''} ORDER BY u.name`).all(...(mine ? req.user.site_ids : [])),
      areas: db.prepare(`SELECT DISTINCT area FROM activity_log WHERE area IS NOT NULL ORDER BY area`).all().map((r) => r.area),
    });
  });
}
