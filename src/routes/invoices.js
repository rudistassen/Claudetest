// Supplier invoices: upload a PDF or photo, it's read (see invoice-reader.js), matched to a supplier and products,
// checked by a person, then confirmed – which can add the supplier or products and update product costs.
import { assertLocation, requirePerm, resolveLocation } from '../auth.js';
import { tx } from '../db.js';
import { addDays, badRequest, date, forbidden, id, notFound, num, round2, str } from '../util.js';
import { autoSendToXero, xeroInvoiceInfo } from './xero.js';
import { cleanVatCode, vatCodeForRate } from '../vat-codes.js';

export const MAX_INVOICE_BYTES = 10 * 1024 * 1024;
export const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// --- Recognising suppliers and products ---

const STOP = new Set(['ltd', 'limited', 'plc', 'llp', 'the', 'and', 'co', 'company', 'uk', 'group', 'of', 'x', 'pk', 'pack', 'case', 'each', 'ea']);
export const norm = (s) => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w));
const bareName = (s) => words(s).join(' ');

function likeness(a, b) {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return (2 * common) / (x.size + y.size);
}

/** The supplier an invoice is from: by name, then by the domain of its email address. */
export function matchSupplier(db, details) {
  const suppliers = db.prepare('SELECT id, name, email FROM suppliers').all();
  const name = bareName(details?.name);
  if (name) {
    const exact = suppliers.find((s) => bareName(s.name) === name);
    if (exact) return { supplier_id: exact.id, how: 'name' };
    const contains = suppliers.find((s) => { const b = bareName(s.name); return b.length >= 4 && (name.includes(b) || b.includes(name)); });
    if (contains) return { supplier_id: contains.id, how: 'name' };
  }
  const domain = (e) => (String(e ?? '').split('@')[1] ?? '').toLowerCase().trim();
  const d = domain(details?.email);
  if (d && !/^(gmail|googlemail|hotmail|outlook|yahoo|icloud|btinternet|live|aol)\./.test(d)) {
    const byEmail = suppliers.find((s) => domain(s.email) === d);
    if (byEmail) return { supplier_id: byEmail.id, how: 'email' };
  }
  if (name) {
    const best = suppliers.map((s) => ({ s, score: likeness(s.name, details.name) })).sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 0.6) return { supplier_id: best.s.id, how: 'similar' };
  }
  return { supplier_id: null, how: null };
}

/**
 * The product an invoice line is for: what it was matched to before for this supplier, then the supplier's code
 * (SKU), then the name, then the closest similar name – preferring the supplier's own products.
 */
