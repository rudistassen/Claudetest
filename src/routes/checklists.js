// Checklists & Tasks: operational checklists ticked off each day at a site (opening, closing, cleaning…), tasks
// given to a person, a role or a whole site, and each person's private to-do list. Food-safety checks live in
// Compliance (safety.js); these are everything else that needs doing.
import { assertLocation, can, requirePerm, resolveLocation } from '../auth.js';
import { tx } from '../db.js';
import { notify } from '../push.js';
import { addDays, badRequest, date, forbidden, id, notFound, oneOf, str, today } from '../util.js';

const REPEATS = ['none', 'daily', 'weekly', 'monthly'];
const ASSIGN = ['person', 'role', 'site'];
// 1 = Monday … 7 = Sunday.
const weekday = (d) => ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
const addMonths = (d, n) => {
  const [y, m, day] = d.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  const t = new Date(Date.UTC(y, m - 1 + n, Math.min(day, last)));
  return t.toISOString().slice(0, 10);
};
const step = (d, repeat) => (repeat === 'daily' ? addDays(d, 1) : repeat === 'weekly' ? addDays(d, 7) : addMonths(d, 1));

export function registerChecklistRoutes(router, db) {
  // ---- Checklists ----

  const itemsOf = (cid) => db.prepare('SELECT id, text, position FROM checklist_items WHERE checklist_id = ? ORDER BY position, id').all(cid);
  const checklist = (cid) => {
    const c = db.prepare('SELECT * FROM checklists WHERE id = ? AND active = 1').get(cid);
    if (!c) throw notFound('Checklist');
    return c;
  };
  // Everyone-site checklists are set up by admins; a site's own by anyone who can set up checklists there.
  const canEdit = (req, c) => (c.location_id === null ? req.user.role === 'admin' : req.user.site_ids.includes(c.location_id));

  // A site's checklists for a day (default today), each item with who ticked it and when.
  router.get('/checklists', requirePerm('checklists.complete', 'checklists.manage'), (req, res) => {
    const site = resolveLocation(req, req.query.location_id);
    const day = date(req.query.date, 'date') ?? today();
    const lists = db.prepare(`SELECT * FROM checklists WHERE active = 1 AND (location_id IS NULL OR location_id = ?) ORDER BY position, name`).all(site)
      .filter((c) => c.days.includes(String(weekday(day))));
    const ticks = db.prepare(`SELECT t.item_id, t.done_at, u.name AS done_by_name FROM checklist_ticks t LEFT JOIN users u ON u.id = t.done_by
      WHERE t.location_id = ? AND t.date = ?`).all(site, day);
    const tick = new Map(ticks.map((t) => [t.item_id, t]));
    res.json({
      location_id: site,
      date: day,
      can_tick_past: can(req.user, 'checklists.manage'),
      checklists: lists.map((c) => {
        const items = itemsOf(c.id).map((i) => ({ ...i, done: tick.has(i.id), done_at: tick.get(i.id)?.done_at ?? null, done_by_name: tick.get(i.id)?.done_by_name ?? null }));
        return { id: c.id, name: c.name, description: c.description, every_site: c.location_id === null, items, done: items.filter((i) => i.done).length, total: items.length };
      }),
    });
  });

  // Tick (or untick) an item: { location_id, date, done }. Staff tick today's; people who set up checklists can
  // catch up on the last week.
  router.post('/checklists/items/:itemId/tick', requirePerm('checklists.complete', 'checklists.manage'), (req, res) => {
    const item = db.prepare('SELECT i.*, c.location_id AS list_site, c.active FROM checklist_items i JOIN checklists c ON c.id = i.checklist_id WHERE i.id = ?').get(Number(req.params.itemId));
    if (!item || !item.active) throw notFound('Checklist item');
    const b = req.body ?? {};
    const site = resolveLocation(req, b.location_id);
    if (item.list_site !== null && item.list_site !== site) throw badRequest('That checklist isn’t for this site');
    const day = date(b.date, 'date') ?? today();
    if (day > today()) throw badRequest('You can’t tick off a day that hasn’t happened yet');
    if (day < today() && !(can(req.user, 'checklists.manage') && day >= addDays(today(), -7))) throw forbidden('Only today’s checklists can be ticked off');
    if (b.done === false) db.prepare('DELETE FROM checklist_ticks WHERE item_id = ? AND location_id = ? AND date = ?').run(item.id, site, day);
    else db.prepare('INSERT OR IGNORE INTO checklist_ticks (item_id, location_id, date, done_by) VALUES (?, ?, ?, ?)').run(item.id, site, day, req.user.id);
    res.json({ ok: true });
  });

  // Setting checklists up: every one that applies to their sites.
  router.get('/checklists/setup', requirePerm('checklists.manage'), (req, res) => {
    const rows = db.prepare(`SELECT c.*, l.name AS location_name FROM checklists c LEFT JOIN locations l ON l.id = c.location_id
      WHERE c.active = 1 ORDER BY c.location_id IS NOT NULL, l.name, c.position, c.name`).all()
      .filter((c) => c.location_id === null || req.user.site_ids.includes(c.location_id));
    res.json(rows.map((c) => ({ ...c, items: itemsOf(c.id), can_edit: canEdit(req, c) })));
  });

  const checklistBody = (req) => {
    const b = req.body ?? {};
    const site = b.location_id === null || b.location_id === '' || b.location_id === 'all' ? null : id(b.location_id, 'location_id');
    if (site === null && req.user.role !== 'admin') throw forbidden('Only admins can set up a checklist for every site');
    if (site !== null) assertLocation(req, site);
    const days = [...new Set(String(b.days ?? '1234567').split('').filter((c) => /[1-7]/.test(c)))].sort().join('');
    if (!days) throw badRequest('Choose at least one day');
    const items = (Array.isArray(b.items) ? b.items : []).map((t) => String(t ?? '').trim()).filter(Boolean);
    if (!items.length) throw badRequest('Add at least one thing to check');
    if (items.length > 100) throw badRequest('A checklist can have up to 100 items');
    if (items.some((t) => t.length > 300)) throw badRequest('Each item can be up to 300 characters');
    return { name: str(b.name, 'Name', { required: true, max: 100 }), description: str(b.description, 'Description', { max: 500 }), location_id: site, days, items };
  };
  const saveItems = (cid, items) => {
    // Items keep their ids (and so today's ticks) when their wording is unchanged.
    const existing = itemsOf(cid);
    const keep = new Set();
    items.forEach((text, i) => {
      const same = existing.find((e) => e.text === text && !keep.has(e.id));
      if (same) {
        keep.add(same.id);
        db.prepare('UPDATE checklist_items SET position = ? WHERE id = ?').run(i, same.id);
      } else {
        keep.add(Number(db.prepare('INSERT INTO checklist_items (checklist_id, position, text) VALUES (?, ?, ?)').run(cid, i, text).lastInsertRowid));
      }
    });
    for (const e of existing) if (!keep.has(e.id)) db.prepare('DELETE FROM checklist_items WHERE id = ?').run(e.id);
  };

  router.post('/checklists', requirePerm('checklists.manage'), (req, res) => {
    const f = checklistBody(req);
    const cid = tx(db, () => {
      const r = db.prepare('INSERT INTO checklists (name, description, location_id, days) VALUES (?, ?, ?, ?)').run(f.name, f.description, f.location_id, f.days);
      saveItems(Number(r.lastInsertRowid), f.items);
      return Number(r.lastInsertRowid);
    });
    res.status(201).json({ id: cid });
  });

  router.put('/checklists/:id', requirePerm('checklists.manage'), (req, res) => {
    const c = checklist(Number(req.params.id));
    if (!canEdit(req, c)) throw forbidden('You can’t change this checklist');
    const f = checklistBody(req);
    tx(db, () => {
      db.prepare('UPDATE checklists SET name = ?, description = ?, location_id = ?, days = ? WHERE id = ?').run(f.name, f.description, f.location_id, f.days, c.id);
      saveItems(c.id, f.items);
    });
    res.json({ ok: true });
  });

  // Turned off rather than deleted, so past ticks are kept.
  router.delete('/checklists/:id', requirePerm('checklists.manage'), (req, res) => {
    const c = checklist(Number(req.params.id));
    if (!canEdit(req, c)) throw forbidden('You can’t delete this checklist');
    db.prepare('UPDATE checklists SET active = 0 WHERE id = ?').run(c.id);
    res.json({ ok: true });
  });

  // ---- Tasks ----

  const TASK_SELECT = `SELECT t.*, l.name AS location_name, u.name AS user_name, cb.name AS created_by_name, db.name AS done_by_name
    FROM tasks t LEFT JOIN locations l ON l.id = t.location_id LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN users cb ON cb.id = t.created_by LEFT JOIN users db ON db.id = t.done_by`;
  const task = (tid) => {
    const t = db.prepare(`${TASK_SELECT} WHERE t.id = ? AND t.active = 1`).get(tid);
    if (!t) throw notFound('Task');
    return t;
  };
  const manages = (req, t) => can(req.user, 'tasks.manage') && (req.user.role === 'admin' || req.user.site_ids.includes(t.location_id));
  // Whether a task is given to this person: them by name, their role at one of their sites, or one of their sites.
  const isMine = (req, t) => (t.assign_to === 'person' ? t.user_id === req.user.id
    : req.user.site_ids.includes(t.location_id) && (t.assign_to === 'site' || (t.role && t.role === req.user.rota_group)));
  // The people a task goes to (for its notification).
  const assignees = (t) => (t.assign_to === 'person' ? [t.user_id]
    : db.prepare(`SELECT u.id FROM users u WHERE u.active = 1 AND u.location_id = ? ${t.assign_to === 'role' ? 'AND u.rota_group = ?' : ''}`)
      .all(...(t.assign_to === 'role' ? [t.location_id, t.role] : [t.location_id])).map((r) => r.id));
  const shape = (req, t) => ({
    ...t,
    status: t.done_at ? 'done' : t.due_on && t.due_on < today() ? 'overdue' : 'open',
    can_manage: manages(req, t),
    mine: isMine(req, t),
  });

  // Who tasks can be given to: people at their sites, the roles there, and the sites.
  router.get('/tasks/people', requirePerm('tasks.manage'), (req, res) => {
    const sites = req.user.role === 'admin' ? db.prepare('SELECT id FROM locations WHERE active = 1').all().map((l) => l.id) : req.user.site_ids;
    const inList = sites.map(() => '?').join(', ') || 'NULL';
    const people = db.prepare(`SELECT u.id, u.name, u.location_id, u.rota_group, l.name AS location_name FROM users u LEFT JOIN locations l ON l.id = u.location_id
      WHERE u.active = 1 AND u.location_id IN (${inList}) ORDER BY u.name`).all(...sites);
    res.json({
      people,
      roles: [...new Set(people.map((p) => p.rota_group).filter(Boolean))].sort(),
      sites: db.prepare(`SELECT id, name FROM locations WHERE id IN (${inList}) ORDER BY name`).all(...sites),
    });
  });

  // Tasks given to the signed-in person (open ones, and ones done in the last week).
  router.get('/tasks/mine', (req, res) => {
    const me = db.prepare('SELECT rota_group FROM users WHERE id = ?').get(req.user.id);
    const r = { ...req, user: { ...req.user, rota_group: me?.rota_group ?? null } };
    const rows = db.prepare(`${TASK_SELECT} WHERE t.active = 1 AND (t.done_at IS NULL OR t.done_at >= datetime('now', '-7 days'))
      ORDER BY t.done_at IS NOT NULL, COALESCE(t.due_on, '9999'), t.id`).all().filter((t) => isMine(r, t));
    res.json(rows.map((t) => shape(r, t)));
  });

  // Every task at their sites (people who give tasks out): ?status=open (default, including overdue) or done.
  router.get('/tasks', requirePerm('tasks.manage'), (req, res) => {
    const status = oneOf(req.query.status ?? 'open', 'status', ['open', 'done']);
    const site = req.query.location_id ? id(req.query.location_id, 'location_id') : null;
    if (site) assertLocation(req, site);
    const rows = db.prepare(`${TASK_SELECT} WHERE t.active = 1 AND ${status === 'open' ? 't.done_at IS NULL' : "t.done_at >= datetime('now', '-60 days')"}
      ORDER BY ${status === 'open' ? "COALESCE(t.due_on, '9999'), t.id" : 't.done_at DESC'}`).all()
      .filter((t) => (site ? t.location_id === site : req.user.role === 'admin' || req.user.site_ids.includes(t.location_id)));
    res.json(rows.map((t) => shape(req, t)));
  });

  const taskBody = (req) => {
    const b = req.body ?? {};
    const assignTo = oneOf(b.assign_to ?? 'person', 'assign_to', ASSIGN, { required: true });
    let userId = null;
    let site = id(b.location_id, 'location_id');
    let role = null;
    if (assignTo === 'person') {
      userId = id(b.user_id, 'user_id', { required: true });
      const u = db.prepare('SELECT id, location_id FROM users WHERE id = ? AND active = 1').get(userId);
      if (!u) throw notFound('Person');
      site = u.location_id ?? site;
    } else if (assignTo === 'role') {
      role = str(b.role, 'Role', { required: true, max: 50 });
    }
    if (!site) throw badRequest('Choose a site');
    assertLocation(req, site);
    return {
      title: str(b.title, 'Task', { required: true, max: 200 }),
      notes: str(b.notes, 'Notes', { max: 2000 }),
      location_id: site,
      assign_to: assignTo,
      user_id: userId,
      role,
      due_on: date(b.due_on, 'Due date'),
      repeat: oneOf(b.repeat ?? 'none', 'repeat', REPEATS, { required: true }),
    };
  };

  router.post('/tasks', requirePerm('tasks.manage'), (req, res) => {
    const f = taskBody(req);
    if (f.repeat !== 'none' && !f.due_on) throw badRequest('A repeating task needs a first due date');
    const tid = Number(db.prepare(`INSERT INTO tasks (title, notes, location_id, assign_to, user_id, role, due_on, repeat, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.title, f.notes, f.location_id, f.assign_to, f.user_id, f.role, f.due_on, f.repeat, req.user.id).lastInsertRowid);
    const t = task(tid);
    notify(db, assignees(t).filter((u) => u !== req.user.id), 'task', {
      title: 'New task', body: `${req.user.name}: ${t.title}${t.due_on ? ` (by ${t.due_on.split('-').reverse().join('/')})` : ''}`, url: '/#/tasks',
    });
    res.status(201).json({ id: tid });
  });

  router.put('/tasks/:id', requirePerm('tasks.manage'), (req, res) => {
    const t = task(Number(req.params.id));
    if (!manages(req, t)) throw forbidden('You can’t change this task');
    const f = taskBody(req);
    if (f.repeat !== 'none' && !f.due_on) throw badRequest('A repeating task needs a due date');
    db.prepare('UPDATE tasks SET title = ?, notes = ?, location_id = ?, assign_to = ?, user_id = ?, role = ?, due_on = ?, repeat = ? WHERE id = ?')
      .run(f.title, f.notes, f.location_id, f.assign_to, f.user_id, f.role, f.due_on, f.repeat, t.id);
    res.json({ ok: true });
  });

  router.delete('/tasks/:id', requirePerm('tasks.manage'), (req, res) => {
    const t = task(Number(req.params.id));
    if (!manages(req, t)) throw forbidden('You can’t delete this task');
    db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').run(t.id);
    res.json({ ok: true });
  });

  // Mark a task done ({ note }). A repeating task moves on to its next due date instead of closing.
  router.post('/tasks/:id/done', (req, res) => {
    const t = task(Number(req.params.id));
    const me = db.prepare('SELECT rota_group FROM users WHERE id = ?').get(req.user.id);
    if (!isMine({ ...req, user: { ...req.user, rota_group: me?.rota_group ?? null } }, t) && !manages(req, t)) throw forbidden('This task isn’t yours');
    if (t.done_at) throw badRequest('That task is already done');
    const note = str(req.body?.note, 'Note', { max: 1000 });
    let next = null;
    tx(db, () => {
      db.prepare('INSERT INTO task_done (task_id, due_on, done_by, note) VALUES (?, ?, ?, ?)').run(t.id, t.due_on, req.user.id, note);
      if (t.repeat !== 'none') {
        next = step(t.due_on ?? today(), t.repeat);
        while (next <= today()) next = step(next, t.repeat);
        db.prepare('UPDATE tasks SET due_on = ? WHERE id = ?').run(next, t.id);
      } else {
        db.prepare(`UPDATE tasks SET done_at = datetime('now'), done_by = ? WHERE id = ?`).run(req.user.id, t.id);
      }
    });
    res.json({ ok: true, next_due_on: next });
  });

  // Undo "done" on a one-off task (whoever did it, or a manager).
  router.post('/tasks/:id/reopen', (req, res) => {
    const t = task(Number(req.params.id));
    if (!t.done_at) throw badRequest('That task isn’t done');
    if (t.done_by !== req.user.id && !manages(req, t)) throw forbidden('You can’t reopen this task');
    db.prepare('UPDATE tasks SET done_at = NULL, done_by = NULL WHERE id = ?').run(t.id);
    db.prepare('DELETE FROM task_done WHERE id = (SELECT id FROM task_done WHERE task_id = ? ORDER BY id DESC LIMIT 1)').run(t.id);
    res.json({ ok: true });
  });

  // A task's history: each time it was done, by whom, with any note.
  router.get('/tasks/:id/history', (req, res) => {
    const t = task(Number(req.params.id));
    if (!manages(req, t) && t.user_id !== req.user.id && t.created_by !== req.user.id) throw forbidden();
    res.json(db.prepare(`SELECT d.due_on, d.note, d.done_at, u.name AS done_by_name FROM task_done d LEFT JOIN users u ON u.id = d.done_by
      WHERE d.task_id = ? ORDER BY d.id DESC LIMIT 50`).all(t.id));
  });

  // ---- My to-do: each person's own list ----

  const todo = (req, tid) => {
    const t = db.prepare('SELECT * FROM todos WHERE id = ? AND user_id = ?').get(tid, req.user.id);
    if (!t) throw notFound('To-do');
    return t;
  };
  router.get('/todos', requirePerm('todo.use'), (req, res) => {
    res.json(db.prepare(`SELECT * FROM todos WHERE user_id = ? AND (done_at IS NULL OR done_at >= datetime('now', '-14 days'))
      ORDER BY done_at IS NOT NULL, COALESCE(due_on, '9999'), id`).all(req.user.id));
  });
  router.post('/todos', requirePerm('todo.use'), (req, res) => {
    const b = req.body ?? {};
    const r = db.prepare('INSERT INTO todos (user_id, text, due_on) VALUES (?, ?, ?)').run(req.user.id, str(b.text, 'To-do', { required: true, max: 300 }), date(b.due_on, 'Due date'));
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  router.put('/todos/:id', requirePerm('todo.use'), (req, res) => {
    const t = todo(req, Number(req.params.id));
    const b = req.body ?? {};
    db.prepare(`UPDATE todos SET text = ?, due_on = ?, done_at = CASE WHEN ? THEN COALESCE(done_at, datetime('now')) ELSE NULL END WHERE id = ?`).run(
      b.text === undefined ? t.text : str(b.text, 'To-do', { required: true, max: 300 }),
      b.due_on === undefined ? t.due_on : date(b.due_on, 'Due date'),
      (b.done === undefined ? !!t.done_at : !!b.done) ? 1 : 0, t.id,
    );
    res.json({ ok: true });
  });
  router.delete('/todos/:id', requirePerm('todo.use'), (req, res) => {
    db.prepare('DELETE FROM todos WHERE id = ?').run(todo(req, Number(req.params.id)).id);
    res.json({ ok: true });
  });
}
