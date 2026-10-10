// Prep kitchen ordering: each site orders prepped recipes (sauces, fillings, bakes) from the prep kitchen for a
// day, in each recipe's yield unit. The prep list adds up every site's orders for a day, in batches to make.
import { assertLocation, requirePerm } from '../auth.js';
import { tx } from '../db.js';
import { loadRecipes } from '../recipes.js';
import { badRequest, date, id, notFound, num, round2, str, today } from '../util.js';

export function registerPrepOrderRoutes(router, db) {
  const perm = requirePerm('orders.manage');

  // The prepped recipes that can be ordered, with their yield and cost.
  const prepRecipes = () => loadRecipes(db).filter((r) => r.kind === 'prep' && r.active)
    .map((r) => ({ id: r.id, name: r.name, category: r.category, yield_quantity: r.yield_quantity, yield_unit: r.yield_unit,
      cost_per_unit: r.cost_per_unit, allergens: r.allergens, shelf_life: r.shelf_life }));

  const withLines = (orders) => {
    if (!orders.length) return [];
    const lines = db.prepare(`SELECT l.order_id, l.recipe_id, l.quantity, r.name, COALESCE(r.yield_unit, 'portion') AS unit
      FROM prep_order_lines l JOIN recipes r ON r.id = l.recipe_id WHERE l.order_id IN (${orders.map(() => '?').join(', ')}) ORDER BY r.name`)
      .all(...orders.map((o) => o.id));
    return orders.map((o) => ({ ...o, lines: lines.filter((l) => l.order_id === o.id) }));
  };
  const ORDER_SELECT = `SELECT o.*, l.name AS location_name, u.name AS created_by_name FROM prep_orders o
    JOIN locations l ON l.id = o.location_id LEFT JOIN users u ON u.id = o.created_by`;
  const visible = (req) => req.user.site_ids;
  const order = (req, orderId) => {
    const o = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(orderId);
    if (!o || !visible(req).includes(o.location_id)) throw notFound('Prep order');
    return o;
  };

  // The recipes to order from, and the orders from the sites this person can see: from a day (default today) on,
  // plus the last two weeks.
  router.get('/prep-orders', perm, (req, res) => {
    const sites = visible(req);
    const from = date(req.query.from, 'from') ?? today();
    const orders = sites.length ? db.prepare(`${ORDER_SELECT} WHERE o.location_id IN (${sites.map(() => '?').join(', ')})
      AND o.needed_on >= date(?, '-14 days') ORDER BY o.needed_on DESC, l.name LIMIT 300`).all(...sites, from) : [];
    res.json({ recipes: prepRecipes(), orders: withLines(orders) });
  });

  // The prep list for a day: everything ordered for it, by recipe, with each site's amount and the batches to make.
  router.get('/prep-orders/list', perm, (req, res) => {
    const day = date(req.query.date, 'date') ?? today();
    const sites = visible(req);
    const orders = sites.length ? withLines(db.prepare(`${ORDER_SELECT} WHERE o.needed_on = ? AND o.location_id IN (${sites.map(() => '?').join(', ')}) ORDER BY l.name`)
      .all(day, ...sites)) : [];
    const recipes = new Map(prepRecipes().map((r) => [r.id, r]));
    const byRecipe = new Map();
    for (const o of orders) {
      for (const l of o.lines) {
        const r = recipes.get(l.recipe_id) ?? { id: l.recipe_id, name: l.name, yield_unit: l.unit, yield_quantity: null };
        const t = byRecipe.get(l.recipe_id) ?? { recipe_id: r.id, name: r.name, unit: r.yield_unit ?? l.unit, yield_quantity: r.yield_quantity, total: 0, sites: [] };
        t.total += l.quantity;
        t.sites.push({ location_id: o.location_id, location_name: o.location_name, quantity: l.quantity, status: o.status });
        byRecipe.set(l.recipe_id, t);
      }
    }
    const items = [...byRecipe.values()].map((t) => ({
      ...t,
      total: round2(t.total),
      batches: t.yield_quantity ? round2(t.total / t.yield_quantity) : null,
      batches_to_make: t.yield_quantity ? Math.ceil(t.total / t.yield_quantity - 1e-9) : null,
    })).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ date: day, orders, items });
  });

  function body(req, existing = null) {
    const b = req.body ?? {};
    const locationId = existing ? existing.location_id : id(b.location_id, 'location_id', { required: true });
    assertLocation(req, locationId);
    const neededOn = date(b.needed_on, 'Needed on', { required: !existing }) ?? existing.needed_on;
    const lines = (Array.isArray(b.lines) ? b.lines : [])
      .map((l) => ({ recipe_id: id(l.recipe_id, 'recipe_id', { required: true }), quantity: num(l.quantity, 'quantity', { min: 0 }) ?? 0 }))
      .filter((l) => l.quantity > 0);
    if (!lines.length) throw badRequest('Enter how much of at least one prepped recipe you need');
    for (const l of lines) {
      if (!db.prepare(`SELECT 1 FROM recipes WHERE id = ? AND kind = 'prep'`).get(l.recipe_id)) throw notFound('Prepped recipe');
    }
    return { location_id: locationId, needed_on: neededOn, notes: str(b.notes, 'notes', { max: 1000 }), lines };
  }
  const saveLines = (orderId, lines) => {
    db.prepare('DELETE FROM prep_order_lines WHERE order_id = ?').run(orderId);
    const ins = db.prepare('INSERT INTO prep_order_lines (order_id, recipe_id, quantity) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET quantity = quantity + excluded.quantity');
    for (const l of lines) ins.run(orderId, l.recipe_id, l.quantity);
  };

  router.post('/prep-orders', perm, (req, res) => {
    const o = body(req);
    const orderId = tx(db, () => {
      const r = db.prepare('INSERT INTO prep_orders (location_id, needed_on, notes, created_by) VALUES (?, ?, ?, ?)').run(o.location_id, o.needed_on, o.notes, req.user.id);
      saveLines(r.lastInsertRowid, o.lines);
      return Number(r.lastInsertRowid);
    });
    res.status(201).json(withLines([order(req, orderId)])[0]);
  });

  router.put('/prep-orders/:id', perm, (req, res) => {
    const existing = order(req, Number(req.params.id));
    if (existing.status === 'sent') throw badRequest('This order has been sent from the prep kitchen, so it can’t be changed');
    const o = body(req, existing);
    tx(db, () => {
      db.prepare(`UPDATE prep_orders SET needed_on = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`).run(o.needed_on, o.notes, existing.id);
      saveLines(existing.id, o.lines);
    });
    res.json(withLines([order(req, existing.id)])[0]);
  });

  // The prep kitchen marks an order as sent to the site (or back to ordered).
  router.post('/prep-orders/:id/sent', perm, (req, res) => {
    const o = order(req, Number(req.params.id));
    const sent = req.body?.sent !== false;
    db.prepare(`UPDATE prep_orders SET status = ?, sent_at = ${sent ? "datetime('now')" : 'NULL'}, updated_at = datetime('now') WHERE id = ?`).run(sent ? 'sent' : 'ordered', o.id);
    res.json({ ok: true, status: sent ? 'sent' : 'ordered' });
  });

  router.delete('/prep-orders/:id', perm, (req, res) => {
    const o = order(req, Number(req.params.id));
    if (o.status === 'sent') throw badRequest('This order has been sent, so it can’t be deleted');
    db.prepare('DELETE FROM prep_orders WHERE id = ?').run(o.id);
    res.json({ ok: true });
  });
}
