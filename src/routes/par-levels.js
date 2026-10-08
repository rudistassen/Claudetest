// Reporting → Par levels: for one Square category at one site, each item's average sold on each day of the week
// over the last 6 full weeks (Monday to Sunday), and the par level budgeted for each day. A sheet is worked on as a
// draft and saved as a final version, which keeps just the budgeted par levels.
import { assertLocation, requirePerm, resolveLocation } from '../auth.js';
import { tx } from '../db.js';
import { addDays, badRequest, num, round2, str, today, weekStart } from '../util.js';

export const PAR_WEEKS = 6;
const UNCATEGORISED = 'Uncategorised';
const weekdayOf = (iso) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;

export function registerParLevelRoutes(router, db) {
  const perm = requirePerm('sales.view');
  const window = () => { const to = addDays(weekStart(today()), -1); return { from: addDays(to, -(PAR_WEEKS * 7 - 1)), to }; };
  const CATEGORY = `COALESCE(NULLIF(c.category_name, ''), '${UNCATEGORISED}')`;

  const sheet = (locationId, category, version) => {
    const meta = db.prepare('SELECT saved_by, saved_at FROM par_sheets WHERE location_id = ? AND category = ? AND version = ?').get(locationId, category, version);
    if (!meta) return null;
    const lines = new Map();
    for (const r of db.prepare('SELECT item_key, item_name, weekday, par FROM par_levels WHERE location_id = ? AND category = ? AND version = ? ORDER BY item_name')
      .all(locationId, category, version)) {
      const l = lines.get(r.item_key) ?? { item_key: r.item_key, item_name: r.item_name, pars: Array(7).fill(null) };
      l.pars[r.weekday] = r.par;
      lines.set(r.item_key, l);
    }
    return { ...meta, lines: [...lines.values()] };
  };

  router.get('/par-levels', perm, (req, res) => {
    const { from, to } = window();
    const sites = req.user.site_ids;
    const inList = sites.map(() => '?').join(', ') || 'NULL';
    // Categories sold at any of their sites in the window (the first filter), most sold first.
    const categories = db.prepare(`SELECT ${CATEGORY} AS name, SUM(si.quantity) AS sold FROM sales_items si
      LEFT JOIN square_catalog c ON c.variation_id = si.catalog_object_id
      WHERE si.date BETWEEN ? AND ? AND si.location_id IN (${inList}) GROUP BY 1 ORDER BY name = '${UNCATEGORISED}', name`).all(from, to, ...sites)
      .map((c) => c.name);
    const saved = db.prepare(`SELECT DISTINCT category FROM par_sheets WHERE location_id IN (${inList})`).all(...sites).map((r) => r.category);
    for (const c of saved) if (!categories.includes(c)) categories.push(c);
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
    // Items on a saved sheet that haven't sold lately still appear, so their par levels can be seen and changed.
    const draft = sheet(locationId, category, 'draft');
    const final = sheet(locationId, category, 'final');
    for (const l of [...(draft?.lines ?? []), ...(final?.lines ?? [])]) {
      if (!list.some((i) => i.item_key === l.item_key)) list.push({ item_key: l.item_key, name: l.item_name, avg: Array(7).fill(0), total: 0 });
    }
    list.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    res.json({ ...base, location_id: locationId, days_traded: traded, items: list, draft, final });
  });

  // Saves the par levels: { location_id, category, version: 'draft' | 'final', lines: [{ item_key, item_name, pars: [Mon … Sun] }] }.
  // Saving the final version saves the draft too, so they match; the final keeps only items with a par level.
  router.put('/par-levels', perm, (req, res) => {
    const b = req.body ?? {};
    const locationId = resolveLocation(req, b.location_id);
    assertLocation(req, locationId);
    const category = str(b.category, 'category', { required: true, max: 200 });
    const version = b.version === 'final' ? 'final' : 'draft';
    if (!Array.isArray(b.lines)) throw badRequest('lines must be a list');
    const lines = b.lines.map((l, i) => ({
      item_key: str(l.item_key, `lines[${i}].item_key`, { required: true, max: 300 }),
      item_name: str(l.item_name, `lines[${i}].item_name`, { required: true, max: 300 }),
      pars: Array.from({ length: 7 }, (_, d) => num(l.pars?.[d], `lines[${i}].pars[${d}]`, { min: 0, max: 100000 })),
    }));
    const save = (v) => {
      db.prepare('DELETE FROM par_levels WHERE location_id = ? AND category = ? AND version = ?').run(locationId, category, v);
      const ins = db.prepare('INSERT INTO par_levels (location_id, category, version, item_key, item_name, weekday, par) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const l of lines) l.pars.forEach((p, d) => { if (p !== null && p !== undefined && (v === 'draft' || p > 0)) ins.run(locationId, category, v, l.item_key, l.item_name, d, p); });
      db.prepare(`INSERT INTO par_sheets (location_id, category, version, saved_by, saved_at) VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT (location_id, category, version) DO UPDATE SET saved_by = excluded.saved_by, saved_at = excluded.saved_at`).run(locationId, category, v, req.user.name);
    };
    tx(db, () => { save('draft'); if (version === 'final') save('final'); });
    res.json({ ok: true, version, draft: sheet(locationId, category, 'draft'), final: sheet(locationId, category, 'final') });
  });
}
