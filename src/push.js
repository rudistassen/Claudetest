// Phone notifications (Web Push): each person turns them on on their phone (Atlas added to the Home Screen on an
// iPhone), chooses which kinds they want, and Atlas sends a short message that opens the right page when tapped.
// Atlas makes its own keys the first time (or uses VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY if they're set).
import { ACCESS_FIELDS, ACCESS_JOIN, can, PUBLIC_USER_FIELDS, siteIdsFor, withPermissions } from './auth.js';

// Every kind of notification, and who can get it (people with any of `perms`; everyone when there are none).
export const PUSH_KINDS = [
  { key: 'rota_published', label: 'The rota is published', group: 'Your shifts' },
  { key: 'shift_changed', label: 'One of your shifts is added, changed or removed', group: 'Your shifts' },
  { key: 'open_shift', label: 'A shift at your site is free to pick up', group: 'Your shifts' },
  { key: 'drop_decision', label: 'Your request to drop a shift is approved or declined', group: 'Your shifts' },
  { key: 'holiday_decision', label: 'Your holiday request is approved or declined', group: 'Holiday' },
  { key: 'news', label: 'New news or a policy to read', group: 'News' },
  { key: 'holiday_request', label: 'Someone asks for holiday', group: 'For managers', perms: ['leave.manage'] },
  { key: 'drop_request', label: 'Someone asks to drop a shift', group: 'For managers', perms: ['rota.publish'] },
  { key: 'late', label: 'Someone is late or hasn’t clocked in for their shift', group: 'For managers', perms: ['rota.edit', 'staff.manage'] },
  { key: 'enquiry', label: 'A new events enquiry comes in', group: 'For managers', perms: ['events.manage'] },
  { key: 'application', label: 'A new job application comes in', group: 'For managers', perms: ['people.manage'] },
];
const KIND_KEYS = new Set(PUSH_KINDS.map((k) => k.key));
export const kindsFor = (user) => PUSH_KINDS.filter((k) => !k.perms || k.perms.some((p) => can(user, p)));

let send = null;
let publicKey = null;

/**
 * Sets up sending. The keys come from VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY if they're set; otherwise Atlas makes
 * its own the first time and keeps them in the database (so there's nothing to set up). Resolves to whether
 * notifications are on.
 */
export async function configurePush(env = process.env, db = null) {
  // Loaded only on the server (the standalone demo runs in a browser, where it can't).
  const lib = 'web-push';
  const webpush = (await import(lib)).default;
  let keys = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY } : null;
  if (!keys && db) {
    const saved = db.prepare(`SELECT value FROM settings WHERE key = 'push_vapid_keys'`).get()?.value;
    keys = saved ? JSON.parse(saved) : webpush.generateVAPIDKeys();
    if (!saved) db.prepare(`INSERT INTO settings (key, value) VALUES ('push_vapid_keys', ?)`).run(JSON.stringify(keys));
  }
  if (!keys) return false;
  const subject = env.VAPID_SUBJECT || (env.APP_URL ? env.APP_URL.replace(/\/$/, '') : 'mailto:admin@example.com');
  webpush.setVapidDetails(subject.startsWith('http') || subject.startsWith('mailto:') ? subject : `mailto:${subject}`, keys.publicKey, keys.privateKey);
  publicKey = keys.publicKey;
  send = (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 12 });
  return true;
}

/** For tests and the demo: a stand-in sender ((subscription, payload) => Promise), with a made-up public key. */
export function setPushSender(fn, key = 'test-public-key') {
  send = fn;
  publicKey = fn ? key : null;
}

export const pushEnabled = () => !!send;
export const pushPublicKey = () => publicKey;

/** Whether someone wants a kind of notification (yes, unless they've turned it off). */
const wants = (db, userId, kind) => db.prepare('SELECT enabled FROM push_prefs WHERE user_id = ? AND kind = ?').get(userId, kind)?.enabled !== 0;

/**
 * Sends a notification to people (who want that kind) on every device they turned it on for: { title, body, url,
 * tag }. force sends even if they've turned that kind off (the test). Never throws or holds anything up – it carries on in the background, and devices that have gone are
 * forgotten. Resolves to how many were sent.
 */
