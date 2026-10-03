import { can, requirePerm } from '../auth.js';
import { addDays, badRequest, date, forbidden, id, notFound, oneOf, str, time, today } from '../util.js';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MAX_LEAVE_DAYS = 60;
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;

/** Approved and pending holiday for the given people overlapping [from, to]. */
export function leaveFor(db, userIds, from, to) {
  if (!userIds.length) return [];
  return db.prepare(`SELECT id, user_id, start_date, end_date, status, note FROM leave_requests
    WHERE status IN ('pending', 'approved') AND user_id IN (${userIds.map(() => '?').join(', ')}) AND start_date <= ? AND end_date >= ?
    ORDER BY start_date`).all(...userIds, to, from);
}

/** Each person's weekly availability: { userId: { weekday: { status, from_time, to_time } } } plus their note. */
export function availabilityFor(db, userIds) {
  const out = {};
  if (!userIds.length) return out;
  const list = userIds.map(() => '?').join(', ');
  for (const r of db.prepare(`SELECT * FROM availability WHERE user_id IN (${list})`).all(...userIds)) {
    out[r.user_id] ??= { days: {}, note: null };
    out[r.user_id].days[r.weekday] = { status: r.status, from_time: r.from_time, to_time: r.to_time };
  }
  for (const u of db.prepare(`SELECT id, availability_note FROM users WHERE id IN (${list}) AND availability_note IS NOT NULL`).all(...userIds)) {
    out[u.id] ??= { days: {}, note: null };
    out[u.id].note = u.availability_note;
  }
  return out;
}

/** The approved holiday someone is on for a date, if any (shifts can't be added then). */
export function onHoliday(db, userId, day) {
  return db.prepare(`SELECT * FROM leave_requests WHERE user_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?`).get(userId, day, day);
}

