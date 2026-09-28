import { assertLocation, requireAdmin, requireManager, resolveLocation } from '../auth.js';
import { tx } from '../db.js';
import { badRequest, bool, date, id, notFound, num, round2, str } from '../util.js';

export function registerOrderingRoutes(router, db) {
  // --- Suppliers ---

  router.get('/suppliers', (_req, res) => {
    res.json(db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id AND p.active = 1) AS product_count
      FROM suppliers s ORDER BY s.active DESC, s.name`).all());
  });

  const supplierBody = (b) => ({
    name: str(b.name, 'name', { required: true, max: 100 }),
    contact_name: str(b.contact_name, 'contact_name', { max: 100 }),
    email: str(b.email, 'email', { max: 200 }),
    phone: str(b.phone, 'phone', { max: 50 }),
    order_days: str(b.order_days, 'order_days', { max: 100 }),
    lead_time_days: num(b.lead_time_days, 'lead_time_days', { min: 0, max: 60, int: true }) ?? 1,
    min_order: num(b.min_order, 'min_order', { min: 0 }) ?? 0,
    notes: str(b.notes, 'notes'),
    active: b.active === undefined ? 1 : bool(b.active),
  });
  const supplierCols = ['name', 'contact_name', 'email', 'phone', 'order_days', 'lead_time_days', 'min_order', 'notes', 'active'];

  router.post('/suppliers', requireAdmin, (req, res) => {
    const s = supplierBody(req.body);
    const r = db.prepare(`INSERT INTO suppliers (${supplierCols.join(', ')}) VALUES (${supplierCols.map(() => '?').join(', ')})`)
      .run(...supplierCols.map((c) => s[c]));
    res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(r.lastInsertRowid));
  });

  router.put('/suppliers/:id', requireAdmin, (req, res) => {
    const s = supplierBody(req.body);
    const r = db.prepare(`UPDATE suppliers SET ${supplierCols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...supplierCols.map((c) => s[c]), Number(req.params.id));
    if (!r.changes) throw notFound('Supplier');
    res.json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(req.params.id)));
  });

  // --- Products ---

  router.get('/products', (_req, res) => {
    res.json(db.prepare(`SELECT p.*, s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
      ORDER BY p.active DESC, p.category, p.name`).all());
  });

  const productBody = (b) => {
    const p = {
      name: str(b.name, 'name', { required: true, max: 150 }),
      sku: str(b.sku, 'sku', { max: 50 }),
      category: str(b.category, 'category', { max: 100 }),
      unit: str(b.unit, 'unit', { max: 30 }) ?? 'each',
      supplier_id: id(b.supplier_id, 'supplier_id'),
      unit_cost: num(b.unit_cost, 'unit_cost', { min: 0 }) ?? 0,
      par_level: num(b.par_level, 'par_level', { min: 0 }) ?? 0,
      active: b.active === undefined ? 1 : bool(b.active),
    };
    if (p.supplier_id && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(p.supplier_id)) throw notFound('Supplier');
    return p;
  };
  const productCols = ['name', 'sku', 'category', 'unit', 'supplier_id', 'unit_cost', 'par_level', 'active'];

  router.post('/products', requireAdmin, (req, res) => {
    const p = productBody(req.body);
    const r = db.prepare(`INSERT INTO products (${productCols.join(', ')}) VALUES (${productCols.map(() => '?').join(', ')})`)
      .run(...productCols.map((c) => p[c]));
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(r.lastInsertRowid));
  });

  router.put('/products/:id', requireAdmin, (req, res) => {
    const p = productBody(req.body);
    const r = db.prepare(`UPDATE products SET ${productCols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...productCols.map((c) => p[c]), Number(req.params.id));
    if (!r.changes) throw notFound('Product');
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id)));
  });

  // Per-location par levels override the product default.
  router.get('/products/:id/pars', requireManager, (req, res) => {
    const product = db.prepare('SELECT id, name, par_level FROM products WHERE id = ?').get(Number(req.params.id));
    if (!product) throw notFound('Product');
    const pars = db.prepare(`SELECT l.id AS location_id, l.name AS location_name, pp.par_level
      FROM locations l LEFT JOIN product_pars pp ON pp.location_id = l.id AND pp.product_id = ?
      WHERE l.active = 1 ORDER BY l.name`).all(product.id);
    res.json({ product, pars });
  });

  router.put('/products/:id/pars', requireManager, (req, res) => {
    const productId = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(productId)) throw notFound('Product');
    const pars = Array.isArray(req.body.pars) ? req.body.pars : [];
    tx(db, () => {
      for (const p of pars) {
        const locationId = id(p.location_id, 'location_id', { required: true });
        assertLocation(req, locationId);
        const level = num(p.par_level, 'par_level', { min: 0 });
        if (level === null) db.prepare('DELETE FROM product_pars WHERE product_id = ? AND location_id = ?').run(productId, locationId);
        else db.prepare(`INSERT INTO product_pars (product_id, location_id, par_level) VALUES (?, ?, ?)
          ON CONFLICT (product_id, location_id) DO UPDATE SET par_level = excluded.par_level`).run(productId, locationId, level);
      }
    });
    res.json({ ok: true });
  });

  // --- Purchase orders ---

  const orderSelect = `
    SELECT o.*, s.name AS supplier_name, s.email AS supplier_email, l.name AS location_name, u.name AS created_by_name,
      (SELECT COALESCE(SUM(quantity * unit_cost), 0) FROM purchase_order_lines WHERE order_id = o.id) AS total,
      (SELECT COUNT(*) FROM purchase_order_lines WHERE order_id = o.id) AS line_count
    FROM purchase_orders o
    JOIN suppliers s ON s.id = o.supplier_id
    JOIN locations l ON l.id = o.location_id
    LEFT JOIN users u ON u.id = o.created_by`;

  function loadOrder(req) {
    const order = db.prepare(`${orderSelect} WHERE o.id = ?`).get(Number(req.params.id));
    if (!order) throw notFound('Order');
    assertLocation(req, order.location_id);
    order.total = round2(order.total);
    order.lines = db.prepare(`SELECT ol.*, p.name AS product_name, p.unit, p.sku FROM purchase_order_lines ol
      JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY p.category, p.name`).all(order.id);
    return order;
  }

  router.get('/orders', requireManager, (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    const status = str(req.query.status, 'status');
    const rows = status
      ? db.prepare(`${orderSelect} WHERE o.location_id = ? AND o.status = ? ORDER BY o.created_at DESC LIMIT 200`).all(locationId, status)
      : db.prepare(`${orderSelect} WHERE o.location_id = ? ORDER BY o.created_at DESC LIMIT 200`).all(locationId);
    for (const r of rows) r.total = round2(r.total);
    res.json(rows);
  });

  // Suggested quantities: par level minus what was on hand at the last completed stock take.
  router.get('/orders/suggest', requireManager, (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    const supplierId = id(req.query.supplier_id, 'supplier_id', { required: true });
    const lastTake = db.prepare(`SELECT id, completed_at FROM stock_takes WHERE location_id = ? AND status = 'completed'
      ORDER BY completed_at DESC, id DESC LIMIT 1`).get(locationId);
    const rows = db.prepare(`
      SELECT p.id AS product_id, p.name, p.sku, p.category, p.unit, p.unit_cost,
        COALESCE(pp.par_level, p.par_level) AS par_level, stl.counted_quantity AS on_hand
      FROM products p
      LEFT JOIN product_pars pp ON pp.product_id = p.id AND pp.location_id = ?
      LEFT JOIN stock_take_lines stl ON stl.product_id = p.id AND stl.stock_take_id = ?
      WHERE p.supplier_id = ? AND p.active = 1
      ORDER BY p.category, p.name`).all(locationId, lastTake?.id ?? 0, supplierId);
    for (const r of rows) {
      r.suggested = r.on_hand === null ? 0 : Math.max(0, Math.ceil(r.par_level - r.on_hand));
    }
    res.json({ last_stock_take: lastTake ?? null, products: rows });
  });

  router.get('/orders/:id', requireManager, (req, res) => res.json(loadOrder(req)));

  function parseLines(raw) {
    if (!Array.isArray(raw)) throw badRequest('lines must be a list');
    const lines = raw
      .map((l) => ({ product_id: id(l.product_id, 'product_id', { required: true }), quantity: num(l.quantity, 'quantity', { min: 0 }) ?? 0 }))
      .filter((l) => l.quantity > 0);
    if (!lines.length) throw badRequest('Add at least one product with a quantity');
    return lines;
  }

  function writeLines(orderId, supplierId, lines) {
    db.prepare('DELETE FROM purchase_order_lines WHERE order_id = ?').run(orderId);
    const product = db.prepare('SELECT id, unit_cost, supplier_id FROM products WHERE id = ?');
    const insert = db.prepare('INSERT INTO purchase_order_lines (order_id, product_id, quantity, unit_cost) VALUES (?, ?, ?, ?)');
    for (const l of lines) {
      const p = product.get(l.product_id);
      if (!p) throw notFound('Product');
      if (p.supplier_id !== supplierId) throw badRequest('All products on an order must come from the chosen supplier');
      insert.run(orderId, p.id, l.quantity, p.unit_cost);
    }
  }

  router.post('/orders', requireManager, (req, res) => {
    const locationId = resolveLocation(req, req.body.location_id);
    const supplierId = id(req.body.supplier_id, 'supplier_id', { required: true });
    if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) throw notFound('Supplier');
    const lines = parseLines(req.body.lines);
    const orderId = tx(db, () => {
      const r = db.prepare(`INSERT INTO purchase_orders (location_id, supplier_id, delivery_date, notes, created_by) VALUES (?, ?, ?, ?, ?)`)
        .run(locationId, supplierId, date(req.body.delivery_date, 'delivery_date'), str(req.body.notes, 'notes'), req.user.id);
      writeLines(r.lastInsertRowid, supplierId, lines);
      return r.lastInsertRowid;
    });
    req.params.id = String(orderId);
    res.status(201).json(loadOrder(req));
  });

  router.put('/orders/:id', requireManager, (req, res) => {
    const order = loadOrder(req);
    if (order.status !== 'draft') throw badRequest('Only draft orders can be edited');
    const lines = parseLines(req.body.lines);
    tx(db, () => {
      db.prepare('UPDATE purchase_orders SET delivery_date = ?, notes = ? WHERE id = ?')
        .run(date(req.body.delivery_date, 'delivery_date'), str(req.body.notes, 'notes'), order.id);
      writeLines(order.id, order.supplier_id, lines);
    });
    res.json(loadOrder(req));
  });

  router.post('/orders/:id/send', requireManager, (req, res) => {
    const order = loadOrder(req);
    if (order.status !== 'draft') throw badRequest('Only draft orders can be sent');
    db.prepare(`UPDATE purchase_orders SET status = 'sent', sent_at = datetime('now') WHERE id = ?`).run(order.id);
    res.json(loadOrder(req));
  });

  router.post('/orders/:id/receive', requireManager, (req, res) => {
    const order = loadOrder(req);
    if (order.status !== 'sent') throw badRequest('Only sent orders can be received');
    const received = new Map((req.body.lines ?? []).map((l) => [Number(l.id), num(l.received_quantity, 'received_quantity', { min: 0 })]));
    tx(db, () => {
      const update = db.prepare('UPDATE purchase_order_lines SET received_quantity = ? WHERE id = ?');
      for (const line of order.lines) {
        const qty = received.get(line.id);
        update.run(qty === undefined || qty === null ? line.quantity : qty, line.id);
      }
      db.prepare(`UPDATE purchase_orders SET status = 'received', received_at = datetime('now'), received_by = ? WHERE id = ?`)
        .run(req.user.id, order.id);
    });
    res.json(loadOrder(req));
  });

  router.post('/orders/:id/cancel', requireManager, (req, res) => {
    const order = loadOrder(req);
    if (!['draft', 'sent'].includes(order.status)) throw badRequest('This order can no longer be cancelled');
    db.prepare(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?`).run(order.id);
    res.json(loadOrder(req));
  });

  router.delete('/orders/:id', requireManager, (req, res) => {
    const order = loadOrder(req);
    if (order.status !== 'draft') throw badRequest('Only draft orders can be deleted');
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(order.id);
    res.json({ ok: true });
  });
}
