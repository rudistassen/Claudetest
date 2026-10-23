// Swapping shifts: someone asks a colleague to swap one of their published shifts – for one of the colleague's shifts,
// or for nothing (the colleague just covers it). The colleague agrees (or says no), then a manager who approves
// shift requests at the site(s) involved approves it – only then do the shifts change hands on the rota (published
// straight away). Either person can call it off until it's decided.
import { can, requirePerm, siteIdsFor } from '../auth.js';
import { tx } from '../db.js';
import { fmtDay, logRota, shiftText } from '../rota-log.js';
import { onHoliday } from './leave.js';
import { notify, peopleWith } from '../push.js';
import { notStarted } from './shift-drops.js';
import { addDays, badRequest, forbidden, id, notFound, round2, shiftHours, str, today } from '../util.js';

const WEEKS_AHEAD = 6;

export function registerShiftSwapRoutes(router, db, { findClash, clearUndo = () => {} }) {
  const pub = (shiftId) => (shiftId ? db.prepare(`SELECT s.*, l.name AS location_name FROM published_shifts s JOIN locations l ON l.id = s.location_id WHERE s.id = ?`).get(shiftId) : null);
  const userById = (userId) => db.prepare('SELECT id, name, role, location_id, all_sites, active FROM users WHERE id = ?').get(userId);
  const when = (s) => `${fmtDay(s.date)} ${s.start_time}–${s.end_time}`;
  const hours = (s) => round2(shiftHours(s.start_time, s.end_time, s.break_minutes ?? 0));
  const canWorkAt = (user, locationId) => siteIdsFor(db, user).includes(locationId);

  const SELECT = `SELECT w.*, a.name AS from_name, b.name AS to_name, d.name AS decided_by_name FROM shift_swaps w
    JOIN users a ON a.id = w.from_user JOIN users b ON b.id = w.to_user LEFT JOIN users d ON d.id = w.decided_by`;
  const load = (swapId) => {
    const w = db.prepare(`${SELECT} WHERE w.id = ?`).get(Number(swapId));
    if (!w) throw notFound('Swap');
    return w;
  };
  // A swap with both shifts as they were when it was asked for, and as they are now.
  const shape = (w) => {
    const give = { id: w.from_shift_id, date: w.from_date, start_time: w.from_start, end_time: w.from_end, location_id: w.from_location_id, location_name: db.prepare('SELECT name FROM locations WHERE id = ?').get(w.from_location_id)?.name };
    const take = w.to_shift_id ? { id: w.to_shift_id, date: w.to_date, start_time: w.to_start, end_time: w.to_end, location_id: w.to_location_id, location_name: db.prepare('SELECT name FROM locations WHERE id = ?').get(w.to_location_id)?.name } : null;
    return { ...w, give: { ...give, hours: hours({ ...give, break_minutes: pub(w.from_shift_id)?.break_minutes ?? 0 }) }, take: take && { ...take, hours: hours({ ...take, break_minutes: pub(w.to_shift_id)?.break_minutes ?? 0 }) } };
  };
  // Whether each shift is still as it was when the swap was asked for (published, same person, same times).
  const stillAsked = (w) => {
    const a = pub(w.from_shift_id);
    const okA = a && a.user_id === w.from_user && a.date === w.from_date && a.start_time === w.from_start && a.end_time === w.from_end && a.location_id === w.from_location_id;
    if (!w.to_shift_id) return okA;
    const b = pub(w.to_shift_id);
    return okA && b && b.user_id === w.to_user && b.date === w.to_date && b.start_time === w.to_start && b.end_time === w.to_end && b.location_id === w.to_location_id;
  };
  // Why the swap can't go ahead now (null when it can): either person on holiday, or double-booked by it.
  const problem = (w) => {
    if (!stillAsked(w)) return 'One of the shifts has changed on the rota since the swap was asked for';
    if (!notStarted({ date: w.from_date, start_time: w.from_start }) || (w.to_shift_id && !notStarted({ date: w.to_date, start_time: w.to_start }))) return 'One of the shifts has already started';
    if (onHoliday(db, w.to_user, w.from_date)) return `${w.to_name} is on holiday on ${fmtDay(w.from_date)}`;
    const clashB = findClash({ user_id: w.to_user, date: w.from_date, start_time: w.from_start, end_time: w.from_end }, w.to_shift_id ?? 0);
    if (clashB) return `${w.to_name} already has a shift ${clashB.start_time}–${clashB.end_time} at ${clashB.location_name} on ${fmtDay(w.from_date)}`;
    if (w.to_shift_id) {
      if (onHoliday(db, w.from_user, w.to_date)) return `${w.from_name} is on holiday on ${fmtDay(w.to_date)}`;
      const clashA = findClash({ user_id: w.from_user, date: w.to_date, start_time: w.to_start, end_time: w.to_end }, w.from_shift_id);
      if (clashA) return `${w.from_name} already has a shift ${clashA.start_time}–${clashA.end_time} at ${clashA.location_name} on ${fmtDay(w.to_date)}`;
    }
    return null;
  };
  // Managers who approve shift requests at every site the swap touches.
  const sitesOf = (w) => [...new Set([w.from_location_id, w.to_location_id].filter(Boolean))];
  // (Not a swap they're part of themselves – another manager, or an admin, approves that.)
  const approves = (req, w) => can(req.user, 'rota.approve') && sitesOf(w).every((s) => req.user.site_ids.includes(s))
    && (req.user.role === 'admin' || (w.from_user !== req.user.id && w.to_user !== req.user.id));
  const managersFor = (w) => {
    const [first, ...rest] = sitesOf(w);
    return peopleWith(db, ['rota.approve'], first).filter((u) => rest.every((s) => peopleWith(db, ['rota.approve'], s).includes(u)));
  };

  /**
   * Who a shift could be swapped with, and what with: colleagues who can work at its site (not on holiday that day),
   * each with their published shifts in the next few weeks at sites the person asking can work at.
   */
  router.get('/swaps/options', (req, res) => {
    const s = pub(id(req.query.shift_id, 'shift_id', { required: true }));
    if (!s || s.user_id !== req.user.id) throw notFound('Shift');
    if (!notStarted(s)) throw badRequest('This shift has already started');
    const mine = siteIdsFor(db, req.user);
    const people = db.prepare(`SELECT id, name, role, location_id, all_sites FROM users WHERE active = 1 AND id != ? AND role != 'admin' ORDER BY name`).all(req.user.id)
      .filter((u) => canWorkAt(u, s.location_id) && !onHoliday(db, u.id, s.date));
    const theirShifts = db.prepare(`SELECT s.id, s.date, s.start_time, s.end_time, s.break_minutes, s.location_id, l.name AS location_name FROM published_shifts s
      JOIN locations l ON l.id = s.location_id WHERE s.user_id = ? AND s.date BETWEEN ? AND ? AND s.sick = 0 ORDER BY s.date, s.start_time`);
    res.json({
      shift: { ...s, hours: hours(s) },
      people: people.map((u) => ({
        id: u.id,
        name: u.name,
        location_name: db.prepare('SELECT name FROM locations WHERE id = ?').get(u.location_id)?.name ?? null,
        // Already working then (they'd be double-booked unless they give that shift back) – and that shift, which is
        // the one to swap with (e.g. they open at 6am and you start at 9am: you do the open, they come in at 9).
        busy: !!findClash({ user_id: u.id, date: s.date, start_time: s.start_time, end_time: s.end_time }),
        clash: findClash({ user_id: u.id, date: s.date, start_time: s.start_time, end_time: s.end_time })?.id ?? null,
        shifts: theirShifts.all(u.id, today(), addDays(today(), WEEKS_AHEAD * 7)).filter((x) => notStarted(x) && mine.includes(x.location_id)).map((x) => ({ ...x, hours: hours(x) })),
      })),
    });
  });

  // Everything about swaps for this person: ones they've asked for, ones asked of them, and ones for them to approve.
  router.get('/swaps', (req, res) => {
    const live = `w.status IN ('asked', 'pending', 'approved', 'declined', 'refused') AND (w.from_date >= ? OR w.to_date >= ?)`;
    const mine = db.prepare(`${SELECT} WHERE w.from_user = ? AND ${live} ORDER BY w.from_date`).all(req.user.id, today(), today()).map(shape);
    const forMe = db.prepare(`${SELECT} WHERE w.to_user = ? AND ${live} ORDER BY w.from_date`).all(req.user.id, today(), today()).map(shape);
    const toApprove = can(req.user, 'rota.approve')
      ? db.prepare(`${SELECT} WHERE w.status = 'pending' ORDER BY w.from_date`).all().filter((w) => approves(req, w)).map((w) => ({ ...shape(w), problem: problem(w) }))
      : [];
    res.json({ mine, for_me: forMe, to_approve: toApprove });
  });

  // Ask to swap: { shift_id (yours), to_user_id, to_shift_id (theirs – or none, for them to cover it), note }.
  router.post('/swaps', (req, res) => {
    const b = req.body ?? {};
    const give = pub(id(b.shift_id, 'shift_id', { required: true }));
    if (!give || give.user_id !== req.user.id) throw notFound('Shift');
    if (!notStarted(give)) throw badRequest('This shift has already started');
    const other = userById(id(b.to_user_id, 'to_user_id', { required: true }));
    if (!other || !other.active || other.id === req.user.id) throw notFound('Person');
    if (!canWorkAt(other, give.location_id)) throw badRequest(`${other.name} doesn’t work at ${give.location_name}`);
    const take = b.to_shift_id ? pub(id(b.to_shift_id, 'to_shift_id')) : null;
    if (b.to_shift_id && (!take || take.user_id !== other.id)) throw notFound('Their shift');
    if (take && !notStarted(take)) throw badRequest('Their shift has already started');
    if (take && !canWorkAt(req.user, take.location_id)) throw badRequest(`You don’t work at ${take.location_name}`);
    // Covering: they can't already be working then.
    if (!take) {
      if (onHoliday(db, other.id, give.date)) throw badRequest(`${other.name} is on holiday then`);
      const busy = findClash({ user_id: other.id, date: give.date, start_time: give.start_time, end_time: give.end_time });
      if (busy) throw badRequest(`${other.name} is already working ${busy.start_time}–${busy.end_time} that day – ask them to swap instead`);
    }
    const open = db.prepare(`SELECT 1 FROM shift_swaps WHERE status IN ('asked', 'pending') AND (from_shift_id IN (?, ?) OR to_shift_id IN (?, ?))`)
      .get(give.id, take?.id ?? -1, give.id, take?.id ?? -1);
    if (open) throw badRequest('One of these shifts is already part of a swap that hasn’t been decided yet');
    const r = db.prepare(`INSERT INTO shift_swaps (from_user, from_shift_id, from_date, from_start, from_end, from_location_id, to_user, to_shift_id, to_date, to_start, to_end, to_location_id, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, give.id, give.date, give.start_time, give.end_time, give.location_id,
      other.id, take?.id ?? null, take?.date ?? null, take?.start_time ?? null, take?.end_time ?? null, take?.location_id ?? null, str(b.note, 'note', { max: 500 }));
    const w = load(r.lastInsertRowid);
    notify(db, [other.id], 'swap_asked', {
      title: `${req.user.name} wants to swap a shift`,
      body: take ? `Your ${when(take)} for their ${when(give)} at ${give.location_name}` : `Can you cover ${when(give)} at ${give.location_name}?`,
      url: `/#/rota?view=mine&week=${give.date}`,
      tag: `swap-${w.id}`,
    });
    res.status(201).json(shape(w));
  });

  // The colleague agrees: it goes to a manager to approve.
  router.post('/swaps/:id/accept', (req, res) => {
    const w = load(req.params.id);
    if (w.to_user !== req.user.id) throw notFound('Swap');
    if (w.status !== 'asked') throw badRequest('This swap has already been answered');
    const why = problem(w);
    if (why) throw badRequest(why);
    db.prepare(`UPDATE shift_swaps SET status = 'pending', answered_at = datetime('now') WHERE id = ?`).run(w.id);
    const done = load(w.id);
    notify(db, managersFor(done).filter((u) => u !== w.from_user && u !== w.to_user), 'swap_request', {
      title: 'Shift swap to approve',
      body: done.to_shift_id ? `${done.from_name} and ${done.to_name} want to swap ${when({ date: done.from_date, start_time: done.from_start, end_time: done.from_end })} and ${when({ date: done.to_date, start_time: done.to_start, end_time: done.to_end })}`
        : `${done.to_name} will cover ${done.from_name}’s ${when({ date: done.from_date, start_time: done.from_start, end_time: done.from_end })}`,
      url: '/#/rota/requests',
      tag: `swap-${w.id}`,
    });
    notify(db, [w.from_user], 'drop_decision', { title: `${w.to_name} agreed to swap`, body: 'Now waiting for a manager to approve it', url: `/#/rota?view=mine&week=${w.from_date}` });
    res.json(shape(done));
  });

  // The colleague says no.
  router.post('/swaps/:id/refuse', (req, res) => {
    const w = load(req.params.id);
    if (w.to_user !== req.user.id) throw notFound('Swap');
    if (w.status !== 'asked') throw badRequest('This swap has already been answered');
    db.prepare(`UPDATE shift_swaps SET status = 'refused', answered_at = datetime('now') WHERE id = ?`).run(w.id);
    notify(db, [w.from_user], 'drop_decision', { title: `${w.to_name} can’t swap`, body: `Your ${when({ date: w.from_date, start_time: w.from_start, end_time: w.from_end })} is still yours`, url: `/#/rota?view=mine&week=${w.from_date}` });
    res.json(shape(load(w.id)));
  });

  // Either person calls it off before it's decided.
  router.post('/swaps/:id/cancel', (req, res) => {
    const w = load(req.params.id);
    if (w.from_user !== req.user.id && w.to_user !== req.user.id) throw notFound('Swap');
    if (!['asked', 'pending'].includes(w.status)) throw badRequest('This swap has already been decided');
    db.prepare(`UPDATE shift_swaps SET status = 'cancelled' WHERE id = ?`).run(w.id);
    const otherId = w.from_user === req.user.id ? w.to_user : w.from_user;
    notify(db, [otherId], 'drop_decision', { title: 'Shift swap called off', body: `${req.user.name} has called off the swap – your shifts stay as they are`, url: `/#/rota?view=mine&week=${w.from_date}` });
    res.json({ ok: true });
  });

  // A manager approves: the shifts change hands on the rota, published straight away.
  router.post('/swaps/:id/approve', requirePerm('rota.approve'), (req, res) => {
    const w = load(req.params.id);
    if (!approves(req, w)) throw forbidden('You can only approve swaps at sites you look after');
    if (w.status !== 'pending') throw badRequest(w.status === 'asked' ? `${w.to_name} hasn’t agreed to it yet` : 'This swap has already been decided');
    const why = problem(w);
    if (why) throw badRequest(why);
    clearUndo(req);
    // Moves one published shift to someone else, in the draft and as published (so it shows straight away). Each
    // of them asked for this, so it counts as confirmed.
    const move = (shiftId, toUser) => db.prepare(`UPDATE shifts SET user_id = ?, pub_user_id = ?, ack_at = datetime('now') WHERE id = ?`).run(toUser, toUser, shiftId);
    tx(db, () => {
      move(w.from_shift_id, w.to_user);
      if (w.to_shift_id) move(w.to_shift_id, w.from_user);
      db.prepare(`UPDATE shift_swaps SET status = 'approved', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`)
        .run(req.user.id, str(req.body?.note, 'note', { max: 500 }), w.id);
      const a = { date: w.from_date, start_time: w.from_start, end_time: w.from_end, break_minutes: pub(w.from_shift_id)?.break_minutes ?? 0 };
      logRota(db, req, { action: 'swap', location_id: w.from_location_id, shift: { ...a, id: w.from_shift_id, user_id: w.to_user },
        details: `${shiftText(a)} — swapped from ${w.from_name} to ${w.to_name}${w.to_shift_id ? '' : ' (covering)'}` });
      if (w.to_shift_id) {
        const b = { date: w.to_date, start_time: w.to_start, end_time: w.to_end, break_minutes: pub(w.to_shift_id)?.break_minutes ?? 0 };
        logRota(db, req, { action: 'swap', location_id: w.to_location_id, shift: { ...b, id: w.to_shift_id, user_id: w.from_user },
          details: `${shiftText(b)} — swapped from ${w.to_name} to ${w.from_name}` });
      }
    });
    notify(db, [w.from_user, w.to_user], 'drop_decision', { title: 'Shift swap approved ✓', body: 'Your rota has been updated – tap to see your shifts', url: `/#/rota?view=mine&week=${w.from_date}` });
    res.json(shape(load(w.id)));
  });

  router.post('/swaps/:id/decline', requirePerm('rota.approve'), (req, res) => {
    const w = load(req.params.id);
    if (!approves(req, w)) throw forbidden('You can only decide swaps at sites you look after');
    if (!['asked', 'pending'].includes(w.status)) throw badRequest('This swap has already been decided');
    const note = str(req.body?.note, 'note', { max: 500 });
    db.prepare(`UPDATE shift_swaps SET status = 'declined', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`).run(req.user.id, note, w.id);
    notify(db, [w.from_user, w.to_user], 'drop_decision', { title: 'Shift swap declined', body: `Your shifts stay as they are${note ? ` – “${note}”` : ''}`, url: `/#/rota?view=mine&week=${w.from_date}` });
    res.json(shape(load(w.id)));
  });
}