export function notify(db, userIds, kind, { title, body, url = '/', tag } = {}, force = false) {
  if (!KIND_KEYS.has(kind)) return Promise.resolve(0);
  try {
    const ids = [...new Set((userIds ?? []).filter(Boolean))];
    if (!ids.length) return Promise.resolve(0);
    const active = new Set(db.prepare(`SELECT id FROM users WHERE active = 1 AND id IN (${ids.map(() => '?').join(', ')})`).all(...ids).map((r) => r.id));
    const to = ids.filter((id) => active.has(id) && (force || wants(db, id, kind)));
    if (!to.length) return Promise.resolve(0);
    // Each person's Notifications page keeps it (whether or not they have notifications on a phone); tapping it on
    // the phone opens that page with this one at the top.
    const keep = db.prepare('INSERT INTO notifications (user_id, kind, title, body, url) VALUES (?, ?, ?, ?, ?)');
    const saved = new Map(to.map((id) => [id, Number(keep.run(id, kind, title, body ?? null, url).lastInsertRowid)]));
    db.prepare(`DELETE FROM notifications WHERE created_at < datetime('now', '-60 days')`).run();
    if (!send) return Promise.resolve(0);
    const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${to.map(() => '?').join(', ')})`).all(...to);
    return Promise.all(subs.map(async (s) => {
      const payload = JSON.stringify({ title, body, url: `/#/notifications?n=${saved.get(s.user_id)}`, page: url, tag: tag ?? kind, kind });
      try {
        await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        db.prepare(`UPDATE push_subscriptions SET last_sent_at = datetime('now') WHERE id = ?`).run(s.id);
        return 1;
      } catch (err) {
        // The phone unsubscribed, or the app was removed: stop sending to it.
        if (err?.statusCode === 404 || err?.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        return 0;
      }
    })).then((r) => r.reduce((a, b) => a + b, 0)).catch(() => 0);
  } catch {
    return Promise.resolve(0);
  }
}

/** Sends once per key (e.g. one "not clocked in" alert per shift). */
export function notifyOnce(db, key, userIds, kind, message) {
  const r = db.prepare('INSERT OR IGNORE INTO push_sent (key) VALUES (?)').run(key);
  return r.changes ? notify(db, userIds, kind, message) : Promise.resolve(0);
}

/** Active people with any of the permissions who look after a site (any site, if siteId is null). */
export function peopleWith(db, perms, siteId = null) {
  return db.prepare(`SELECT ${PUBLIC_USER_FIELDS}, ${ACCESS_FIELDS} FROM users u ${ACCESS_JOIN} WHERE u.active = 1`).all()
    .map(withPermissions)
    .filter((u) => perms.some((p) => can(u, p)) && (siteId === null || siteIdsFor(db, u).includes(siteId)))
    .map((u) => u.id);
}

/** Active people based at (or working at) a site. */
export function peopleAt(db, siteId) {
  return db.prepare(`SELECT id FROM users WHERE active = 1 AND (location_id = ? OR id IN (SELECT user_id FROM user_sites WHERE location_id = ?))`)
    .all(siteId, siteId).map((r) => r.id);
}

