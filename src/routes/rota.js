import { assertLocation, isManager, requireManager, resolveLocation } from '../auth.js';
import { tx } from '../db.js';
import { dayKey, labourByDay, pct, salesByDay } from '../metrics.js';
import { addDays, badRequest, date, id, notFound, num, round2, shiftHours, str, time, today, weekStart } from '../util.js';

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function range(s) {
  const start = toMin(s.start_time);
  let end = toMin(s.end_time);
  if (end <= start) end += 24 * 60;
  return [start, end];
}

export function registerRotaRoutes(router, db) {
  const shiftSelect = `
    SELECT s.*, u.name AS user_name, l.name AS location_name
    FROM shifts s JOIN users u ON u.id = s.user_id JOIN locations l ON l.id = s.location_id`;

  function findClash(shift, ignoreId = 0) {
    const others = db.prepare(`${shiftSelect} WHERE s.user_id = ? AND s.date = ? AND s.id != ?`)
      .all(shift.user_id, shift.date, ignoreId);
    const [a1, a2] = range(shift);
    return others.find((o) => {
      const [b1, b2] = range(o);
      return a1 < b2 && b1 < a2;
    });
  }

  function shiftBody(req) {
    const b = req.body;
    const s = {
      location_id: resolveLocation(req, b.location_id),
      user_id: id(b.user_id, 'user_id', { required: true }),
      date: date(b.date, 'date', { required: true }),
      start_time: time(b.start_time, 'start_time', { required: true }),
      end_time: time(b.end_time, 'end_time', { required: true }),
      break_minutes: num(b.break_minutes, 'break_minutes', { min: 0, max: 600, int: true }) ?? 0,
      position: str(b.position, 'position', { max: 100 }),
      notes: str(b.notes, 'notes'),
    };
    if (s.start_time === s.end_time) throw badRequest('Shift start and end cannot be the same');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(s.user_id)) throw notFound('Staff member');
    return s;
  }

  function assertNoClash(s, ignoreId) {
    const clash = findClash(s, ignoreId);
    if (clash) {
      throw badRequest(`${clash.user_name} already has a shift ${clash.start_time}–${clash.end_time} at ${clash.location_name} on ${clash.date}`);
    }
  }

  // location_id=all (admins only) shows every site at once.
  function rotaSites(req, raw) {
    if (raw === 'all') {
      if (req.user.role !== 'admin') throw badRequest('Only admins can see every site at once');
      return db.prepare('SELECT id FROM locations WHERE active = 1 ORDER BY name').all().map((l) => l.id);
    }
    return [resolveLocation(req, raw)];
  }

  router.get('/rota', (req, res) => {
    const all = req.query.location_id === 'all';
    const ids = rotaSites(req, req.query.location_id);
    const ws = weekStart(date(req.query.week, 'week') ?? today());
    const we = addDays(ws, 6);
    const manager = isManager(req.user);
    const inList = ids.map(() => '?').join(', ') || 'NULL';

    const shifts = db.prepare(`${shiftSelect} WHERE s.location_id IN (${inList}) AND s.date BETWEEN ? AND ? ORDER BY s.date, s.start_time`)
      .all(...ids, ws, we);
    const staff = db.prepare(`
      SELECT u.id, u.name, u.position, u.role, u.hourly_rate, u.location_id, l.name AS location_name FROM users u
      LEFT JOIN locations l ON l.id = u.location_id
      WHERE (u.location_id IN (${inList}) AND u.active = 1) OR u.id IN (SELECT user_id FROM shifts WHERE location_id IN (${inList}) AND date BETWEEN ? AND ?)
      ORDER BY ${all ? "l.name IS NULL, l.name, " : ''}CASE u.role WHEN 'manager' THEN 0 ELSE 1 END, u.name`).all(...ids, ...ids, ws, we);
    // On a single site's rota, the same people's shifts at other sites that week, so it's clear when they're not free.
    const staffIds = staff.map((u) => u.id);
    const away = all || !staffIds.length ? [] : db.prepare(`${shiftSelect}
      WHERE s.user_id IN (${staffIds.map(() => '?').join(', ')}) AND s.location_id NOT IN (${inList}) AND s.date BETWEEN ? AND ? ORDER BY s.date, s.start_time`)
      .all(...staffIds, ...ids, ws, we);

    const rates = new Map(staff.map((u) => [u.id, u.hourly_rate]));
    const byUser = {};
    let totalHours = 0;
    let totalCost = 0;
    for (const s of shifts) {
      s.hours = round2(shiftHours(s.start_time, s.end_time, s.break_minutes));
      byUser[s.user_id] = round2((byUser[s.user_id] ?? 0) + s.hours);
      totalHours += s.hours;
      totalCost += s.hours * (rates.get(s.user_id) ?? 0);
    }
    for (const s of away) s.hours = round2(shiftHours(s.start_time, s.end_time, s.break_minutes));
    if (!manager) for (const u of staff) delete u.hourly_rate;

    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    let money;
    if (manager) {
      const sales = salesByDay(db, ids, ws, we);
      const planned = labourByDay(db, ids, ws, we);
      const worked = labourByDay(db, ids, ws, we, { toDate: true });
      money = days.map((d) => {
        // Across sites, labour % only counts sites that have sales that day (as on the Sales page).
        let net = null;
        let plannedCost = 0;
        let workedCost = 0;
        for (const l of ids) {
          const k = dayKey(l, d);
          plannedCost += planned.get(k) ?? 0;
          const siteNet = sales.get(k)?.net_sales;
          if (siteNet === undefined) continue;
          net = (net ?? 0) + siteNet;
          workedCost += worked.get(k) ?? 0;
        }
        return {
          date: d,
          net_sales: net === null ? null : round2(net),
          labour_cost: round2(plannedCost),
          worked_cost: workedCost,
          labour_pct: net === null || !workedCost ? null : pct(workedCost, net),
        };
      });
    }
    const salesDays = money?.filter((m) => m.net_sales !== null && m.worked_cost > 0) ?? [];
    const weekSales = salesDays.reduce((s, m) => s + m.net_sales, 0);
    const weekWorked = salesDays.reduce((s, m) => s + m.worked_cost, 0);
    for (const m of money ?? []) delete m.worked_cost;

    res.json({
      location_id: all ? 'all' : ids[0],
      week_start: ws,
      days,
      daily_money: money,
      week_sales: manager ? round2(weekSales) : undefined,
      labour_pct: manager ? pct(weekWorked, weekSales) : undefined,
      staff,
      shifts,
      away_shifts: away,
      hours_by_user: byUser,
      total_hours: round2(totalHours),
      labour_cost: manager ? round2(totalCost) : undefined,
    });
  });

  router.get('/my-shifts', (req, res) => {
    const from = today();
    res.json(db.prepare(`${shiftSelect} WHERE s.user_id = ? AND s.date BETWEEN ? AND ? ORDER BY s.date, s.start_time`)
      .all(req.user.id, from, addDays(from, 13)));
  });

  router.post('/shifts', requireManager, (req, res) => {
    const s = shiftBody(req);
    assertNoClash(s, 0);
    const r = db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes, position, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.location_id, s.user_id, s.date, s.start_time, s.end_time, s.break_minutes, s.position, s.notes);
    res.status(201).json(db.prepare(`${shiftSelect} WHERE s.id = ?`).get(r.lastInsertRowid));
  });

  function loadShift(req) {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(req.params.id));
    if (!shift) throw notFound('Shift');
    assertLocation(req, shift.location_id);
    return shift;
  }

  router.put('/shifts/:id', requireManager, (req, res) => {
    const existing = loadShift(req);
    const s = shiftBody(req);
    assertNoClash(s, existing.id);
    db.prepare(`UPDATE shifts SET location_id = ?, user_id = ?, date = ?, start_time = ?, end_time = ?, break_minutes = ?, position = ?, notes = ? WHERE id = ?`)
      .run(s.location_id, s.user_id, s.date, s.start_time, s.end_time, s.break_minutes, s.position, s.notes, existing.id);
    res.json(db.prepare(`${shiftSelect} WHERE s.id = ?`).get(existing.id));
  });

  router.delete('/shifts/:id', requireManager, (req, res) => {
    const shift = loadShift(req);
    db.prepare('DELETE FROM shifts WHERE id = ?').run(shift.id);
    res.json({ ok: true });
  });

  // Copies one week's shifts onto another, skipping any that would double-book someone.
  router.post('/rota/copy-week', requireManager, (req, res) => {
    const ids = rotaSites(req, req.body.location_id);
    const from = weekStart(date(req.body.from_week, 'from_week', { required: true }));
    const to = weekStart(date(req.body.to_week, 'to_week', { required: true }));
    if (from === to) throw badRequest('Choose a different week to copy to');
    const offset = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

    const result = tx(db, () => {
      const inList = ids.map(() => '?').join(', ') || 'NULL';
      if (req.body.replace) {
        db.prepare(`DELETE FROM shifts WHERE location_id IN (${inList}) AND date BETWEEN ? AND ?`).run(...ids, to, addDays(to, 6));
      }
      const source = db.prepare(`SELECT s.* FROM shifts s JOIN users u ON u.id = s.user_id
        WHERE s.location_id IN (${inList}) AND s.date BETWEEN ? AND ? AND u.active = 1 ORDER BY s.date, s.start_time`).all(...ids, from, addDays(from, 6));
      const insert = db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes, position, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      let copied = 0;
      let skipped = 0;
      for (const s of source) {
        const next = { ...s, date: addDays(s.date, offset) };
        if (findClash(next, 0)) { skipped++; continue; }
        insert.run(s.location_id, s.user_id, next.date, s.start_time, s.end_time, s.break_minutes, s.position, s.notes);
        copied++;
      }
      return { copied, skipped };
    });
    res.json(result);
  });
}
