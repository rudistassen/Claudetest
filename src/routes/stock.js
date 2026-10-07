import { assertLocation, can, reportLocations, requirePerm, resolveLocation } from '../auth.js';
import { tx } from '../db.js';
import { loadRecipes } from '../recipes.js';
import { addDays, badRequest, csv, date, forbidden, id, notFound, num, oneOf, round2, str, today } from '../util.js';

export const WASTAGE_REASONS = [
  'Out of date',
  'Spoiled / quality',
  'Damaged',
  'Over-production',
  'Preparation error',
  'Customer return',
  'Dropped / spilled',
  'Temperature failure',
  'Other',
];

export function registerStockRoutes(router, db) {
  // --- Stock takes ---

  const takeSelect = `
    SELECT t.*, l.name AS location_name, su.name AS started_by_name, cu.name AS completed_by_name,
      (SELECT COALESCE(SUM(COALESCE(counted_quantity, 0) * unit_cost), 0) FROM stock_take_lines WHERE stock_take_id = t.id) AS total_value,
      (SELECT COUNT(*) FROM stock_take_lines WHERE stock_take_id = t.id) AS line_count,
      (SELECT COUNT(*) FROM stock_take_lines WHERE stock_take_id = t.id AND counted_quantity IS NOT NULL) AS counted_count
    FROM stock_takes t
    JOIN locations l ON l.id = t.location_id
    LEFT JOIN users su ON su.id = t.started_by
    LEFT JOIN users cu ON cu.id = t.completed_by`;

  function loadTake(req) {
    const take = db.prepare(`${takeSelect} WHERE t.id = ?`).get(Number(req.params.id));
    if (!take) throw notFound('Stock take');
    assertLocation(req, take.location_id);
    take.total_value = round2(take.total_value);
    return take;
  }

  router.get('/stocktakes', requirePerm('stock.count', 'stock.complete'), (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    const rows = db.prepare(`${takeSelect} WHERE t.location_id = ? ORDER BY t.started_at DESC, t.id DESC LIMIT 100`).all(locationId);
    for (const r of rows) r.total_value = round2(r.total_value);
    res.json(rows);
  });

  // Starts a count for a location, or returns the one already in progress.
  router.post('/stocktakes', requirePerm('stock.count'), (req, res) => {
    const locationId = resolveLocation(req, req.body.location_id);
    const existing = db.prepare(`SELECT id FROM stock_takes WHERE location_id = ? AND status = 'in_progress'`).get(locationId);
    if (existing) {
      req.params.id = String(existing.id);
      return res.json(loadTake(req));
    }
    const takeId = tx(db, () => {
      const r = db.prepare('INSERT INTO stock_takes (location_id, notes, started_by) VALUES (?, ?, ?)')
        .run(locationId, str(req.body.notes, 'notes'), req.user.id);
      db.prepare(`INSERT INTO stock_take_lines (stock_take_id, product_id, unit_cost)
        SELECT ?, id, unit_cost FROM products WHERE active = 1`).run(r.lastInsertRowid);
      return r.lastInsertRowid;
    });
    req.params.id = String(takeId);
    res.status(201).json(loadTake(req));
  });

  router.get('/stocktakes/:id', requirePerm('stock.count', 'stock.complete'), (req, res) => {
    const take = loadTake(req);
    const previous = db.prepare(`SELECT id, completed_at FROM stock_takes WHERE location_id = ? AND status = 'completed' AND id != ?
      AND (completed_at < COALESCE(?, datetime('now', '+1 day'))) ORDER BY completed_at DESC, id DESC LIMIT 1`)
      .get(take.location_id, take.id, take.completed_at);
    take.previous = previous ?? null;
    take.lines = db.prepare(`
      SELECT stl.product_id, stl.counted_quantity, stl.unit_cost, p.name, p.category, p.unit, p.sku,
        prev.counted_quantity AS previous_quantity
      FROM stock_take_lines stl
      JOIN products p ON p.id = stl.product_id
      LEFT JOIN stock_take_lines prev ON prev.product_id = stl.product_id AND prev.stock_take_id = ?
      WHERE stl.stock_take_id = ?
      ORDER BY p.category, p.name`).all(previous?.id ?? 0, take.id);
    res.json(take);
  });

  router.put('/stocktakes/:id/lines', requirePerm('stock.count'), (req, res) => {
    const take = loadTake(req);
    if (take.status !== 'in_progress') throw badRequest('This stock take has been completed');
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    tx(db, () => {
      const update = db.prepare('UPDATE stock_take_lines SET counted_quantity = ? WHERE stock_take_id = ? AND product_id = ?');
      for (const l of lines) {
        update.run(num(l.counted_quantity, 'counted_quantity', { min: 0 }), take.id, id(l.product_id, 'product_id', { required: true }));
      }
    });
    res.json(loadTake(req));
  });

  router.post('/stocktakes/:id/complete', requirePerm('stock.complete'), (req, res) => {
    const take = loadTake(req);
    if (take.status !== 'in_progress') throw badRequest('This stock take is already completed');
    const uncounted = take.line_count - take.counted_count;
    if (uncounted > 0 && !req.body.zero_uncounted) {
      throw badRequest(`${uncounted} item(s) have not been counted yet`);
    }
    tx(db, () => {
      db.prepare('UPDATE stock_take_lines SET counted_quantity = 0 WHERE stock_take_id = ? AND counted_quantity IS NULL').run(take.id);
      db.prepare(`UPDATE stock_takes SET status = 'completed', completed_by = ?, completed_at = datetime('now') WHERE id = ?`)
        .run(req.user.id, take.id);
    });
    res.json(loadTake(req));
  });

  router.delete('/stocktakes/:id', requirePerm('stock.complete'), (req, res) => {
    const take = loadTake(req);
    if (take.status !== 'in_progress') throw badRequest('Completed stock takes cannot be deleted');
    db.prepare('DELETE FROM stock_takes WHERE id = ?').run(take.id);
    res.json({ ok: true });
  });

  // --- Wastage ---

  router.get('/wastage/reasons', (_req, res) => res.json(WASTAGE_REASONS));

  function wastageRange(q) {
    const to = date(q.to, 'to') ?? today();
    const from = date(q.from, 'from') ?? addDays(to, -6);
    if (from > to) throw badRequest('from must be before to');
    return { from, to };
  }

  // One site, or with no location_id every site the user can access.
  function wastageRows(req) {
    const { from, to } = wastageRange(req.query);
    const ids = reportLocations(req, req.query.location_id).map((l) => l.id);
    const sql = `SELECT w.*, l.name AS location_name, u.name AS recorded_by_name FROM wastage w
      JOIN locations l ON l.id = w.location_id LEFT JOIN users u ON u.id = w.recorded_by
      WHERE w.date BETWEEN ? AND ? AND w.location_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY w.date DESC, w.id DESC`;
    return { from, to, ids, rows: db.prepare(sql).all(from, to, ...ids) };
  }

  router.get('/wastage', requirePerm('wastage.record', 'wastage.reports', 'wastage.manage'), (req, res) => {
    const { rows } = wastageRows(req);
    res.json(rows.slice(0, 500));
  });

  router.post('/wastage', requirePerm('wastage.record'), (req, res) => {
    const b = req.body;
    const locationId = resolveLocation(req, b.location_id);
    const productId = id(b.product_id, 'product_id');
    const product = productId ? db.prepare('SELECT * FROM products WHERE id = ?').get(productId) : null;
    if (productId && !product) throw notFound('Product');
    // A made item (e.g. a toastie) can be logged against its recipe, costed at the recipe's cost per portion.
    const recipeId = productId ? null : id(b.recipe_id, 'recipe_id');
    const recipe = recipeId ? loadRecipes(db).find((r) => r.id === recipeId) : null;
    if (recipeId && !recipe) throw notFound('Recipe');
    const itemName = product?.name ?? recipe?.name ?? str(b.item_name, 'item_name', { required: true, max: 150 });
    const quantity = num(b.quantity, 'quantity', { required: true, min: 0.001 });
    const unitCost = recipe ? (recipe.kind === 'prep' ? recipe.cost_per_unit : recipe.cost_per_portion) : num(b.unit_cost, 'unit_cost', { min: 0 }) ?? product?.unit_cost ?? 0;
    const entryDate = date(b.date, 'date') ?? today();
    if (entryDate > today()) throw badRequest('Wastage cannot be recorded for a future date');
    const r = db.prepare(`INSERT INTO wastage (location_id, product_id, recipe_id, item_name, quantity, unit, unit_cost, total_cost, reason, notes, date, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(locationId, product?.id ?? null, recipe?.id ?? null, itemName, quantity,
        product?.unit ?? (recipe ? (recipe.kind === 'prep' ? recipe.yield_unit : 'portion') : null) ?? str(b.unit, 'unit', { max: 30 }) ?? 'each',
        unitCost, round2(quantity * unitCost), oneOf(b.reason, 'reason', WASTAGE_REASONS, { required: true }),
        str(b.notes, 'notes'), entryDate, req.user.id);
    res.status(201).json(db.prepare('SELECT * FROM wastage WHERE id = ?').get(r.lastInsertRowid));
  });

  router.delete('/wastage/:id', requirePerm('wastage.record', 'wastage.manage'), (req, res) => {
    const entry = db.prepare('SELECT * FROM wastage WHERE id = ?').get(Number(req.params.id));
    if (!entry) throw notFound('Wastage entry');
    assertLocation(req, entry.location_id);
    const ownToday = entry.recorded_by === req.user.id && entry.date === today();
    if (!can(req.user, 'wastage.manage') && !ownToday) throw forbidden('You can only remove your own entries from today');
    db.prepare('DELETE FROM wastage WHERE id = ?').run(entry.id);
    res.json({ ok: true });
  });

  router.get('/wastage/report', requirePerm('wastage.reports'), (req, res) => {
    const { from, to, ids, rows } = wastageRows(req);
    const group = (keyFn) => {
      const m = new Map();
      for (const r of rows) {
        const k = keyFn(r);
        const g = m.get(k) ?? { key: k, total_cost: 0, entries: 0, quantity: 0 };
        g.total_cost += r.total_cost;
        g.quantity += r.quantity;
        g.entries += 1;
        m.set(k, g);
      }
      return [...m.values()].map((g) => ({ ...g, total_cost: round2(g.total_cost), quantity: round2(g.quantity) }))
        .sort((a, b) => b.total_cost - a.total_cost);
    };
    const totalCost = round2(rows.reduce((s, r) => s + r.total_cost, 0));
    let sales = null;
    if (can(req.user, 'sales.view')) {
      const r = db.prepare(`SELECT COALESCE(SUM(net_sales), 0) AS net, COUNT(*) AS n FROM sales_daily
        WHERE date BETWEEN ? AND ? AND location_id IN (${ids.map(() => '?').join(', ')})`).get(from, to, ...ids);
      if (r.n) sales = { net_sales: round2(r.net), wastage_pct: r.net > 0 ? round2((totalCost / r.net) * 100) : null };
    }
    res.json({
      from,
      to,
      sales,
      total_cost: totalCost,
      entries: rows.length,
      by_location: group((r) => r.location_name),
      by_reason: group((r) => r.reason),
      by_item: group((r) => r.item_name).slice(0, 15),
      by_day: group((r) => r.date).sort((a, b) => a.key.localeCompare(b.key)),
    });
  });

  router.get('/wastage/export.csv', requirePerm('wastage.reports'), (req, res) => {
    const { from, to, rows } = wastageRows(req);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="wastage_${from}_${to}.csv"`);
    res.send(csv(rows, [
      { key: 'date', label: 'Date' },
      { key: 'location_name', label: 'Location' },
      { key: 'item_name', label: 'Item' },
      { key: 'quantity', label: 'Quantity' },
      { key: 'unit', label: 'Unit' },
      { key: 'unit_cost', label: 'Unit cost' },
      { key: 'total_cost', label: 'Total cost' },
      { key: 'reason', label: 'Reason' },
      { key: 'notes', label: 'Notes' },
      { key: 'recorded_by_name', label: 'Recorded by' },
    ]));
  });
}