export function matchLine(db, supplierId, line) {
  const text = norm(line.description);
  if (supplierId) {
    const alias = db.prepare(`SELECT a.product_id FROM invoice_aliases a JOIN products p ON p.id = a.product_id
      WHERE a.supplier_id = ? AND a.text = ? AND p.active = 1`).get(supplierId, text);
    if (alias) return { product_id: alias.product_id, match: 'learnt' };
  }
  const products = db.prepare('SELECT id, name, sku, supplier_id FROM products WHERE active = 1').all();
  const theirs = products.filter((p) => p.supplier_id === supplierId);
  const pools = supplierId ? [theirs, products] : [products];
  const sku = norm(line.sku);
  if (sku) {
    for (const pool of pools) {
      const hit = pool.find((p) => p.sku && norm(p.sku) === sku);
      if (hit) return { product_id: hit.id, match: 'sku' };
    }
  }
  for (const pool of pools) {
    const hit = pool.find((p) => bareName(p.name) === bareName(line.description));
    if (hit) return { product_id: hit.id, match: 'name' };
  }
  const scored = products.map((p) => ({ p, score: likeness(p.name, line.description) + (p.supplier_id === supplierId ? 0.1 : 0) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0] && scored[0].score >= 0.65) return { product_id: scored[0].p.id, match: 'similar' };
  return { product_id: null, match: null };
}

// Real Node Buffers on the server; plain bytes in the standalone (in-browser) demo.
const realBuffer = typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function';
export const fromBase64 = (b64) => (realBuffer ? Buffer.from(b64, 'base64') : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const asBody = (bytes) => (realBuffer ? Buffer.from(bytes) : bytes);

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? round2(v) : null);
const qtyOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const dateOrNull = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/**
 * Saves an invoice that's been read (see invoice-reader.js): matches the supplier and each line to products, and
 * stores the file with it for checking. email: { from, subject } when it came in by email. Returns its id.
 */
/**
 * The site an invoice is for, from the supplier's references for each site (Suppliers → Accounting and payments):
 * a reference printed as the account number, in the delivery address, the order reference or the email's subject.
 * The longest matching reference wins (so "HB10421" beats "HB1042"). Null when none match.
 */
export function siteFromReference(db, supplierId, read, extra = '') {
  if (!supplierId) return null;
  const flat = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const text = ` ${flat([read.customer_reference, read.delivered_to, read.order_reference, read.notes, extra].filter(Boolean).join(' '))} `;
  const hit = db.prepare(`SELECT r.location_id, r.reference FROM supplier_site_refs r JOIN locations l ON l.id = r.location_id
    WHERE r.supplier_id = ? AND l.active = 1`).all(supplierId)
    .filter((r) => flat(r.reference) && text.includes(` ${flat(r.reference)} `))
    .sort((a, b) => flat(b.reference).length - flat(a.reference).length)[0];
  return hit?.location_id ?? null;
}

// sites: when given, the sites the invoice may be moved to (the uploader's), so it never lands where they can't see it.
export function saveReadInvoice(db, { locationId, read, fileName, mediaType, bytes, userId = null, email = null, sites = null }) {
  const supplier = matchSupplier(db, read.supplier);
  // The supplier's reference for a site, printed on the invoice, beats the site it was uploaded or emailed to.
  let bySite = siteFromReference(db, supplier.supplier_id, read, email?.subject);
  if (bySite && sites && !sites.includes(bySite)) bySite = null;
  if (bySite) locationId = bySite;
  const lines = (Array.isArray(read.lines) ? read.lines : []).filter((l) => l && String(l.description ?? '').trim());
  // No due date printed: the supplier's payment terms from the invoice date.
  const terms = supplier.supplier_id ? db.prepare('SELECT payment_terms_days FROM suppliers WHERE id = ?').get(supplier.supplier_id)?.payment_terms_days : null;
  const dueDate = dateOrNull(read.due_date) ?? (terms != null && dateOrNull(read.invoice_date) ? addDays(dateOrNull(read.invoice_date), terms) : null);
  const invoiceId = tx(db, () => {
    const r = db.prepare(`INSERT INTO invoices (location_id, supplier_id, supplier_name, supplier_details, invoice_number, invoice_date, due_date,
        subtotal, vat, total, file_name, file_type, file, extracted, notes, created_by, source, email_from, email_subject)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      locationId, supplier.supplier_id, read.supplier?.name ?? null, JSON.stringify(read.supplier ?? {}),
      str(read.invoice_number, 'invoice_number', { max: 100 }), dateOrNull(read.invoice_date), dueDate,
      numOrNull(read.subtotal), numOrNull(read.vat), numOrNull(read.total), fileName, mediaType, bytes, JSON.stringify(read),
      [read.notes, read.order_reference ? `Order reference: ${read.order_reference}` : null].filter(Boolean).join(' · ') || null, userId,
      email ? 'email' : 'upload', email?.from ?? null, email?.subject ?? null);
    const ins = db.prepare(`INSERT INTO invoice_lines (invoice_id, line_no, description, sku, quantity, unit, unit_price, line_total, vat_rate, product_id, match, update_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    lines.forEach((l, i) => {
      const m = matchLine(db, supplier.supplier_id, l);
      const product = m.product_id ? db.prepare('SELECT unit_cost FROM products WHERE id = ?').get(m.product_id) : null;
      const price = numOrNull(l.unit_price);
      // Offer to update the cost when the price moved, unless it moved so much the units probably differ.
      const change = product && price !== null && product.unit_cost > 0 ? Math.abs(price - product.unit_cost) / product.unit_cost : null;
      ins.run(r.lastInsertRowid, i + 1, String(l.description).trim().slice(0, 300), l.sku ? String(l.sku).slice(0, 60) : null, qtyOrNull(l.quantity),
        l.unit ? String(l.unit).slice(0, 30) : null, price, numOrNull(l.line_total), numOrNull(l.vat_rate), m.product_id, m.match,
        change !== null && change > 0.001 && change <= 0.5 ? 1 : 0);
    });
    return r.lastInsertRowid;
  });
  return { invoiceId, supplierMatch: supplier.how, siteFromReference: !!bySite, locationId };
}

export function registerInvoiceRoutes(router, db, reader, { xero = null } = {}) {
  const load = (req) => {
    const inv = db.prepare(`SELECT i.id, i.location_id, i.supplier_id, i.supplier_name, i.supplier_details, i.invoice_number, i.invoice_date,
        i.due_date, i.subtotal, i.vat, i.total, i.status, i.file_name, i.file_type, i.notes, i.created_at, i.confirmed_at,
        i.source, i.email_from, i.email_subject, i.xero_invoice_id, i.xero_sent_at, i.xero_error, l.name AS location_name, s.name AS matched_supplier_name, cu.name AS created_by_name, co.name AS confirmed_by_name
      FROM invoices i JOIN locations l ON l.id = i.location_id LEFT JOIN suppliers s ON s.id = i.supplier_id
      LEFT JOIN users cu ON cu.id = i.created_by LEFT JOIN users co ON co.id = i.confirmed_by WHERE i.id = ?`).get(Number(req.params.id));
    if (!inv) throw notFound('Invoice');
    assertLocation(req, inv.location_id);
    return inv;
  };

  // What someone checking the invoice should look at.
  const withLines = (inv) => {
    const lines = db.prepare(`SELECT il.*, p.name AS product_name, p.unit_cost AS product_cost, p.unit AS product_unit
      FROM invoice_lines il LEFT JOIN products p ON p.id = il.product_id WHERE il.invoice_id = ? ORDER BY il.line_no`).all(inv.id);
    const warnings = [];
    if (inv.supplier_id && inv.invoice_number) {
      const twin = db.prepare(`SELECT id, status FROM invoices WHERE supplier_id = ? AND lower(invoice_number) = lower(?) AND id != ?`).get(inv.supplier_id, inv.invoice_number, inv.id);
      if (twin) warnings.push({ type: 'duplicate', text: `This invoice number has already been ${twin.status === 'confirmed' ? 'entered' : 'uploaded'} (invoice #${twin.id})`, id: twin.id });
    }
    const sum = round2(lines.reduce((t, l) => t + (l.line_total ?? 0), 0));
    if (inv.subtotal !== null && Math.abs(sum - inv.subtotal) > 0.05) warnings.push({ type: 'totals', text: `The lines add up to £${sum.toFixed(2)} but the invoice subtotal is £${inv.subtotal.toFixed(2)}` });
    if (inv.subtotal !== null && inv.vat !== null && inv.total !== null && Math.abs(inv.subtotal + inv.vat - inv.total) > 0.05) warnings.push({ type: 'totals', text: 'Subtotal plus VAT doesn’t equal the total' });
    const unmatched = lines.filter((l) => !l.product_id).length;
    let details = null;
    try { details = inv.supplier_details ? JSON.parse(inv.supplier_details) : null; } catch { /* ignore */ }
    return { ...inv, supplier_details: details, lines, lines_total: sum, unmatched, warnings, ...xeroInvoiceInfo(xero, inv) };
  };

  router.get('/invoices', requirePerm('orders.manage'), (req, res) => {
    const ids = req.user.site_ids;
    if (!ids.length) return res.json({ ready: !!reader, demo: !!reader?.demo, invoices: [] });
    const status = req.query.status === 'confirmed' ? 'confirmed' : 'review';
    const rows = db.prepare(`SELECT i.id, i.location_id, l.name AS location_name, i.supplier_id, COALESCE(s.name, i.supplier_name) AS supplier_name,
        i.supplier_id IS NULL AS new_supplier, i.invoice_number, i.invoice_date, i.total, i.status, i.created_at, i.confirmed_at, i.source,
        (SELECT COUNT(*) FROM invoice_lines il WHERE il.invoice_id = i.id) AS line_count,
        (SELECT COUNT(*) FROM invoice_lines il WHERE il.invoice_id = i.id AND il.product_id IS NULL) AS unmatched
      FROM invoices i JOIN locations l ON l.id = i.location_id LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.status = ? AND i.location_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY ${status === 'review' ? 'i.created_at DESC' : 'COALESCE(i.invoice_date, i.created_at) DESC'} LIMIT 300`).all(status, ...ids);
    const toCheck = db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'review' AND location_id IN (${ids.map(() => '?').join(', ')})`).get(...ids).n;
    res.json({ ready: !!reader, demo: !!reader?.demo, to_check: toCheck, invoices: rows });
  });

  // Upload and read an invoice: { location_id, file_name, media_type, data (base64) }. Saved for checking.
  router.post('/invoices/scan', requirePerm('orders.manage'), async (req, res) => {
    if (!reader) throw badRequest('Invoice reading isn’t switched on yet. Add ANTHROPIC_API_KEY to the app’s settings (see Invoices).');
    const locationId = resolveLocation(req, req.body.location_id);
    const mediaType = String(req.body.media_type ?? '');
    if (!FILE_TYPES.includes(mediaType)) throw badRequest('Upload a PDF, or a photo (JPEG or PNG) of the invoice');
    const data = String(req.body.data ?? '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!data) throw badRequest('The file is empty');
    let bytes;
    try { bytes = fromBase64(data); } catch { throw badRequest('The file couldn’t be read'); }
    if (bytes.length > MAX_INVOICE_BYTES) throw badRequest('That file is over 10 MB – try a smaller scan or photo');
    const fileName = str(req.body.file_name, 'file_name', { max: 200 }) ?? 'invoice';

    const read = await reader.read({ media_type: mediaType, data });
    if (read.is_invoice === false) throw badRequest('That doesn’t look like a supplier invoice. Check you picked the right file.');
    const { invoiceId, supplierMatch, siteFromReference: bySite } = saveReadInvoice(db, { locationId, read, fileName, mediaType, bytes, userId: req.user.id, sites: req.user.site_ids });
    res.status(201).json({ ...withLines(load({ ...req, params: { id: invoiceId } })), supplier_match: supplierMatch, site_from_reference: bySite });
  });

  router.get('/invoices/:id', requirePerm('orders.manage'), (req, res) => res.json(withLines(load(req))));

  router.get('/invoices/:id/file', requirePerm('orders.manage'), (req, res) => {
    const inv = load(req);
    const row = db.prepare('SELECT file FROM invoices WHERE id = ?').get(inv.id);
    if (!row?.file) throw notFound('Invoice file');
    res.setHeader('Content-Type', inv.file_type);
    res.setHeader('Content-Disposition', `inline; filename="${String(inv.file_name).replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(asBody(row.file));
  });

  // Saves what the person checking has changed. lines: [{ id?, description, sku, quantity, unit, unit_price, line_total,
  // product: <product id> | 'new' | null, update_cost }]. new_supplier: true adds the supplier when confirming.
  const save = (req, inv) => {
    const b = req.body;
    const locationId = b.location_id !== undefined ? resolveLocation(req, b.location_id) : inv.location_id;
    const supplierId = id(b.supplier_id, 'supplier_id');
    if (supplierId && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) throw notFound('Supplier');
    const lines = Array.isArray(b.lines) ? b.lines : [];
    const known = new Set(db.prepare('SELECT id FROM products').all().map((p) => p.id));
    const clean = lines.map((l, i) => {
      const product = l.product === 'new' ? 'new' : id(l.product, `line ${i + 1} product`);
      if (typeof product === 'number' && !known.has(product)) throw notFound('Product');
      return {
        description: str(l.description, `line ${i + 1} description`, { required: true, max: 300 }),
        sku: str(l.sku, 'sku', { max: 60 }),
        quantity: num(l.quantity, `line ${i + 1} quantity`),
        unit: str(l.unit, 'unit', { max: 30 }),
        unit_price: num(l.unit_price, `line ${i + 1} unit price`),
        line_total: num(l.line_total, `line ${i + 1} total`),
        vat_rate: num(l.vat_rate, 'vat_rate', { min: 0, max: 100 }),
        product,
        // A new product's category and VAT code, chosen on the line.
        new_category: product === 'new' ? str(l.new_category, 'category', { max: 100 }) : null,
        new_vat_code: product === 'new' ? str(l.new_vat_code, 'VAT code', { max: 40 }) : null,
        update_cost: l.update_cost ? 1 : 0,
        was: l.id ? db.prepare('SELECT product_id, match FROM invoice_lines WHERE id = ? AND invoice_id = ?').get(Number(l.id), inv.id) : null,
      };
    });
    tx(db, () => {
      db.prepare(`UPDATE invoices SET location_id = ?, supplier_id = ?, supplier_name = COALESCE(?, supplier_name), invoice_number = ?, invoice_date = ?, due_date = ?,
          subtotal = ?, vat = ?, total = ?, notes = ? WHERE id = ?`).run(locationId, supplierId, str(b.supplier_name, 'supplier_name', { max: 150 }),
        str(b.invoice_number, 'invoice_number', { max: 100 }), date(b.invoice_date, 'invoice_date'), date(b.due_date, 'due_date'),
        num(b.subtotal, 'subtotal'), num(b.vat, 'vat'), num(b.total, 'total'), str(b.notes, 'notes', { max: 1000 }), inv.id);
      db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(inv.id);
      const ins = db.prepare(`INSERT INTO invoice_lines (invoice_id, line_no, description, sku, quantity, unit, unit_price, line_total, vat_rate, product_id, match, update_cost, new_category, new_vat_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      clean.forEach((l, i) => {
        const productId = typeof l.product === 'number' ? l.product : null;
        const match = l.product === 'new' ? 'new' : !productId ? null : l.was?.product_id === productId ? l.was.match : 'manual';
        ins.run(inv.id, i + 1, l.description, l.sku, l.quantity, l.unit, l.unit_price, l.line_total, l.vat_rate, productId, match, l.update_cost, l.new_category, l.new_vat_code);
      });
    });
    return clean;
  };

  router.put('/invoices/:id', requirePerm('orders.manage'), (req, res) => {
    const inv = load(req);
    if (inv.status === 'confirmed') throw badRequest('This invoice has been confirmed and can’t be changed');
    save(req, inv);
    res.json(withLines(load(req)));
  });

  // Confirm: saves the changes, then adds the new supplier and products, updates costs and remembers the matches.
  router.post('/invoices/:id/confirm', requirePerm('orders.manage'), (req, res) => {
    const inv = load(req);
    if (inv.status === 'confirmed') throw badRequest('This invoice has already been confirmed');
    if (!req.body.supplier_id && !req.body.new_supplier) throw badRequest('Choose the supplier (or add them as a new supplier)');
    const canAddProducts = req.user.role === 'admin' || req.user.permissions.includes('setup.products');
    const lines = save(req, inv);
    if (!canAddProducts && lines.some((l) => l.product === 'new')) throw forbidden('Adding new products needs the “Add and edit suppliers and products” permission');
    // Each new product goes in one of the categories (once there are any).
    const hasCategories = !!db.prepare('SELECT 1 FROM product_categories LIMIT 1').get();
    const categoryFor = new Map();
    lines.forEach((l, i) => {
      if (l.product !== 'new') return;
      const c = l.new_category ? db.prepare('SELECT name FROM product_categories WHERE name = ?').get(l.new_category) : null;
      if (hasCategories && !c) throw badRequest(`Choose a category for the new product on line ${i + 1} (“${l.description.slice(0, 40)}”)`);
      categoryFor.set(i, c?.name ?? null);
    });
    const summary = tx(db, () => {
      let supplierId = id(req.body.supplier_id, 'supplier_id');
      let supplierAdded = false;
      if (!supplierId) {
        if (!canAddProducts) throw forbidden('Adding a new supplier needs the “Add and edit suppliers and products” permission');
        const d = (() => { try { return JSON.parse(db.prepare('SELECT supplier_details FROM invoices WHERE id = ?').get(inv.id).supplier_details ?? '{}'); } catch { return {}; } })();
        const name = str(req.body.supplier_name, 'supplier_name', { max: 100 }) ?? d.name;
        if (!name) throw badRequest('Give the new supplier a name');
        const existing = db.prepare('SELECT id FROM suppliers WHERE lower(name) = lower(?)').get(name);
        supplierId = existing?.id ?? db.prepare('INSERT INTO suppliers (name, email, phone) VALUES (?, ?, ?)').run(name, d.email ?? null, d.phone ?? null).lastInsertRowid;
        supplierAdded = !existing;
        db.prepare('UPDATE invoices SET supplier_id = ?, supplier_name = ? WHERE id = ?').run(supplierId, name, inv.id);
      }
      let productsAdded = 0;
      let costsUpdated = 0;
      let learnt = 0;
      const rows = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no').all(inv.id);
      rows.forEach((row, i) => {
        const l = lines[i];
        if (l?.product === 'new') {
          const vatCode = cleanVatCode(l.new_vat_code) || vatCodeForRate(row.vat_rate);
          const productId = db.prepare('INSERT INTO products (name, sku, unit, supplier_id, unit_cost, category, vat_code) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(row.description.slice(0, 150), row.sku, row.unit ?? 'each', supplierId, row.unit_price ?? 0, categoryFor.get(i) ?? null, vatCode).lastInsertRowid;
          db.prepare(`UPDATE invoice_lines SET product_id = ?, match = 'new' WHERE id = ?`).run(productId, row.id);
          productsAdded++;
          return;
        }
        if (!row.product_id) return;
        if (row.update_cost && row.unit_price !== null && row.unit_price >= 0) {
          costsUpdated += db.prepare('UPDATE products SET unit_cost = ? WHERE id = ? AND unit_cost != ?').run(row.unit_price, row.product_id, row.unit_price).changes;
        }
        // Next time this supplier's wording comes up, it's recognised straight away.
        if (row.match === 'manual' || row.match === 'similar') {
          db.prepare(`INSERT INTO invoice_aliases (supplier_id, text, product_id) VALUES (?, ?, ?)
            ON CONFLICT (supplier_id, text) DO UPDATE SET product_id = excluded.product_id`).run(supplierId, norm(row.description), row.product_id);
          learnt++;
        }
      });
      db.prepare(`UPDATE invoices SET status = 'confirmed', confirmed_by = ?, confirmed_at = datetime('now') WHERE id = ?`).run(req.user.id, inv.id);
      return { supplier_added: supplierAdded, products_added: productsAdded, costs_updated: costsUpdated, learnt };
    });
    autoSendToXero(xero, inv.id);
    res.json({ ...summary, invoice: withLines(load(req)) });
  });

  router.delete('/invoices/:id', requirePerm('orders.manage'), (req, res) => {
    const inv = load(req);
    if (inv.status === 'confirmed' && req.user.role !== 'admin') throw forbidden('Only admins can delete a confirmed invoice');
    db.prepare('DELETE FROM invoices WHERE id = ?').run(inv.id);
    res.json({ ok: true });
  });
}
