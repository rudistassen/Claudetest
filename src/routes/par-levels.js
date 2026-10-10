// Reporting → Par levels: for one Square category at one site, each item's average sold on each day of the week
// over a date range (the last 6 full weeks unless another is picked), to budget a par level for each day. The budget is saved as a named
// report, which keeps just the budgeted par levels; saved reports can be opened, changed, printed or deleted.
import { assertLocation, requirePerm, resolveLocation } from '../auth.js';
import { tx } from '../db.js';
import { addDays, badRequest, date, notFound, num, round2, str, today, weekStart } from '../util.js';

export const PAR_WEEKS = 6;
const UNCATEGORISED = 'Uncategorised';
const weekdayOf = (iso) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;

export function registerParLevelRoutes(router, db) {
  const perm = requirePerm('sales.view');
  // The sales the averages come from: ?from=&to=, or the last 6 full weeks (Monday to Sunday).
  const window = (q = {}) => {
    const lastSunday = addDays(weekStart(today()), -1);
    const from = date(q.from, 'from') ?? addDays(lastSunday, -(PAR_WEEKS * 7 - 1));
    const to = date(q.to, 'to') ?? (q.from ? today() : lastSunday);
    if (from > to) throw badRequest('The start date is after the end date');
    if (addDays(from, 731) <= to) throw badRequest('Pick up to two years');
    return { from, to };
  };
  const CATEGORY = `COALESCE(NULLIF(c.category_name, ''), '${UNCATEGORISED}')`;

  // A saved report with its lines (each item's par levels, Monday to Sunday; null where none was budgeted).
  const REPORT = `SELECT r.*, l.name AS location_name FROM par_reports r JOIN locations l ON l.id = r.location_id`;
  const linesOf = (reportId) => {
    const lines = new Map();
    for (const r of db.prepare('SELECT item_key, item_name, weekday, par FROM par_report_lines WHERE report_id = ? ORDER BY rowid').all(reportId)) {
      const l = lines.get(r.item_key) ?? { item_key: r.item_key, item_name: r.item_name, pars: Array(7).fill(null) };
      l.pars[r.weekday] = r.par;
      lines.set(r.item_key, l);
    }
    return [...lines.values()];
  };
  const report = (req, reportId) => {
    const r = db.prepare(`${REPORT} WHERE r.id = ?`).get(Number(reportId));
    if (!r || !req.user.site_ids.includes(r.location_id)) throw notFound('Par level report');
    return r;
  };

  router.get('/par-levels', perm, (req, res) => {
    const { from, to } = window(req.query);
    const sites = req.user.site_ids;
    const inList = sites.map(() => '?').join(', ') || 'NULL';
    // Categories sold at any of their sites in the window (the first filter), most sold first.
    const categories = db.prepare(`SELECT ${CATEGORY} AS name, SUM(si.quantity) AS sold FROM sales_items si
      LEFT JOIN square_catalog c ON c.variation_id = si.catalog_object_id
      WHERE si.date BETWEEN ? AND ? AND si.location_id IN (${inList}) GROUP BY 1 ORDER BY name = '${UNCATEGORISED}', name`).all(from, to, ...sites)
      .map((c) => c.name);
    const savedCats = db.prepare(`SELECT DISTINCT category FROM par_reports WHERE location_id IN (${inList})`).all(...sites).map((r) => r.category);
    for (const c of savedCats) if (!categories.includes(c)) categories.push(c);
    const category = categories.includes(req.query.category) ? req.query.category : null;
    const base = { from, to, weeks: PAR_WEEKS, categories, category, catalog_synced: !!db.prepare('SELECT 1 FROM square_catalog LIMIT 1').get() };
    if (!category || !req.query.location_id) return res.json({ ...base, location_id: null, items: [] });
    const locationId = resolveLocation(req, req.query.location_id);

    // Days the site traded, per weekday (a day it was shut doesn't pull the average down).
    const traded = Array(7).fill(0);
    for (const d of db.prepare('SELECT date FROM sales_daily WHERE location_id = ? AND date BETWEEN ? AND ? AND orders > 0').all(locationId, from, to)) traded[weekdayOf(d.date)]++;
    const items = new Map();
    for (const r of db.prepare(`SELECT si.item_key, si.date, si.quantity, COALESCE(c.item_name, si.name) AS name,
        COALESCE(c.variation_name, si.variation_name) AS variation, c.item_id
      FROM sales_items si LEFT JOIN square_catalog c ON c.variation_id = si.catalog_object_id
      WHERE si.location_id = ? AND si.date BETWEEN ? AND ? AND ${CATEGORY} = ?`).all(locationId, from, to, category)) {
      const it = items.get(r.item_key) ?? { item_key: r.item_key, name: r.name, variation: r.variation, item_id: r.item_id, sold: Array(7).fill(0) };
      it.sold[weekdayOf(r.date)] += r.quantity;
      items.set(r.item_key, it);
    }
    // An item sold in more than one size shows the size ("Latte – Large"); one size, just the item.
    const sizes = new Map();
    for (const it of items.values()) sizes.set(it.item_id ?? it.name, (sizes.get(it.item_id ?? it.name) ?? 0) + 1);
    const list = [...items.values()].map((it) => ({
      item_key: it.item_key,
      name: sizes.get(it.item_id ?? it.name) > 1 && it.variation ? `${it.name} – ${it.variation}` : it.name,
      avg: it.sold.map((q, i) => (traded[i] ? round2(q / traded[i]) : 0)),
      total: round2(it.sold.reduce((a, b) => a + b, 0)),
    }));
    // Editing a saved report (?report=id): its items still appear even if they haven't sold lately.
    const editing = req.query.report ? report(req, req.query.report) : null;
    const saved = editing && editing.location_id === locationId && editing.category === category ? linesOf(editing.id) : [];
    for (const l of saved) {
      if (!list.some((i) => i.item_key === l.item_key)) list.push({ item_key: l.item_key, name: l.item_name, avg: Array(7).fill(0), total: 0 });
    }
    list.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    res.json({ ...base, location_id: locationId, days_traded: traded, items: list, report: editing ? { ...editing, lines: saved } : null });
  });

  // Saved reports at this person's sites, newest first.
  router.get('/par-levels/reports', perm, (req, res) => {
    const sites = req.user.site_ids;
    const inList = sites.map(() => '?').join(', ') || 'NULL';
    res.json(db.prepare(`${REPORT} WHERE r.location_id IN (${inList}) ORDER BY r.updated_at DESC, r.id DESC`).all(...sites).map((r) => ({
      ...r, items: db.prepare('SELECT COUNT(DISTINCT item_key) AS n FROM par_report_lines WHERE report_id = ?').get(r.id).n,
    })));
  });
  router.get('/par-levels/reports/:id', perm, (req, res) => {
    const r = report(req, req.params.id);
    res.json({ ...r, lines: linesOf(r.id) });
  });

  // { name, location_id, category, lines: [{ item_key, item_name, pars: [Mon … Sun] }] }. Only budgeted levels (a
  // number, 0 included) are kept, and items with none are left out.
  const body = (req) => {
    const b = req.body ?? {};
    const locationId = resolveLocation(req, b.location_id);
    assertLocation(req, locationId);
    if (!Array.isArray(b.lines)) throw badRequest('lines must be a list');
    const lines = b.lines.map((l, i) => ({
      item_key: str(l.item_key, `lines[${i}].item_key`, { required: true, max: 300 }),
      item_name: str(l.item_name, `lines[${i}].item_name`, { required: true, max: 300 }),
      pars: Array.from({ length: 7 }, (_, d) => num(l.pars?.[d], `lines[${i}].pars[${d}]`, { min: 0, max: 100000 })),
    })).filter((l) => l.pars.some((p) => p !== null && p !== undefined));
    if (!lines.length) throw badRequest('Put in at least one par level first');
    return { name: str(b.name, 'name', { required: true, max: 120 }), location_id: locationId, category: str(b.category, 'category', { required: true, max: 200 }),
      sales_from: date(b.sales_from, 'sales_from'), sales_to: date(b.sales_to, 'sales_to'), lines };
  };
  const saveLines = (reportId, lines) => {
    db.prepare('DELETE FROM par_report_lines WHERE report_id = ?').run(reportId);
    const ins = db.prepare('INSERT INTO par_report_lines (report_id, item_key, item_name, weekday, par) VALUES (?, ?, ?, ?, ?)');
    for (const l of lines) l.pars.forEach((p, d) => { if (p !== null && p !== undefined) ins.run(reportId, l.item_key, l.item_name, d, p); });
  };
  router.post('/par-levels/reports', perm, (req, res) => {
    const b = body(req);
    const id = tx(db, () => {
      const r = db.prepare('INSERT INTO par_reports (name, location_id, category, sales_from, sales_to, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(b.name, b.location_id, b.category, b.sales_from, b.sales_to, req.user.name, req.user.name);
      saveLines(r.lastInsertRowid, b.lines);
      return Number(r.lastInsertRowid);
    });
    res.status(201).json({ ...report(req, id), lines: linesOf(id) });
  });
  router.put('/par-levels/reports/:id', perm, (req, res) => {
    const r = report(req, req.params.id);
    const b = body(req);
    tx(db, () => {
      db.prepare(`UPDATE par_reports SET name = ?, location_id = ?, category = ?, sales_from = ?, sales_to = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(b.name, b.location_id, b.category, b.sales_from, b.sales_to, req.user.name, r.id);
      saveLines(r.id, b.lines);
    });
    res.json({ ...report(req, r.id), lines: linesOf(r.id) });
  });
  router.delete('/par-levels/reports/:id', perm, (req, res) => {
    const r = report(req, req.params.id);
    db.prepare('DELETE FROM par_reports WHERE id = ?').run(r.id);
    res.json({ ok: true });
  });
}
