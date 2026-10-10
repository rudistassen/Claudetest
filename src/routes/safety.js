import { assertLocation, can, reportLocations, requirePerm, resolveLocation } from '../auth.js';
import { tx } from '../db.js';
import { siteSummaries, tasksAt } from '../dashboard.js';
import { addDays, badRequest, bool, date, forbidden, id, notFound, num, oneOf, round2, str, today, weekStart } from '../util.js';

const MAX_REPORT_DAYS = 92;

export function registerSafetyRoutes(router, db) {
  // The checks a site does: shared checks (unless switched off there) plus the site's own.
  const tasksFor = (locationId) => tasksAt(db, locationId);

  // --- Task templates ---

  router.get('/safety/tasks', requirePerm('safety.manage', 'safety.complete'), (req, res) => {
    // Checks for every site, plus those set up for the sites this person can access.
    const ids = new Set(req.user.site_ids);
    const rows = db.prepare(`SELECT t.*, l.name AS location_name FROM safety_tasks t LEFT JOIN locations l ON l.id = t.location_id
          ORDER BY t.active DESC, t.frequency, t.sort_order, t.title`).all()
      .filter((t) => t.location_id === null || ids.has(t.location_id));
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
  const loadTask = (req) => {
    const t = db.prepare('SELECT * FROM safety_tasks WHERE id = ?').get(Number(req.params.id));
    if (!t) throw notFound('Check');
    return t;
  };

  // --- Set up, one site at a time ---

  // Every check at a site: shared ones (marked off if switched off there) and the site's own, including inactive ones.
  router.get('/safety/setup', requirePerm('safety.manage'), (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    const off = new Set(db.prepare('SELECT task_id FROM safety_task_exclusions WHERE location_id = ?').all(locationId).map((r) => r.task_id));
    const shared = db.prepare('SELECT * FROM safety_tasks WHERE location_id IS NULL AND active = 1').all();
    const own = db.prepare('SELECT * FROM safety_tasks WHERE location_id = ?').all(locationId);
    const title = new Map(shared.map((t) => [t.id, t.title]));
    const history = db.prepare('SELECT COUNT(*) AS n FROM safety_checks WHERE task_id = ?');
    const tasks = [
      ...shared.map((t) => ({ ...t, scope: 'shared', on_here: !off.has(t.id), replaced_by: own.find((o) => o.replaces_task_id === t.id && o.active)?.id ?? null })),
      ...own.map((t) => ({ ...t, scope: 'site', on_here: !!t.active, replaces_title: t.replaces_task_id ? title.get(t.replaces_task_id) ?? null : null, has_history: history.get(t.id).n > 0 })),
    ].sort((a, b) => a.frequency.localeCompare(b.frequency) || a.category.localeCompare(b.category) || a.sort_order - b.sort_order || a.title.localeCompare(b.title));
    res.json({ location_id: locationId, tasks });
  });

  // Switches a shared check off (or back on) at one site.
  router.post('/safety/tasks/:id/at-site', requirePerm('safety.manage'), (req, res) => {
    const task = loadTask(req);
    if (task.location_id !== null) throw badRequest('Only checks shared by every site can be switched on or off per site');
    const locationId = resolveLocation(req, req.body.location_id);
    if (bool(req.body.on)) db.prepare('DELETE FROM safety_task_exclusions WHERE task_id = ? AND location_id = ?').run(task.id, locationId);
    else db.prepare('INSERT OR IGNORE INTO safety_task_exclusions (task_id, location_id) VALUES (?, ?)').run(task.id, locationId);
    res.json({ ok: true });
  });

  // Changes a shared check for one site: the site gets its own copy and the shared one is switched off there.
  router.post('/safety/tasks/:id/customise', requirePerm('safety.manage'), (req, res) => {
    const shared = loadTask(req);
    if (shared.location_id !== null) throw badRequest('This check already belongs to one site; edit it instead');
    const locationId = resolveLocation(req, req.body.location_id);
    const t = taskBody({ ...req, body: { ...req.body, location_id: locationId } });
    const newId = tx(db, () => {
      const r = db.prepare(`INSERT INTO safety_tasks (${taskCols.join(', ')}, replaces_task_id) VALUES (${taskCols.map(() => '?').join(', ')}, ?)`)
        .run(...taskCols.map((c) => t[c]), shared.id);
      db.prepare('INSERT OR IGNORE INTO safety_task_exclusions (task_id, location_id) VALUES (?, ?)').run(shared.id, locationId);
      return r.lastInsertRowid;
    });
    res.status(201).json(db.prepare('SELECT * FROM safety_tasks WHERE id = ?').get(newId));
  });

  // Goes back to the shared version at a site: its own copy goes (or is switched off if checks were recorded).
  router.post('/safety/tasks/:id/revert', requirePerm('safety.manage'), (req, res) => {
    const own = loadTask(req);
    if (!own.location_id || !own.replaces_task_id) throw badRequest('This check isn’t a site’s version of a shared check');
    assertLocation(req, own.location_id);
    tx(db, () => {
      retire(own);
      db.prepare('DELETE FROM safety_task_exclusions WHERE task_id = ? AND location_id = ?').run(own.replaces_task_id, own.location_id);
    });
    res.json({ ok: true });
  });

  // Deletes a site's own check, or switches it off if checks have been recorded against it (keeping the records).
  const retire = (t) => {
    if (db.prepare('SELECT 1 FROM safety_checks WHERE task_id = ?').get(t.id)) db.prepare('UPDATE safety_tasks SET active = 0 WHERE id = ?').run(t.id);
    else db.prepare('DELETE FROM safety_tasks WHERE id = ?').run(t.id);
  };
  router.delete('/safety/tasks/:id', requirePerm('safety.manage'), (req, res) => {
    const t = loadTask(req);
    if (t.location_id) assertLocation(req, t.location_id);
    else if (req.user.role !== 'admin') throw forbidden('Only admins can remove checks shared by every site');
    const kept = !!db.prepare('SELECT 1 FROM safety_checks WHERE task_id = ?').get(t.id);
    retire(t);
    res.json({ deleted: !kept, switched_off: kept });
  });

  router.post('/safety/tasks', requirePerm('safety.manage'), (req, res) => {
    const t = taskBody(req);
    const r = db.prepare(`INSERT INTO safety_tasks (${taskCols.join(', ')}) VALUES (${taskCols.map(() => '?').join(', ')})`)
      .run(...taskCols.map((c) => t[c]));
    res.status(201).json(db.prepare('SELECT * FROM safety_tasks WHERE id = ?').get(r.lastInsertRowid));
  });

  router.put('/safety/tasks/:id', requirePerm('safety.manage'), (req, res) => {
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

  router.get('/safety/checklist', requirePerm('safety.complete', 'safety.manage', 'safety.report'), (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    const d = date(req.query.date, 'date') ?? today();
    const ws = weekStart(d);
    const checks = db.prepare(`SELECT c.*, u.name AS completed_by_name FROM safety_checks c LEFT JOIN users u ON u.id = c.completed_by
      WHERE c.location_id = ? AND c.period IN (?, ?)`).all(locationId, d, ws);
    const tasks = tasksFor(locationId).map((t) => {
      const period = t.frequency === 'daily' ? d : ws;
      return { ...t, check: checks.find((c) => c.task_id === t.id && c.period === period) ?? null };
    });
    res.json({ location_id: locationId, date: d, week_start: ws, tasks });
  });

  router.post('/safety/checks', requirePerm('safety.complete'), (req, res) => {
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

  router.delete('/safety/checks/:id', requirePerm('safety.manage'), (req, res) => {
    const check = db.prepare('SELECT * FROM safety_checks WHERE id = ?').get(Number(req.params.id));
    if (!check) throw notFound('Check');
    assertLocation(req, check.location_id);
    db.prepare('DELETE FROM safety_checks WHERE id = ?').run(check.id);
    res.json({ ok: true });
  });

  // Compliance by day/week plus a log of every failed check. Admins may omit location_id for all sites.
  router.get('/safety/report', requirePerm('safety.report'), (req, res) => {
    const to = date(req.query.to, 'to') ?? today();
    const from = date(req.query.from, 'from') ?? addDays(to, -13);
    if (from > to) throw badRequest('from must be before to');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_REPORT_DAYS) throw badRequest(`Reports are limited to ${MAX_REPORT_DAYS} days`);

    const locations = reportLocations(req, req.query.location_id);

    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const weeks = [...new Set(days.map(weekStart))];

    const out = locations.map((loc) => {
      const tasks = tasksFor(loc.id);
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

  // ?date= shows a past day in full (default: today so far).
  // The HQ Dashboard (dashboard.view) loads every site they can access; the Manager Dashboard (dashboard.manager)
  // loads one site with ?location_id= – without the HQ permission, only ever one site (their home site by default).
  router.get('/dashboard', requirePerm('dashboard.view', 'dashboard.manager'), (req, res) => {
    const hq = can(req.user, 'dashboard.view');
    const site = req.query.location_id ?? (hq ? undefined : req.user.location_id ?? req.user.site_ids[0]);
    const day = date(req.query.date, 'date') ?? today();
    if (day > today()) throw badRequest('Choose today or an earlier day');
    // ?from= adds checks and wastage over a period ending on the day (up to a year).
    const from = date(req.query.from, 'from');
    if (from && (from > day || (Date.parse(day) - Date.parse(from)) / 86400000 > 366)) throw badRequest('Choose a period of up to a year ending on the day shown');
    res.json(siteSummaries(db, {
      date: day,
      fullDay: day < today(),
      // ?location_id= for one site (the manager dashboard), otherwise every site they can see.
      locations: reportLocations(req, site),
      seeSales: can(req.user, 'sales.view'),
      seeOrders: can(req.user, 'orders.manage'),
      seeClockIns: can(req.user, 'sales.view') || can(req.user, 'staff.manage'),
      periodFrom: from,
    }));
  });
}
