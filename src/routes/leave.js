import { can, requirePerm } from '../auth.js';
import { availabilityOn, patternsFor } from '../availability.js';
import { fmtDay, logRota } from '../rota-log.js';
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
    const note = str(req.body.note, 'note', { max: 500 });
    db.prepare(`UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`)
      .run(status, req.user.id, note, r.id);
    // Recorded in Rota → Rota changes, at the person's home site.
    const person = db.prepare('SELECT location_id FROM users WHERE id = ?').get(r.user_id);
    const days = daysBetween(r.start_date, r.end_date);
    const onRota = status === 'approved' ? db.prepare('SELECT COUNT(*) AS n FROM draft_shifts WHERE user_id = ? AND date BETWEEN ? AND ?').get(r.user_id, r.start_date, r.end_date).n : 0;
    logRota(db, req, { action: 'holiday', location_id: person?.location_id ?? null, staff_id: r.user_id, date: r.start_date,
      details: `Holiday ${r.start_date === r.end_date ? fmtDay(r.start_date) : `${fmtDay(r.start_date)} – ${fmtDay(r.end_date)}`} (${days} day${days === 1 ? '' : 's'}) ${r.status === 'approved' && status === 'declined' ? 'cancelled after being approved' : status}${note ? ` – “${note}”` : ''}${onRota ? `; ${onRota} shift${onRota === 1 ? ' is' : 's are'} still on the rota then` : ''}` });
    res.json(withDays(db.prepare(`${withNames} WHERE r.id = ?`).get(r.id)));
  });

  // --- Availability: a calendar of days and repeating patterns (see availability.js) ---

  // Whose availability this person can see and change: their own, and (with leave.manage) the people they look after.
  const targetUser = (req, raw) => {
    const userId = raw === undefined || raw === null || raw === '' ? req.user.id : id(raw, 'user_id', { required: true });
    if (userId !== req.user.id && !(can(req.user, 'leave.manage') && manageable(req).some((u) => u.id === userId))) throw forbidden('You can’t change this person’s availability');
    return db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId) ?? (() => { throw notFound('Staff member'); })();
  };
  // A time range: all day, or from–to (to after from).
  const slotTimes = (b, label) => {
    if (b.all_day) return { all_day: 1, from_time: null, to_time: null };
    const from = time(b.from_time, `${label} from`, { required: true });
    const to = time(b.to_time, `${label} until`, { required: true });
    if (to <= from) throw badRequest(`${label}: “until” must be after “from”`);
    return { all_day: 0, from_time: from, to_time: to };
  };
  const KINDS = ['unavailable', 'available'];

  // The calendar for a person (?user_id=, default you) from ?from to ?to (default this month), their patterns and
  // note, and for managers the people they can choose from.
  router.get('/availability/calendar', (req, res) => {
    const user = targetUser(req, req.query.user_id);
    const from = date(req.query.from, 'from') ?? `${today().slice(0, 8)}01`;
    const to = date(req.query.to, 'to') ?? addDays(from, 41);
    if (to < from || addDays(from, 92) < to) throw badRequest('Choose up to three months');
    const a = availabilityOn(db, [user.id], from, to)[user.id];
    res.json({
      user, from, to, note: a.note, days: a.days,
      patterns: patternsFor(db, [user.id]),
      people: can(req.user, 'leave.manage') ? [{ id: req.user.id, name: req.user.name }, ...manageable(req).map((u) => ({ id: u.id, name: u.name, location_name: u.location_name }))] : null,
    });
  });

  // Adds availability for a day: { user_id?, date, kind, all_day, ranges: [{ from_time, to_time }] }.
  router.post('/availability/days', (req, res) => {
    const user = targetUser(req, req.body.user_id);
    const day = date(req.body.date, 'date', { required: true });
    const kind = oneOf(req.body.kind, 'kind', KINDS, { required: true });
    const ranges = req.body.all_day ? [{ all_day: true }] : (Array.isArray(req.body.ranges) ? req.body.ranges : []);
    if (!ranges.length) throw badRequest('Choose all day, or add the times');
    const rows = ranges.map((r, i) => slotTimes(r, ranges.length > 1 ? `Time ${i + 1}` : 'Time'));
    const ins = db.prepare('INSERT INTO availability_days (user_id, date, kind, all_day, from_time, to_time) VALUES (?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      // All day replaces anything else said for that day.
      if (req.body.all_day) db.prepare('DELETE FROM availability_days WHERE user_id = ? AND date = ?').run(user.id, day);
      else db.prepare('DELETE FROM availability_days WHERE user_id = ? AND date = ? AND all_day = 1').run(user.id, day);
      for (const r of rows) ins.run(user.id, day, kind, r.all_day, r.from_time, r.to_time);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    res.status(201).json(availabilityOn(db, [user.id], day, day)[user.id].days[day] ?? []);
  });

  router.delete('/availability/days/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM availability_days WHERE id = ?').get(Number(req.params.id));
    if (!row) throw notFound('Availability');
    targetUser(req, row.user_id);
    db.prepare('DELETE FROM availability_days WHERE id = ?').run(row.id);
    res.json({ ok: true });
  });

  // Clears what was said for a day, so the pattern (if any) applies again.
  router.post('/availability/days/clear', (req, res) => {
    const user = targetUser(req, req.body.user_id);
    const day = date(req.body.date, 'date', { required: true });
    db.prepare('DELETE FROM availability_days WHERE user_id = ? AND date = ?').run(user.id, day);
    res.json({ ok: true });
  });

  router.put('/availability/note', (req, res) => {
    const user = targetUser(req, req.body.user_id);
    db.prepare('UPDATE users SET availability_note = ? WHERE id = ?').run(str(req.body.note, 'note', { max: 500 }), user.id);
    res.json({ ok: true });
  });

  // A repeating pattern: { user_id?, start_date, end_date?, weeks: 1 | 2 | 4, slots: [{ week, weekday, kind, all_day,
  // from_time, to_time }] }.
  function patternBody(req) {
    const b = req.body ?? {};
    const user = targetUser(req, b.user_id);
    const start = date(b.start_date, 'From', { required: true });
    const end = date(b.end_date, 'To');
    if (end && end < start) throw badRequest('“To” must be after “From”');
    const weeks = Number(b.weeks ?? 1);
    if (![1, 2, 4].includes(weeks)) throw badRequest('Repeat every 1, 2 or 4 weeks');
    const slots = (Array.isArray(b.slots) ? b.slots : []).map((x) => {
      const week = Number(x.week ?? 0);
      const weekday = Number(x.weekday);
      if (!Number.isInteger(week) || week < 0 || week >= weeks) throw badRequest('That week isn’t in the pattern');
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw badRequest('Choose a day of the week');
      return { week, weekday, kind: oneOf(x.kind, 'kind', KINDS, { required: true }), ...slotTimes(x, `Week ${week + 1} ${WEEKDAYS[weekday]}`) };
    });
    if (!slots.length) throw badRequest('Add availability to at least one day of the pattern');
    return { user, start, end, weeks, slots };
  }
  const saveSlots = (patternId, slots) => {
    db.prepare('DELETE FROM availability_pattern_slots WHERE pattern_id = ?').run(patternId);
    const ins = db.prepare('INSERT INTO availability_pattern_slots (pattern_id, week, weekday, kind, all_day, from_time, to_time) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const x of slots) ins.run(patternId, x.week, x.weekday, x.kind, x.all_day, x.from_time, x.to_time);
  };
  const pattern = (req, patternId) => {
    const p = db.prepare('SELECT * FROM availability_patterns WHERE id = ?').get(patternId);
    if (!p) throw notFound('Pattern');
    targetUser(req, p.user_id);
    return p;
  };

  router.post('/availability/patterns', (req, res) => {
    const p = patternBody(req);
    db.exec('BEGIN');
    let patternId;
    try {
      patternId = Number(db.prepare('INSERT INTO availability_patterns (user_id, start_date, end_date, weeks) VALUES (?, ?, ?, ?)').run(p.user.id, p.start, p.end, p.weeks).lastInsertRowid);
      saveSlots(patternId, p.slots);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    res.status(201).json(patternsFor(db, [p.user.id]).find((x) => x.id === patternId));
  });

  router.put('/availability/patterns/:id', (req, res) => {
    const existing = pattern(req, Number(req.params.id));
    const p = patternBody({ ...req, body: { ...req.body, user_id: existing.user_id } });
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE availability_patterns SET start_date = ?, end_date = ?, weeks = ? WHERE id = ?').run(p.start, p.end, p.weeks, existing.id);
      saveSlots(existing.id, p.slots);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    res.json(patternsFor(db, [p.user.id]).find((x) => x.id === existing.id));
  });

  router.delete('/availability/patterns/:id', (req, res) => {
    const p = pattern(req, Number(req.params.id));
    db.prepare('DELETE FROM availability_patterns WHERE id = ?').run(p.id);
    res.json({ ok: true });
  });

  // Managers: everyone's availability for the next two weeks, with approved holiday.
  router.get('/availability', requirePerm('leave.manage'), (req, res) => {
    const people = manageable(req);
    const from = today();
    const to = addDays(from, 13);
    const avail = availabilityOn(db, people.map((u) => u.id), from, to);
    const leave = leaveFor(db, people.map((u) => u.id), from, to);
    res.json({
      from, to,
      people: people.map((u) => ({ ...u, ...avail[u.id], holiday: leave.filter((l) => l.user_id === u.id && l.status === 'approved') })),
    });
  });

  // Managers' dashboard: how many holiday requests are waiting.
  router.get('/leave/pending-count', (req, res) => {
    if (!can(req.user, 'leave.manage')) return res.json({ count: 0 });
    const ids = manageable(req).map((u) => u.id);
    res.json({ count: ids.length ? db.prepare(`SELECT COUNT(*) AS n FROM leave_requests WHERE status = 'pending' AND user_id IN (${ids.map(() => '?').join(', ')})`).get(...ids).n : 0 });
  });
}
