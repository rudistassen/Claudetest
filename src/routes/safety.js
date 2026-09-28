import { assertLocation, isManager, requireManager, resolveLocation } from '../auth.js';
import { labourByDay, pct } from '../metrics.js';
import { addDays, badRequest, bool, date, forbidden, id, notFound, num, oneOf, round2, str, today, weekStart } from '../util.js';

const MAX_REPORT_DAYS = 92;

export function registerSafetyRoutes(router, db) {
  const tasksFor = db.prepare(`SELECT * FROM safety_tasks WHERE active = 1 AND (location_id IS NULL OR location_id = ?)
    ORDER BY frequency, sort_order, title`);

  // --- Task templates ---

  router.get('/safety/tasks', (req, res) => {
    const rows = req.user.role === 'admin'
      ? db.prepare(`SELECT t.*, l.name AS location_name FROM safety_tasks t LEFT JOIN locations l ON l.id = t.location_id
          ORDER BY t.active DESC, t.frequency, t.sort_order, t.title`).all()
      : db.prepare(`SELECT t.*, l.name AS location_name FROM safety_tasks t LEFT JOIN locations l ON l.id = t.location_id
          WHERE t.location_id IS NULL OR t.location_id = ? ORDER BY t.active DESC, t.frequency, t.sort_order, t.title`)
        .all(req.user.location_id);
    res.json(rows);
  });

  function taskBody(req) {
    const b = req.body;
    const t = {
      title: str(b.title, 'title', { required: true, max: 150 }),
      description: str(b.description, 'description', { max: 1000 }),
      category: str(b.category, 'category', { max: 100 }) ?? 'General',
      frequency: oneOf(b.frequency, 'frequency', ['daily', 'weekly'], { required: true }),
      location_id: id(b.location_id, 'location_id'),
      requires_reading: bool(b.requires_reading),
      reading_unit: str(b.reading_unit, 'reading_unit', { max: 20 }),
      min_value: num(b.min_value, 'min_value'),
      max_value: num(b.max_value, 'max_value'),
      sort_order: num(b.sort_order, 'sort_order', { int: true }) ?? 0,
      active: b.active === undefined ? 1 : bool(b.active),
    };
    if (t.location_id) assertLocation(req, t.location_id);
    else if (req.user.role !== 'admin') throw forbidden('Only admins can create tasks for every location');
    if (t.min_value !== null && t.max_value !== null && t.min_value > t.max_value) throw badRequest('min_value must not exceed max_value');
    if (!t.requires_reading) t.reading_unit = t.min_value = t.max_value = null;
    return t;
  }
  const taskCols = ['title', 'description', 'category', 'frequency', 'location_id', 'requires_reading', 'reading_unit', 'min_value', 'max_value', 'sort_order', 'active'];

  router.post('/safety/tasks', requireManager, (req, res) => {
    const t = taskBody(req);
    const r = db.prepare(`INSERT INTO safety_tasks (${taskCols.join(', ')}) VALUES (${taskCols.map(() => '?').join(', ')})`)
      .run(...taskCols.map((c) => t[c]));
    res.status(201).json(db.prepare('SELECT * FROM safety_tasks WHERE id = ?').get(r.lastInsertRowid));
  });

  router.put('/safety/tasks/:id', requireManager, (req, res) => {
    const existing = db.prepare('SELECT * FROM safety_tasks WHERE id = ?').get(Number(req.params.id));
    if (!existing) throw notFound('Task');
    if (existing.location_id) assertLocation(req, existing.location_id);
    else if (req.user.role !== 'admin') throw forbidden('Only admins can edit tasks shared by every location');
    const t = taskBody(req);
    db.prepare(`UPDATE safety_tasks SET ${taskCols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...taskCols.map((c) => t[c]), existing.id);
    res.json(db.prepare('SELECT * FROM safety_tasks WHERE id = ?').get(existing.id));
  });

  // --- Checklists ---

  router.get('/safety/checklist', (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    const d = date(req.query.date, 'date') ?? today();
    const ws = weekStart(d);
    const checks = db.prepare(`SELECT c.*, u.name AS completed_by_name FROM safety_checks c LEFT JOIN users u ON u.id = c.completed_by
      WHERE c.location_id = ? AND c.period IN (?, ?)`).all(locationId, d, ws);
    const tasks = tasksFor.all(locationId).map((t) => {
      const period = t.frequency === 'daily' ? d : ws;
      return { ...t, check: checks.find((c) => c.task_id === t.id && c.period === period) ?? null };
    });
    res.json({ location_id: locationId, date: d, week_start: ws, tasks });
  });

  router.post('/safety/checks', (req, res) => {
    const b = req.body;
    const locationId = resolveLocation(req, b.location_id);
    const task = db.prepare('SELECT * FROM safety_tasks WHERE id = ? AND active = 1').get(id(b.task_id, 'task_id', { required: true }));
    if (!task || (task.location_id && task.location_id !== locationId)) throw notFound('Task');
    const d = date(b.date, 'date') ?? today();
    if (d > today()) throw badRequest('Checks cannot be recorded for a future date');
    const period = task.frequency === 'daily' ? d : weekStart(d);

    let status;
    let reading = null;
    if (task.requires_reading) {
      reading = num(b.reading, 'reading', { required: true });
      const low = task.min_value !== null && reading < task.min_value;
      const high = task.max_value !== null && reading > task.max_value;
      status = low || high ? 'fail' : 'pass';
    } else {
      status = oneOf(b.status, 'status', ['pass', 'fail']) ?? 'pass';
    }
    const corrective = str(b.corrective_action, 'corrective_action', { max: 1000 });
    if (status === 'fail' && !corrective) {
      throw badRequest(task.requires_reading
        ? `Reading is outside the safe range (${task.min_value ?? '–'} to ${task.max_value ?? '–'}${task.reading_unit ?? ''}). Record the corrective action taken.`
        : 'Record the corrective action taken for a failed check');
    }

    db.prepare(`INSERT INTO safety_checks (task_id, location_id, period, status, reading, notes, corrective_action, completed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task_id, location_id, period) DO UPDATE SET status = excluded.status, reading = excluded.reading,
        notes = excluded.notes, corrective_action = excluded.corrective_action, completed_by = excluded.completed_by,
        completed_at = datetime('now')`)
      .run(task.id, locationId, period, status, reading, str(b.notes, 'notes', { max: 1000 }), corrective, req.user.id);
    res.status(201).json(db.prepare(`SELECT c.*, u.name AS completed_by_name FROM safety_checks c LEFT JOIN users u ON u.id = c.completed_by
      WHERE c.task_id = ? AND c.location_id = ? AND c.period = ?`).get(task.id, locationId, period));
  });

  router.delete('/safety/checks/:id', requireManager, (req, res) => {
    const check = db.prepare('SELECT * FROM safety_checks WHERE id = ?').get(Number(req.params.id));
    if (!check) throw notFound('Check');
    assertLocation(req, check.location_id);
    db.prepare('DELETE FROM safety_checks WHERE id = ?').run(check.id);
    res.json({ ok: true });
  });

  // Compliance by day/week plus a log of every failed check. Admins may omit location_id for all sites.
  router.get('/safety/report', (req, res) => {
    const to = date(req.query.to, 'to') ?? today();
    const from = date(req.query.from, 'from') ?? addDays(to, -13);
    if (from > to) throw badRequest('from must be before to');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_REPORT_DAYS) throw badRequest(`Reports are limited to ${MAX_REPORT_DAYS} days`);

    const locations = req.user.role === 'admin' && !req.query.location_id
      ? db.prepare('SELECT id, name FROM locations WHERE active = 1 ORDER BY name').all()
      : [db.prepare('SELECT id, name FROM locations WHERE id = ?').get(resolveLocation(req, req.query.location_id))];

    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const weeks = [...new Set(days.map(weekStart))];

    const out = locations.map((loc) => {
      const tasks = tasksFor.all(loc.id);
      const dailyIds = new Set(tasks.filter((t) => t.frequency === 'daily').map((t) => t.id));
      const weeklyIds = new Set(tasks.filter((t) => t.frequency === 'weekly').map((t) => t.id));
      const checks = db.prepare('SELECT task_id, period, status FROM safety_checks WHERE location_id = ? AND period BETWEEN ? AND ?')
        .all(loc.id, weeks[0], to);
      const summarise = (period, ids) => {
        const done = checks.filter((c) => c.period === period && ids.has(c.task_id));
        return { due: ids.size, done: done.length, fails: done.filter((c) => c.status === 'fail').length };
      };
      const dayRows = days.map((d) => ({ date: d, ...summarise(d, dailyIds) }));
      const weekRows = weeks.map((w) => ({ week_start: w, ...summarise(w, weeklyIds) }));
      const due = [...dayRows, ...weekRows].reduce((s, r) => s + r.due, 0);
      const done = [...dayRows, ...weekRows].reduce((s, r) => s + r.done, 0);
      return { id: loc.id, name: loc.name, days: dayRows, weeks: weekRows, compliance_pct: due ? round2((done / due) * 100) : 100 };
    });

    const ids = locations.map((l) => l.id);
    const failures = db.prepare(`SELECT c.*, t.title, t.frequency, t.reading_unit, l.name AS location_name, u.name AS completed_by_name
      FROM safety_checks c JOIN safety_tasks t ON t.id = c.task_id JOIN locations l ON l.id = c.location_id
      LEFT JOIN users u ON u.id = c.completed_by
      WHERE c.status = 'fail' AND c.period BETWEEN ? AND ? AND c.location_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY c.period DESC, c.completed_at DESC`).all(weeks[0], to, ...ids);

    res.json({ from, to, days, weeks, locations: out, failures });
  });

  // --- Dashboard: one card per site the user can see ---

  router.get('/dashboard', (req, res) => {
    const d = today();
    const ws = weekStart(d);
    const manager = isManager(req.user);
    const locations = req.user.role === 'admin'
      ? db.prepare('SELECT id, name FROM locations WHERE active = 1 ORDER BY name').all()
      : db.prepare('SELECT id, name FROM locations WHERE id = ?').all(req.user.location_id);

    // Sales figures are only as fresh as the last Square sync.
    const salesSummary = (locationId) => {
      const todaySales = db.prepare('SELECT net_sales, orders FROM sales_daily WHERE location_id = ? AND date = ?').get(locationId, d);
      const week = db.prepare('SELECT COALESCE(SUM(net_sales), 0) AS net FROM sales_daily WHERE location_id = ? AND date BETWEEN ? AND ?')
        .get(locationId, addDays(d, -6), d).net;
      const labourToday = labourByDay(db, [locationId], d, d, { toDate: true }).get(`${locationId}|${d}`) ?? 0;
      return {
        sales_today: todaySales ? round2(todaySales.net_sales) : null,
        orders_today: todaySales?.orders ?? 0,
        sales_7d: round2(week),
        labour_cost_today: round2(labourToday),
        labour_pct_today: todaySales && labourToday ? pct(labourToday, todaySales.net_sales) : null,
      };
    };

    const cards = locations.map((loc) => {
      const tasks = tasksFor.all(loc.id);
      const checks = db.prepare('SELECT task_id, period, status FROM safety_checks WHERE location_id = ? AND period IN (?, ?)').all(loc.id, d, ws);
      const count = (freq, period) => {
        const ids = new Set(tasks.filter((t) => t.frequency === freq).map((t) => t.id));
        const done = checks.filter((c) => c.period === period && ids.has(c.task_id));
        return { due: ids.size, done: done.length, fails: done.filter((c) => c.status === 'fail').length };
      };
      const shiftsToday = db.prepare(`SELECT s.start_time, s.end_time, s.position, u.name FROM shifts s JOIN users u ON u.id = s.user_id
        WHERE s.location_id = ? AND s.date = ? ORDER BY s.start_time`).all(loc.id, d);
      const lastTake = db.prepare(`SELECT MAX(completed_at) AS at FROM stock_takes WHERE location_id = ? AND status = 'completed'`).get(loc.id).at;
      const takeInProgress = db.prepare(`SELECT id FROM stock_takes WHERE location_id = ? AND status = 'in_progress'`).get(loc.id)?.id ?? null;
      const wastage = db.prepare('SELECT COALESCE(SUM(total_cost), 0) AS total FROM wastage WHERE location_id = ? AND date BETWEEN ? AND ?')
        .get(loc.id, addDays(d, -6), d).total;
      const orders = manager
        ? db.prepare(`SELECT status, COUNT(*) AS n FROM purchase_orders WHERE location_id = ? AND status IN ('draft', 'sent') GROUP BY status`).all(loc.id)
        : [];
      return {
        id: loc.id,
        name: loc.name,
        daily: count('daily', d),
        weekly: count('weekly', ws),
        shifts_today: shiftsToday,
        wastage_7d: round2(wastage),
        last_stock_take: lastTake,
        stock_take_in_progress: takeInProgress,
        orders_draft: orders.find((o) => o.status === 'draft')?.n ?? 0,
        orders_sent: orders.find((o) => o.status === 'sent')?.n ?? 0,
        ...(manager ? salesSummary(loc.id) : {}),
      };
    });
    res.json({ date: d, week_start: ws, locations: cards });
  });
}
