import { cleanAllergens } from '../recipes.js';
import { assertLocation, requirePerm, resolveLocation } from '../auth.js';
import { tx } from '../db.js';
import { applyImport, planImport } from '../product-import.js';
import { badRequest, bool, date, id, notFound, num, round2, str } from '../util.js';
import { cleanVatCode } from '../vat-codes.js';

const DAYS = [1, 2, 3, 4, 5, 6, 7];
export const parseSchedule = (json) => {
  try { const v = JSON.parse(json ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};
/** Delivery days with their cut-offs: [{ day, cutoff_day, cutoff_time }] (1 = Monday … 7 = Sunday), as JSON. */
function cleanSchedule(v) {
  if (v === undefined || v === null || v === '') return null;
  const list = typeof v === 'string' ? parseSchedule(v) : v;
  if (!Array.isArray(list)) throw badRequest('Delivery days aren’t in the right form');
  const seen = new Set();
  const out = list.map((d) => {
    const day = Number(d.day);
    const cutoffDay = Number(d.cutoff_day);
    if (!DAYS.includes(day) || !DAYS.includes(cutoffDay)) throw badRequest('Delivery days aren’t in the right form');
    const cutoffTime = String(d.cutoff_time ?? '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoffTime)) throw badRequest('Each cut-off needs a time, e.g. 22:00');
    if (seen.has(day)) throw badRequest('Each delivery day can only be listed once');
    seen.add(day);
    return { day, cutoff_day: cutoffDay, cutoff_time: cutoffTime };
  }).sort((a, b) => a.day - b.day);
  return out.length ? JSON.stringify(out) : null;
}

export function registerOrderingRoutes(router, db) {
  // --- Suppliers ---

  // A supplier as the app sees it: the delivery days parsed, and their references for each site.
  const refs = db.prepare(`SELECT r.location_id, r.reference, l.name AS location_name FROM supplier_site_refs r JOIN locations l ON l.id = r.location_id
    WHERE r.supplier_id = ? ORDER BY l.name, r.reference`);
  const shape = (s) => s && ({ ...s, delivery_schedule: parseSchedule(s.delivery_schedule), site_refs: refs.all(s.id) });
  const supplierById = (sid) => shape(db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id AND p.active = 1) AS product_count
    FROM suppliers s WHERE s.id = ?`).get(sid));

  router.get('/suppliers', (_req, res) => {
    res.json(db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id AND p.active = 1) AS product_count
      FROM suppliers s ORDER BY s.active DESC, s.name`).all().map(shape));
  });

  router.get('/suppliers/:id', (req, res) => {
    const s = supplierById(Number(req.params.id));
    if (!s) throw notFound('Supplier');
    res.json(s);
  });

  const emails = (v, name) => {
    const list = String(v ?? '').split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
    for (const e of list) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw badRequest(`${name}: “${e}” isn’t an email address`);
    return list.length ? list.join(', ').slice(0, 1000) : null;
  };
  const supplierBody = (b) => ({
    name: str(b.name, 'Name', { required: true, max: 100 }),
    contact_name: str(b.contact_name, 'Contact name', { max: 100 }),
    email: emails(b.email, 'Email'),
    phone: str(b.phone, 'Phone', { max: 50 }),
    address: str(b.address, 'Address', { max: 500 }),
    order_email: emails(b.order_email, 'Order email'),
    cc_emails: emails(b.cc_emails, 'CC'),
    delivery_schedule: cleanSchedule(b.delivery_schedule),
    orders_enabled: b.orders_enabled === undefined ? 1 : bool(b.orders_enabled),
    order_days: str(b.order_days, 'order_days', { max: 100 }),
    lead_time_days: num(b.lead_time_days, 'Lead time', { min: 0, max: 60, int: true }) ?? 1,
    min_order: num(b.min_order, 'Minimum order', { min: 0 }) ?? 0,
    xero_contact_id: str(b.xero_contact_id, 'Xero contact', { max: 64 }),
    xero_contact_name: str(b.xero_contact_name, 'Xero contact', { max: 255 }),
    payment_terms_days: num(b.payment_terms_days, 'Payment terms', { min: 0, max: 365, int: true }),
    notes: str(b.notes, 'Notes', { max: 2000 }),
    active: b.active === undefined ? 1 : bool(b.active),
  });
  const supplierCols = ['name', 'contact_name', 'email', 'phone', 'address', 'order_email', 'cc_emails', 'delivery_schedule', 'orders_enabled',
    'order_days', 'lead_time_days', 'min_order', 'xero_contact_id', 'xero_contact_name', 'payment_terms_days', 'notes', 'active'];
  const sameName = (name, notId = 0) => db.prepare('SELECT 1 FROM suppliers WHERE lower(name) = lower(?) AND id != ?').get(name, notId);

  router.post('/suppliers', requirePerm('setup.products'), (req, res) => {
    const s = supplierBody(req.body ?? {});
    if (sameName(s.name)) throw badRequest(`There’s already a supplier called ${s.name}`);
    const r = db.prepare(`INSERT INTO suppliers (${supplierCols.join(', ')}) VALUES (${supplierCols.map(() => '?').join(', ')})`)
      .run(...supplierCols.map((c) => s[c]));
    res.status(201).json(supplierById(Number(r.lastInsertRowid)));
  });

  // Changes what's sent and keeps the rest, so each tab can save its own part.
  router.put('/suppliers/:id', requirePerm('setup.products'), (req, res) => {
    const old = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(req.params.id));
    if (!old) throw notFound('Supplier');
    const s = supplierBody({ ...old, delivery_schedule: parseSchedule(old.delivery_schedule), ...(req.body ?? {}) });
    if (sameName(s.name, old.id)) throw badRequest(`There’s already a supplier called ${s.name}`);
    db.prepare(`UPDATE suppliers SET ${supplierCols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...supplierCols.map((c) => s[c]), old.id);
    res.json(supplierById(old.id));
  });

  // { refs: [{ location_id, reference }] } – all of this supplier's site references, replacing what was there.
  router.put('/suppliers/:id/site-refs', requirePerm('setup.products'), (req, res) => {
    const s = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(Number(req.params.id));
    if (!s) throw notFound('Supplier');
    const list = (Array.isArray(req.body?.refs) ? req.body.refs : []).map((r, i) => ({
      location_id: id(r.location_id, `line ${i + 1} site`, { required: true }),
      reference: str(r.reference, `line ${i + 1} reference`, { max: 100 }),
    })).filter((r) => r.reference);
    for (const r of list) if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(r.location_id)) throw notFound('Site');
    tx(db, () => {
      db.prepare('DELETE FROM supplier_site_refs WHERE supplier_id = ?').run(s.id);
      const ins = db.prepare('INSERT INTO supplier_site_refs (supplier_id, location_id, reference) VALUES (?, ?, ?)');
      for (const r of list) ins.run(s.id, r.location_id, r.reference);
    });
    res.json(supplierById(s.id));
  });

  // --- Product categories ---

  const categoryByName = (name) => db.prepare('SELECT * FROM product_categories WHERE name = ?').get(name);
  router.get('/product-categories', (_req, res) => {
    res.json(db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category = c.name AND p.active = 1) AS product_count
      FROM product_categories c ORDER BY c.name`).all());
  });

  const categoryBody = (b) => ({
    name: str(b.name, 'Category name', { required: true, max: 100 }),
    xero_account_code: str(b.xero_account_code, 'Xero account code', { max: 20 }),
  });

  router.post('/product-categories', requirePerm('setup.products'), (req, res) => {
    const c = categoryBody(req.body ?? {});
    if (categoryByName(c.name)) throw badRequest(`There’s already a category called ${c.name}`);
    const r = db.prepare('INSERT INTO product_categories (name, xero_account_code) VALUES (?, ?)').run(c.name, c.xero_account_code);
    res.status(201).json(db.prepare('SELECT * FROM product_categories WHERE id = ?').get(r.lastInsertRowid));
  });

  // Renaming a category renames it on its products too.
  router.put('/product-categories/:id', requirePerm('setup.products'), (req, res) => {
    const old = db.prepare('SELECT * FROM product_categories WHERE id = ?').get(Number(req.params.id));
    if (!old) throw notFound('Category');
    const c = categoryBody({ ...old, ...(req.body ?? {}) });
    const clash = categoryByName(c.name);
    if (clash && clash.id !== old.id) throw badRequest(`There’s already a category called ${c.name}`);
    tx(db, () => {
      db.prepare('UPDATE product_categories SET name = ?, xero_account_code = ? WHERE id = ?').run(c.name, c.xero_account_code, old.id);
      db.prepare('UPDATE products SET category = ? WHERE category = ?').run(c.name, old.name);
    });
    res.json(db.prepare('SELECT * FROM product_categories WHERE id = ?').get(old.id));
  });

  // { move_to: category id } moves its products to another category first; without it, only an empty one goes.
  router.delete('/product-categories/:id', requirePerm('setup.products'), (req, res) => {
    const c = db.prepare('SELECT * FROM product_categories WHERE id = ?').get(Number(req.params.id));
    if (!c) throw notFound('Category');
    const used = db.prepare('SELECT COUNT(*) AS n FROM products WHERE category = ?').get(c.name).n;
    const moveTo = id(req.body?.move_to, 'move_to');
    const to = moveTo ? db.prepare('SELECT * FROM product_categories WHERE id = ? AND id != ?').get(moveTo, c.id) : null;
    if (moveTo && !to) throw notFound('Category to move to');
    if (used && !to) throw badRequest(`${used} product${used === 1 ? ' is' : 's are'} in ${c.name} – choose a category to move ${used === 1 ? 'it' : 'them'} to`);
    tx(db, () => {
      if (to) db.prepare('UPDATE products SET category = ? WHERE category = ?').run(to.name, c.name);
      db.prepare('DELETE FROM product_categories WHERE id = ?').run(c.id);
    });
    res.json({ ok: true, moved: to ? used : 0 });
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
      pack_quantity: num(b.pack_quantity, 'Pack quantity', { min: 0.0001 }),
      supplier_id: id(b.supplier_id, 'supplier_id'),
      unit_cost: num(b.unit_cost, 'unit_cost', { min: 0 }) ?? 0,
      par_level: num(b.par_level, 'par_level', { min: 0 }) ?? 0,
      recipe_unit: str(b.recipe_unit, 'recipe_unit', { max: 30 }),
      units_per_pack: num(b.units_per_pack, 'units_per_pack', { min: 0.0001 }) ?? 1,
      allergens: cleanAllergens(b.allergens ?? []),
      vat_code: cleanVatCode(b.vat_code),
      active: b.active === undefined ? 1 : bool(b.active),
    };
    if (p.vat_code === undefined) throw badRequest('That isn’t a VAT code Xero uses');
    if (p.supplier_id && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(p.supplier_id)) throw notFound('Supplier');
    // Every product goes in one of the categories (once there are any).
    if (p.category) {
      const c = categoryByName(p.category);
      if (!c) throw badRequest(`“${p.category}” isn’t one of your product categories – add it under Stock & Ordering → Product categories first`);
      p.category = c.name;
    } else if (db.prepare('SELECT 1 FROM product_categories LIMIT 1').get()) {
      throw badRequest('Choose a category for the product');
    }
    return p;
  };
  const productCols = ['name', 'sku', 'category', 'unit', 'pack_quantity', 'supplier_id', 'unit_cost', 'par_level', 'recipe_unit', 'units_per_pack', 'allergens', 'vat_code', 'active'];

  router.post('/products', requirePerm('setup.products'), (req, res) => {
    const p = productBody(req.body);
    const r = db.prepare(`INSERT INTO products (${productCols.join(', ')}) VALUES (${productCols.map(() => '?').join(', ')})`)
      .run(...productCols.map((c) => p[c]));
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(r.lastInsertRowid));
  });

  router.put('/products/:id', requirePerm('setup.products'), (req, res) => {
    const p = productBody(req.body);
    const r = db.prepare(`UPDATE products SET ${productCols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...productCols.map((c) => p[c]), Number(req.params.id));
    if (!r.changes) throw notFound('Product');
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id)));
  });

  // Several products at once: { ids, category?, vat_code? }.
  router.post('/products/bulk', requirePerm('setup.products'), (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map((v) => id(v, 'id', { required: true }));
    if (!ids.length) throw badRequest('Tick some products first');
    const set = {};
    if (req.body.category !== undefined) {
      const c = categoryByName(str(req.body.category, 'Category', { required: true, max: 100 }));
      if (!c) throw badRequest('Choose one of your product categories');
      set.category = c.name;
    }
    if (req.body.vat_code !== undefined) {
      const v = cleanVatCode(req.body.vat_code);
      if (!v) throw badRequest('Choose a VAT code');
      set.vat_code = v;
    }
    if (!Object.keys(set).length) throw badRequest('Nothing to change');
    const update = db.prepare(`UPDATE products SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`);
    let changed = 0;
    tx(db, () => { for (const pid of ids) changed += update.run(...Object.values(set), pid).changes; });
    res.json({ changed });
  });

  // Import from a spreadsheet: { headers, rows } previews what would happen; with apply: true it's done.
  router.post('/products/import', requirePerm('setup.products'), (req, res) => {
    const plan = planImport(db, req.body);
    if (!req.body.apply) {
      return res.json({ ...plan, rows: plan.rows.map(({ set, key, id: _id, ...r }) => r) });
    }
    res.json(applyImport(db, plan));
  });

  // Per-location par levels override the product default.
  router.get('/products/:id/pars', requirePerm('orders.manage'), (req, res) => {
    const product = db.prepare('SELECT id, name, par_level FROM products WHERE id = ?').get(Number(req.params.id));
    if (!product) throw notFound('Product');
    const pars = db.prepare(`SELECT l.id AS location_id, l.name AS location_name, pp.par_level
      FROM locations l LEFT JOIN product_pars pp ON pp.location_id = l.id AND pp.product_id = ?
      WHERE l.active = 1 ORDER BY l.name`).all(product.id);
    res.json({ product, pars });
  });

  router.put('/products/:id/pars', requirePerm('orders.manage'), (req, res) => {
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
    SELECT o.*, s.name AS supplier_name, COALESCE(s.order_email, s.email) AS supplier_email, s.cc_emails AS supplier_cc, l.name AS location_name, u.name AS created_by_name,
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
    order.lines = db.prepare(`SELECT ol.*, p.name AS product_name, p.unit, p.pack_quantity, p.sku FROM purchase_order_lines ol
      JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY p.category, p.name`).all(order.id);
    return order;
  }

  router.get('/orders', requirePerm('orders.manage'), (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    const status = str(req.query.status, 'status');
    const rows = status
      ? db.prepare(`${orderSelect} WHERE o.location_id = ? AND o.status = ? ORDER BY o.created_at DESC LIMIT 200`).all(locationId, status)
      : db.prepare(`${orderSelect} WHERE o.location_id = ? ORDER BY o.created_at DESC LIMIT 200`).all(locationId);
    for (const r of rows) r.total = round2(r.total);
    res.json(rows);
  });

  // Suggested quantities: par level minus what was on hand at the last completed stock take.
  router.get('/orders/suggest', requirePerm('orders.manage'), (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    const supplierId = id(req.query.supplier_id, 'supplier_id', { required: true });
    const lastTake = db.prepare(`SELECT id, completed_at FROM stock_takes WHERE location_id = ? AND status = 'completed'
      ORDER BY completed_at DESC, id DESC LIMIT 1`).get(locationId);
    const rows = db.prepare(`
      SELECT p.id AS product_id, p.name, p.sku, p.category, p.unit, p.pack_quantity, p.unit_cost,
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

  router.get('/orders/:id', requirePerm('orders.manage'), (req, res) => res.json(loadOrder(req)));

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

  router.post('/orders', requirePerm('orders.manage'), (req, res) => {
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

  router.put('/orders/:id', requirePerm('orders.manage'), (req, res) => {
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

  router.post('/orders/:id/send', requirePerm('orders.manage'), (req, res) => {
    const order = loadOrder(req);
    if (order.status !== 'draft') throw badRequest('Only draft orders can be sent');
    db.prepare(`UPDATE purchase_orders SET status = 'sent', sent_at = datetime('now') WHERE id = ?`).run(order.id);
    res.json(loadOrder(req));
  });

  router.post('/orders/:id/receive', requirePerm('orders.manage'), (req, res) => {
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

  router.post('/orders/:id/cancel', requirePerm('orders.manage'), (req, res) => {
    const order = loadOrder(req);
    if (!['draft', 'sent'].includes(order.status)) throw badRequest('This order can no longer be cancelled');
    db.prepare(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?`).run(order.id);
    res.json(loadOrder(req));
  });

  router.delete('/orders/:id', requirePerm('orders.manage'), (req, res) => {
    const order = loadOrder(req);
    if (order.status !== 'draft') throw badRequest('Only draft orders can be deleted');
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(order.id);
    res.json({ ok: true });
  });
}