export function registerPushRoutes(router, db) {
  // Whether notifications are set up, the key phones need, this person's devices and choices.
  router.get('/push', (req, res) => {
    const off = new Set(db.prepare('SELECT kind FROM push_prefs WHERE user_id = ? AND enabled = 0').all(req.user.id).map((r) => r.kind));
    res.json({
      enabled: pushEnabled(),
      public_key: pushPublicKey(),
      devices: db.prepare('SELECT id, endpoint, user_agent, created_at, last_sent_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at').all(req.user.id),
      kinds: kindsFor(req.user).map((k) => ({ key: k.key, label: k.label, group: k.group, on: !off.has(k.key) })),
    });
  });

  // This device: { subscription: { endpoint, keys: { p256dh, auth } } } from the phone.
  router.post('/push/subscribe', (req, res) => {
    const sub = req.body?.subscription;
    const endpoint = String(sub?.endpoint ?? '');
    if (!/^https:\/\//.test(endpoint) || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return res.status(400).json({ error: 'That phone didn’t give a notification address – try again' });
    }
    db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`)
      .run(req.user.id, endpoint, String(sub.keys.p256dh), String(sub.keys.auth), String(req.get('user-agent') ?? '').slice(0, 300));
    res.status(201).json({ ok: true });
  });

  router.post('/push/unsubscribe', (req, res) => {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(req.user.id, String(req.body?.endpoint ?? ''));
    res.json({ ok: true });
  });

  // Which kinds this person wants: { kinds: { rota_published: true, news: false, … } }.
  router.put('/push/prefs', (req, res) => {
    const kinds = req.body?.kinds ?? {};
    const allowed = new Set(kindsFor(req.user).map((k) => k.key));
    const up = db.prepare('INSERT INTO push_prefs (user_id, kind, enabled) VALUES (?, ?, ?) ON CONFLICT (user_id, kind) DO UPDATE SET enabled = excluded.enabled');
    for (const [k, on] of Object.entries(kinds)) if (allowed.has(k)) up.run(req.user.id, k, on ? 1 : 0);
    res.json({ ok: true });
  });

  // This person's notifications, newest first (the last 60 days, up to 100), and how many they haven't seen.
  router.get('/notifications', (req, res) => {
    const items = db.prepare('SELECT id, kind, title, body, url, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
    res.json({ items, unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n });
  });
  // Marks them all as seen.
  router.post('/notifications/read', (req, res) => {
    db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`).run(req.user.id);
    res.json({ ok: true });
  });

  // A test notification to this person's devices.
  router.post('/push/test', async (req, res) => {
    if (!pushEnabled()) return res.status(400).json({ error: 'Notifications aren’t set up yet – an admin needs to add the notification keys in Railway' });
    const devices = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(req.user.id).n;
    if (!devices) return res.status(400).json({ error: 'Turn on notifications on this phone first' });
    const sent = await notify(db, [req.user.id], 'news', { title: 'Atlas notifications are on', body: 'You’ll get notifications like this one. Tap to open Atlas.', url: '/#/notifications', tag: 'test' }, true);
    res.json({ sent, devices });
  });
}

const LATE_AFTER_MINUTES = 15;
const londonNow = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const minutesOf = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/**
 * "Not clocked in": a published shift that started at least 15 minutes ago (and hasn't ended), with no clock-in from
 * that person today, at a site whose clock-ins come from Square. Whoever runs the rota there is told once per shift.
 */
export function checkLate(db, { now = londonNow(), day = londonToday() } = {}) {
  if (!pushEnabled()) return 0;
  const nowMin = minutesOf(now);
  // Only sites with clock-ins coming in from Square (otherwise everyone would look late).
  const syncing = new Set(db.prepare(`SELECT DISTINCT location_id FROM timecards WHERE date >= date(?, '-2 days')`).all(day).map((r) => r.location_id));
  let sent = 0;
  for (const s of db.prepare(`SELECT s.*, u.name AS person, l.name AS site FROM published_shifts s JOIN users u ON u.id = s.user_id
    JOIN locations l ON l.id = s.location_id WHERE s.date = ? AND s.sick = 0 AND u.active = 1`).all(day)) {
    if (!syncing.has(s.location_id)) continue;
    const start = minutesOf(s.start_time);
    let end = minutesOf(s.end_time);
    if (end <= start) end = 24 * 60;
    const late = nowMin - start;
    if (late < LATE_AFTER_MINUTES || nowMin >= end) continue;
    if (db.prepare('SELECT 1 FROM timecards WHERE user_id = ? AND date = ?').get(s.user_id, day)) continue;
    if (db.prepare(`SELECT 1 FROM leave_requests WHERE user_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?`).get(s.user_id, day, day)) continue;
    notifyOnce(db, `late|${s.id}|${day}`, peopleWith(db, ['rota.edit', 'staff.manage'], s.location_id).filter((id) => id !== s.user_id), 'late', {
      title: `${s.person} hasn’t clocked in`,
      body: `Rota ${s.start_time}–${s.end_time} at ${s.site} – ${late} minutes late`,
      url: '/#/dashboard', tag: `late-${s.id}`,
    });
    sent++;
  }
  // Old "already sent" notes aren't needed after a fortnight.
  db.prepare(`DELETE FROM push_sent WHERE at < datetime('now', '-14 days')`).run();
  return sent;
}

/** Checks for late starters every few minutes while notifications are set up. */
export function startLateAlerts(db, { minutes = 5, log = console } = {}) {
  if (!pushEnabled()) return null;
  const run = () => { try { checkLate(db); } catch (err) { log.error?.('Late alerts:', err.message); } };
  setTimeout(run, 30000);
  return setInterval(run, minutes * 60000);
}
