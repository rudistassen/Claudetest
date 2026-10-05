// Dropping shifts: staff ask to drop one of their published shifts; someone who can publish the rota at that site
// approves (the shift comes off their rota and becomes an open shift there) or declines (it stays theirs). Anyone
// who works at the site can then claim an open shift, which puts it straight onto their published rota.
import { assertLocation, can, requirePerm } from '../auth.js';
import { tx } from '../db.js';
import { logRota, shiftText } from '../rota-log.js';
import { onHoliday } from './leave.js';
import { badRequest, forbidden, notFound, round2, shiftHours, str, today } from '../util.js';

const nowTime = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
// A shift that hasn't started yet (today's only once its start time has passed).
export const notStarted = (s) => s.date > today() || (s.date === today() && s.start_time > nowTime());

const SELECT = `SELECT d.*, l.name AS location_name, u.name AS dropped_by_name, a.name AS decided_by_name, c.name AS claimed_by_name
  FROM shift_drops d JOIN locations l ON l.id = d.location_id JOIN users u ON u.id = d.dropped_by
  LEFT JOIN users a ON a.id = d.decided_by LEFT JOIN users c ON c.id = d.claimed_by`;

export function registerShiftDropRoutes(router, db, { findClash }) {
  const withHours = (d) => ({ ...d, hours: round2(shiftHours(d.start_time, d.end_time, d.break_minutes)) });
  const load = (id) => {
    const d = db.prepare(`${SELECT} WHERE d.id = ?`).get(Number(id));
    if (!d) throw notFound('Shift');
    return d;
  };
  const approver = (req, locationId) => can(req.user, 'rota.publish') && req.user.site_ids.includes(locationId);

  // Why someone can't claim an open shift (null when they can).
  function claimProblem(user, d) {
    if (!user.site_ids.includes(d.location_id)) return `You don’t work at ${d.location_name}`;
    if (!notStarted(d)) return 'This shift has already started';
    if (onHoliday(db, user.id, d.date)) return 'You’re on holiday that day';
    const clash = findClash({ user_id: user.id, date: d.date, start_time: d.start_time, end_time: d.end_time });
    if (clash) return `You already have a shift ${clash.start_time}–${clash.end_time} at ${clash.location_name} that day`;
    return null;
  }

  /**
   * Everything about dropped shifts for this person: open shifts they could pick up at their sites, drop requests
   * waiting for them to approve (if they can publish the rota), and their own recent requests.
   */
  router.get('/shift-drops', (req, res) => {
    const sites = req.user.site_ids;
    const inList = sites.map(() => '?').join(', ') || 'NULL';
    const open = db.prepare(`${SELECT} WHERE d.status = 'open' AND d.date >= ? AND d.location_id IN (${inList}) ORDER BY d.date, d.start_time`)
      .all(today(), ...sites).filter(notStarted)
      .map((d) => {
        const problem = claimProblem(req.user, d);
        return { ...withHours(d), can_claim: !problem, claim_problem: problem, can_withdraw: approver(req, d.location_id) };
      });
    const toApprove = can(req.user, 'rota.publish')
      ? db.prepare(`${SELECT} WHERE d.status = 'pending' AND d.date >= ? AND d.location_id IN (${inList}) ORDER BY d.date, d.start_time`).all(today(), ...sites).map(withHours)
      : [];
    const mine = db.prepare(`${SELECT} WHERE d.dropped_by = ? AND d.date >= ? AND d.status != 'cancelled' ORDER BY d.date, d.start_time`)
      .all(req.user.id, today()).map(withHours);
    res.json({ open, to_approve: toApprove, mine });
  });

  // Ask to drop one of your own published shifts.
  router.post('/shifts/:id/drop', (req, res) => {
    const s = db.prepare('SELECT * FROM published_shifts WHERE id = ?').get(Number(req.params.id));
    if (!s || s.user_id !== req.user.id) throw notFound('Shift');
    if (!notStarted(s)) throw badRequest('This shift has already started, so it can’t be dropped');
    if (db.prepare(`SELECT 1 FROM shift_drops WHERE shift_id = ? AND status = 'pending'`).get(s.id)) throw badRequest('You’ve already asked to drop this shift');
    const reason = str(req.body?.reason, 'reason', { max: 500 });
    const r = db.prepare(`INSERT INTO shift_drops (shift_id, location_id, date, start_time, end_time, break_minutes, position, notes, dropped_by, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.id, s.location_id, s.date, s.start_time, s.end_time, s.break_minutes, s.position, s.notes, req.user.id, reason);
    res.status(201).json(withHours(load(r.lastInsertRowid)));
  });

  // Take back a request to drop a shift before it's been dealt with.
  router.post('/shift-drops/:id/cancel', (req, res) => {
    const d = load(req.params.id);
    if (d.dropped_by !== req.user.id) throw notFound('Shift');
    if (d.status !== 'pending') throw badRequest('This request has already been dealt with');
    db.prepare(`UPDATE shift_drops SET status = 'cancelled' WHERE id = ?`).run(d.id);
    res.json({ ok: true });
  });

  // Approve: the shift comes off the person's rota (draft and published) and becomes an open shift at the site.
  router.post('/shift-drops/:id/approve', requirePerm('rota.publish'), (req, res) => {
    const d = load(req.params.id);
    assertLocation(req, d.location_id);
    if (d.status !== 'pending') throw badRequest('This request has already been dealt with');
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(d.shift_id);
    const unchanged = shift && shift.pub_user_id === d.dropped_by && shift.pub_location_id === d.location_id && shift.pub_date === d.date
      && shift.pub_start_time === d.start_time && shift.pub_end_time === d.end_time;
    if (!unchanged) {
      db.prepare(`UPDATE shift_drops SET status = 'cancelled', decided_by = ?, decided_at = datetime('now'), decision_note = 'The shift had changed' WHERE id = ?`).run(req.user.id, d.id);
      throw badRequest(`${d.dropped_by_name}’s shift has changed on the rota since they asked to drop it, so the request has been closed.`);
    }
    if (!notStarted(d)) throw badRequest('This shift has already started');
    tx(db, () => {
      db.prepare('DELETE FROM shifts WHERE id = ?').run(shift.id);
      db.prepare(`UPDATE shift_drops SET status = 'open', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`)
        .run(req.user.id, str(req.body?.note, 'note', { max: 500 }), d.id);
      logRota(db, req, { action: 'drop', location_id: d.location_id, shift: { ...d, id: shift.id, user_id: d.dropped_by },
        details: `${shiftText(d)} — dropped by ${d.dropped_by_name}${d.reason ? ` (“${d.reason}”)` : ''}; now an open shift` });
    });
    res.json(withHours(load(d.id)));
  });

  router.post('/shift-drops/:id/decline', requirePerm('rota.publish'), (req, res) => {
    const d = load(req.params.id);
    assertLocation(req, d.location_id);
    if (d.status !== 'pending') throw badRequest('This request has already been dealt with');
    db.prepare(`UPDATE shift_drops SET status = 'declined', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`)
      .run(req.user.id, str(req.body?.note, 'note', { max: 500 }), d.id);
    res.json(withHours(load(d.id)));
  });

  // Claim an open shift: it goes straight onto your published rota. First come, first served.
  router.post('/shift-drops/:id/claim', (req, res) => {
    const d = load(req.params.id);
    if (!req.user.site_ids.includes(d.location_id)) throw notFound('Shift');
    if (d.status !== 'open') throw badRequest(d.status === 'claimed' ? `Sorry – ${d.claimed_by_name} has already picked up this shift` : 'This shift isn’t open any more');
    const problem = claimProblem(req.user, d);
    if (problem) throw badRequest(problem);
    const shiftId = tx(db, () => {
      const ins = db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes, position, notes,
        pub_location_id, pub_user_id, pub_date, pub_start_time, pub_end_time, pub_break_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(d.location_id, req.user.id, d.date, d.start_time, d.end_time, d.break_minutes, d.position, d.notes,
          d.location_id, req.user.id, d.date, d.start_time, d.end_time, d.break_minutes);
      const taken = db.prepare(`UPDATE shift_drops SET status = 'claimed', claimed_by = ?, claimed_at = datetime('now'), claimed_shift_id = ? WHERE id = ? AND status = 'open'`)
        .run(req.user.id, ins.lastInsertRowid, d.id);
      if (!taken.changes) throw badRequest('Sorry – someone else has just picked up this shift');
      logRota(db, req, { action: 'claim', location_id: d.location_id, shift: { ...d, id: ins.lastInsertRowid, user_id: req.user.id },
        details: `${shiftText(d)} — open shift picked up by ${req.user.name}` });
      return ins.lastInsertRowid;
    });
    res.json({ ...withHours(load(d.id)), shift_id: shiftId });
  });

  // A manager takes an open shift away (it's no longer needed, or they've covered it another way).
  router.post('/shift-drops/:id/withdraw', requirePerm('rota.publish'), (req, res) => {
    const d = load(req.params.id);
    assertLocation(req, d.location_id);
    if (d.status !== 'open') throw badRequest('This shift isn’t open any more');
    if (!approver(req, d.location_id)) throw forbidden();
    tx(db, () => {
      db.prepare(`UPDATE shift_drops SET status = 'withdrawn' WHERE id = ?`).run(d.id);
      logRota(db, req, { action: 'withdraw', location_id: d.location_id, details: `Open shift ${shiftText(d)} withdrawn – no longer needed` });
    });
    res.json({ ok: true });
  });
}

/** Open shifts and pending drop requests for the rota page: { open: [...], pending_shift_ids: [...] }. */
export function rotaDrops(db, locationIds, from, to) {
  if (!locationIds.length) return { open: [], pending_shift_ids: [] };
  const inList = locationIds.map(() => '?').join(', ');
  const open = db.prepare(`${SELECT} WHERE d.status = 'open' AND d.location_id IN (${inList}) AND d.date BETWEEN ? AND ? AND d.date >= ? ORDER BY d.date, d.start_time`)
    .all(...locationIds, from, to, today()).filter(notStarted)
    .map((d) => ({ ...d, hours: round2(shiftHours(d.start_time, d.end_time, d.break_minutes)) }));
  const pending = db.prepare(`SELECT shift_id FROM shift_drops WHERE status = 'pending' AND location_id IN (${inList}) AND date BETWEEN ? AND ?`)
    .all(...locationIds, from, to).map((r) => r.shift_id);
  return { open, pending_shift_ids: pending };
}