export function registerLeaveRoutes(router, db) {
  // People whose holiday and availability this person looks after: staff based at their sites (admins: everyone).
  const manageable = (req) => {
    const sites = new Set(req.user.site_ids);
    return db.prepare(`SELECT u.id, u.name, u.role, u.location_id, l.name AS location_name FROM users u
      LEFT JOIN locations l ON l.id = u.location_id WHERE u.active = 1 ORDER BY l.name, u.name`).all()
      .filter((u) => u.id !== req.user.id && (req.user.role === 'admin' || (u.role !== 'admin' && sites.has(u.location_id))));
  };
  const withNames = `SELECT r.*, u.name AS user_name, l.name AS location_name, d.name AS decided_by_name FROM leave_requests r
    JOIN users u ON u.id = r.user_id LEFT JOIN locations l ON l.id = u.location_id LEFT JOIN users d ON d.id = r.decided_by`;
  const withDays = (r) => ({ ...r, days: daysBetween(r.start_date, r.end_date) });

  // --- Your own holiday ---

  router.get('/leave/mine', (req, res) => {
    const rows = db.prepare(`${withNames} WHERE r.user_id = ? ORDER BY r.start_date DESC`).all(req.user.id).map(withDays);
    const year = today().slice(0, 4);
    // Approved days this calendar year (the part of each holiday that falls in this year).
    const booked = rows.filter((r) => r.status === 'approved').reduce((t, r) => {
      const from = r.start_date < `${year}-01-01` ? `${year}-01-01` : r.start_date;
      const to = r.end_date > `${year}-12-31` ? `${year}-12-31` : r.end_date;
      return from <= to ? t + daysBetween(from, to) : t;
    }, 0);
    res.json({ requests: rows, booked_this_year: booked, year });
  });

  router.post('/leave', (req, res) => {
    const start = date(req.body.start_date, 'start_date', { required: true });
    const end = date(req.body.end_date, 'end_date') ?? start;
    if (end < start) throw badRequest('The last day must be on or after the first day');
    if (start < today()) throw badRequest('Holiday can’t start in the past');
    if (daysBetween(start, end) > MAX_LEAVE_DAYS) throw badRequest(`Request at most ${MAX_LEAVE_DAYS} days at a time`);
    const overlap = db.prepare(`SELECT start_date, end_date FROM leave_requests WHERE user_id = ? AND status IN ('pending', 'approved') AND start_date <= ? AND end_date >= ?`)
      .get(req.user.id, end, start);
    if (overlap) throw badRequest(`You already have holiday booked or requested from ${overlap.start_date} to ${overlap.end_date}`);
    const r = db.prepare('INSERT INTO leave_requests (user_id, start_date, end_date, note) VALUES (?, ?, ?, ?)')
      .run(req.user.id, start, end, str(req.body.note, 'note', { max: 500 }));
    res.status(201).json(withDays(db.prepare(`${withNames} WHERE r.id = ?`).get(r.lastInsertRowid)));
  });

  // You can cancel a request that's waiting, or approved holiday that hasn't started yet.
  router.post('/leave/:id/cancel', (req, res) => {
    const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(req.params.id));
    if (!r || r.user_id !== req.user.id) throw notFound('Holiday request');
    if (!(r.status === 'pending' || (r.status === 'approved' && r.start_date > today()))) throw badRequest('This holiday can’t be cancelled any more');
    db.prepare(`UPDATE leave_requests SET status = 'cancelled' WHERE id = ?`).run(r.id);
    res.json(withDays(db.prepare(`${withNames} WHERE r.id = ?`).get(r.id)));
  });

  // --- Approving holiday (managers) ---

  router.get('/leave', requirePerm('leave.manage'), (req, res) => {
    const people = manageable(req);
    const ids = people.map((u) => u.id);
    const status = oneOf(req.query.status, 'status', ['pending', 'upcoming', 'past']) ?? 'pending';
    if (!ids.length) return res.json([]);
    const where = status === 'pending' ? `r.status = 'pending'`
      : status === 'upcoming' ? `r.status = 'approved' AND r.end_date >= '${today()}'`
        : `r.status IN ('approved', 'declined', 'cancelled') AND (r.end_date < '${today()}' OR r.status != 'approved')`;
    const rows = db.prepare(`${withNames} WHERE r.user_id IN (${ids.map(() => '?').join(', ')}) AND ${where}
      ORDER BY ${status === 'past' ? 'r.start_date DESC LIMIT 200' : 'r.start_date'}`).all(...ids);
    // Shifts already on the rota during each holiday, so they can be moved.
    const shifts = db.prepare(`SELECT s.date, s.start_time, s.end_time, l.name AS location_name FROM draft_shifts s JOIN locations l ON l.id = s.location_id
      WHERE s.user_id = ? AND s.date BETWEEN ? AND ? ORDER BY s.date`);
    res.json(rows.map((r) => ({ ...withDays(r), shifts: r.status === 'declined' || r.status === 'cancelled' ? [] : shifts.all(r.user_id, r.start_date, r.end_date) })));
  });

  router.post('/leave/:id/decide', requirePerm('leave.manage'), (req, res) => {
    const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(req.params.id));
    if (!r || !manageable(req).some((u) => u.id === r.user_id)) {
      if (r && r.user_id === req.user.id) throw forbidden('Someone else needs to approve your own holiday');
      throw notFound('Holiday request');
    }
    const status = oneOf(req.body.status, 'status', ['approved', 'declined'], { required: true });
    if (r.status !== 'pending' && !(r.status === 'approved' && status === 'declined')) throw badRequest('This request has already been dealt with');
    db.prepare(`UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`)
      .run(status, req.user.id, str(req.body.note, 'note', { max: 500 }), r.id);
    res.json(withDays(db.prepare(`${withNames} WHERE r.id = ?`).get(r.id)));
  });

  // --- Availability ---

  router.get('/availability/mine', (req, res) => {
    res.json({ weekdays: WEEKDAYS, ...(availabilityFor(db, [req.user.id])[req.user.id] ?? { days: {}, note: null }) });
  });

  // days: [{ weekday, status: 'any' | 'some' | 'none', from_time, to_time }]
  router.put('/availability/mine', (req, res) => {
    const days = Array.isArray(req.body.days) ? req.body.days : [];
    const rows = days.map((d) => {
      const weekday = id(Number(d.weekday) + 1, 'weekday', { required: true, max: 7 }) - 1;
      const status = oneOf(d.status, 'status', ['any', 'some', 'none'], { required: true });
      if (status !== 'some') return { weekday, status, from: null, to: null };
      const from = time(d.from_time, `${WEEKDAYS[weekday]} from`, { required: true });
      const to = time(d.to_time, `${WEEKDAYS[weekday]} until`, { required: true });
      if (to <= from) throw badRequest(`${WEEKDAYS[weekday]}: “until” must be after “from”`);
      return { weekday, status, from, to };
    });
    const note = str(req.body.note, 'note', { max: 500 });
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        db.prepare('DELETE FROM availability WHERE user_id = ? AND weekday = ?').run(req.user.id, r.weekday);
        if (r.status !== 'any') db.prepare('INSERT INTO availability (user_id, weekday, status, from_time, to_time) VALUES (?, ?, ?, ?, ?)').run(req.user.id, r.weekday, r.status, r.from, r.to);
      }
      db.prepare('UPDATE users SET availability_note = ? WHERE id = ?').run(note, req.user.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.json({ weekdays: WEEKDAYS, ...(availabilityFor(db, [req.user.id])[req.user.id] ?? { days: {}, note: null }) });
  });

  router.get('/availability', requirePerm('leave.manage'), (req, res) => {
    const people = manageable(req);
    const avail = availabilityFor(db, people.map((u) => u.id));
    const from = today();
    const leave = leaveFor(db, people.map((u) => u.id), from, addDays(from, 27));
    res.json({
      weekdays: WEEKDAYS,
      people: people.map((u) => ({ ...u, ...(avail[u.id] ?? { days: {}, note: null }), holiday: leave.filter((l) => l.user_id === u.id && l.status === 'approved') })),
    });
  });

  // Managers' dashboard: how many holiday requests are waiting.
  router.get('/leave/pending-count', (req, res) => {
    if (!can(req.user, 'leave.manage')) return res.json({ count: 0 });
    const ids = manageable(req).map((u) => u.id);
    res.json({ count: ids.length ? db.prepare(`SELECT COUNT(*) AS n FROM leave_requests WHERE status = 'pending' AND user_id IN (${ids.map(() => '?').join(', ')})`).get(...ids).n : 0 });
  });
}
