// Importing products from a spreadsheet (CSV, Excel, or rows pasted from Excel). The browser reads the file into
// a header row plus data rows; this works out what each row means, previews it, then applies it.
import { tx } from './db.js';
import { ALLERGENS } from './recipes.js';
import { badRequest } from './util.js';

export const MAX_IMPORT_ROWS = 5000;

// The columns we understand and the headings people tend to use for them.
const COLUMNS = {
  name: ['name', 'product', 'product name', 'item', 'item name'],
  sku: ['sku', 'code', 'product code', 'item code', 'supplier code', 'sku supplier code'],
  category: ['category', 'group', 'product category'],
  unit: ['unit', 'order unit', 'uom', 'unit of measure', 'pack', 'case'],
  supplier: ['supplier', 'supplier name', 'vendor'],
  unit_cost: ['unit cost', 'cost', 'price', 'cost price', 'unit price', 'unit cost £', 'cost £', 'price £'],
  par_level: ['par', 'par level', 'default par', 'default par level'],
  recipe_unit: ['recipe unit'],
  units_per_pack: ['recipe units per pack', 'units per pack', 'pack size', 'pack quantity', 'qty per pack'],
  allergens: ['allergens', 'allergen'],
  active: ['active', 'in use', 'status'],
};
export const TEMPLATE_HEADERS = ['Name', 'SKU', 'Category', 'Unit', 'Supplier', 'Unit cost', 'Par level', 'Recipe unit', 'Recipe units per pack', 'Allergens', 'Active'];
const LABELS = { name: 'name', sku: 'SKU', category: 'category', unit: 'unit', supplier: 'supplier', unit_cost: 'unit cost', par_level: 'par level', recipe_unit: 'recipe unit', units_per_pack: 'recipe units per pack', allergens: 'allergens', active: 'active' };

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9£]+/g, ' ').trim();
const lookup = new Map(Object.entries(COLUMNS).flatMap(([key, names]) => names.map((n) => [norm(n), key])));

/** Which of our fields each column holds (null for columns we ignore). */
export function mapHeaders(headers) {
  const seen = new Set();
  return headers.map((h) => {
    const key = lookup.get(norm(h)) ?? null;
    if (!key || seen.has(key)) return null;
    seen.add(key);
    return key;
  });
}

const blank = (v) => v === null || v === undefined || String(v).trim() === '';

function number(v, label, { min = 0 } = {}) {
  if (blank(v)) return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[£,\s]/g, ''));
  if (!Number.isFinite(n) || n < min) throw new Error(`${label} “${v}” isn’t a number${min > 0 ? ' above 0' : ''}`);
  return Math.round(n * 10000) / 10000;
}

const allergenByName = new Map(ALLERGENS.flatMap(([key, label]) => [[key, key], [norm(label), key], [norm(key), key]]));
allergenByName.set('gluten', 'gluten');
allergenByName.set('nuts', 'nuts');
allergenByName.set('tree nuts', 'nuts');
allergenByName.set('sulphur dioxide', 'sulphites');
allergenByName.set('sulphites', 'sulphites');
allergenByName.set('sulfites', 'sulphites');
allergenByName.set('soy', 'soya');
allergenByName.set('dairy', 'milk');
allergenByName.set('egg', 'eggs');

function allergens(v) {
  if (blank(v)) return undefined;
  const text = String(v).trim();
  if (/^(none|no|n\/a|-)$/i.test(text)) return null;
  const keys = text.split(/[,;/|]+/).map((a) => a.trim()).filter(Boolean).map((a) => {
    const key = allergenByName.get(norm(a));
    if (!key) throw new Error(`Unknown allergen “${a}”`);
    return key;
  });
  const order = ALLERGENS.map(([k]) => k);
  return [...new Set(keys)].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join(',') || null;
}

function yesNo(v) {
  if (blank(v)) return undefined;
  const t = String(v).trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'active', 'on'].includes(t)) return 1;
  if (['no', 'n', 'false', '0', 'inactive', 'off', 'archived'].includes(t)) return 0;
  throw new Error(`Active should be yes or no, not “${v}”`);
}

function text(v, label, max) {
  if (blank(v)) return undefined;
  const s = String(v).trim();
  if (s.length > max) throw new Error(`${label} is longer than ${max} characters`);
  return s;
}

/**
 * Works out what importing the rows would do, without changing anything. Returns
 * { columns, ignored, rows: [{ line, action: 'create'|'update'|'same'|'error', name, changes, error }], new_suppliers, counts }.
 * Existing products are matched by SKU, then by name (with the same supplier if one is given). Blank cells leave
 * an existing product's value as it is.
 */
export function planImport(db, { headers, rows, heading_line: headingLine = 1 }) {
  if (!Array.isArray(headers) || !Array.isArray(rows)) throw badRequest('Nothing to import');
  if (rows.length > MAX_IMPORT_ROWS) throw badRequest(`Import at most ${MAX_IMPORT_ROWS} rows at a time`);
  const keys = mapHeaders(headers);
  if (!keys.includes('name')) throw badRequest('The file needs a “Name” column (the product name). Download the template to see the columns BrewView understands.');

  const products = db.prepare('SELECT p.*, s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id').all();
  const suppliers = new Map(db.prepare('SELECT id, name FROM suppliers').all().map((s) => [norm(s.name), s]));
  const bySku = new Map();
  const byName = new Map();
  for (const p of products) {
    if (p.sku) bySku.set(norm(p.sku), [...(bySku.get(norm(p.sku)) ?? []), p]);
    byName.set(norm(p.name), [...(byName.get(norm(p.name)) ?? []), p]);
  }
  const newSuppliers = new Map();
  const claimed = new Set();
  const plan = [];

  rows.forEach((cells, i) => {
    // The line in the spreadsheet: counted from the heading row (line 1 unless there's a title above it).
    const line = i + 1 + (Number.isInteger(headingLine) && headingLine > 0 ? headingLine : 1);
    const raw = {};
    keys.forEach((k, c) => { if (k) raw[k] = Array.isArray(cells) ? cells[c] : undefined; });
    if (Object.values(raw).every(blank)) return; // empty row
    try {
      const v = {
        name: text(raw.name, 'Name', 150),
        sku: text(raw.sku, 'SKU', 50),
        category: text(raw.category, 'Category', 100),
        unit: text(raw.unit, 'Unit', 30),
        supplier: text(raw.supplier, 'Supplier', 100),
        unit_cost: number(raw.unit_cost, 'Unit cost'),
        par_level: number(raw.par_level, 'Par level'),
        recipe_unit: text(raw.recipe_unit, 'Recipe unit', 30),
        units_per_pack: number(raw.units_per_pack, 'Recipe units per pack', { min: 0.0001 }),
        allergens: allergens(raw.allergens),
        active: yesNo(raw.active),
      };
      if (!v.name) throw new Error('No product name');
      // Supplier: an existing one by name, or a new one to create.
      let supplierId;
      if (v.supplier) {
        const s = suppliers.get(norm(v.supplier));
        if (s) supplierId = s.id;
        else { newSuppliers.set(norm(v.supplier), v.supplier); supplierId = `new:${norm(v.supplier)}`; }
      }
      // Match: SKU first, then name (with the same supplier when there's a choice).
      const pickFrom = (list) => {
        const open = (list ?? []).filter((p) => !claimed.has(p.id));
        if (open.length <= 1) return open[0];
        return open.find((p) => supplierId && p.supplier_id === supplierId) ?? (supplierId ? undefined : open[0]);
      };
      const existing = (v.sku && pickFrom(bySku.get(norm(v.sku)))) || pickFrom(byName.get(norm(v.name)));
      const fields = { ...v, supplier_id: supplierId };
      delete fields.supplier;
      if (existing) {
        claimed.add(existing.id);
        const changes = [];
        const set = {};
        for (const [k, val] of Object.entries(fields)) {
          if (val === undefined) continue;
          const now = existing[k] ?? null;
          // Numbers within rounding, and a name that only differs in capitals or spacing, count as the same.
          const same = typeof val === 'number' && typeof now === 'number' ? Math.abs(val - now) < 0.00005
            : k === 'name' ? norm(val) === norm(now) : (val ?? null) === now;
          if (same) continue;
          set[k] = val;
          const label = k === 'supplier_id' ? 'supplier' : LABELS[k];
          changes.push(k === 'unit_cost' ? `${label} £${(now ?? 0).toFixed(2)} → £${val.toFixed(2)}` : k === 'supplier_id' ? `supplier → ${v.supplier}` : label);
        }
        plan.push({ line, action: changes.length ? 'update' : 'same', id: existing.id, name: existing.name, changes, set });
      } else {
        const key = `${norm(v.name)}|${supplierId ?? ''}`;
        const twin = plan.find((r) => r.action === 'create' && r.key === key);
        if (twin) throw new Error(`“${v.name}” is already on line ${twin.line} of the file`);
        plan.push({ line, action: 'create', name: v.name, changes: [], set: fields, key });
      }
    } catch (err) {
      plan.push({ line, action: 'error', name: blank(raw.name) ? `(line ${line})` : String(raw.name).trim(), error: err.message });
    }
  });

  const count = (a) => plan.filter((r) => r.action === a).length;
  return {
    columns: headers.map((h, c) => ({ heading: String(h ?? ''), field: keys[c] })),
    rows: plan,
    new_suppliers: [...newSuppliers.values()],
    counts: { create: count('create'), update: count('update'), same: count('same'), error: count('error') },
  };
}

/** Applies a plan from planImport. Returns the counts. */
export function applyImport(db, plan) {
  const cols = ['name', 'sku', 'category', 'unit', 'supplier_id', 'unit_cost', 'par_level', 'recipe_unit', 'units_per_pack', 'allergens', 'active'];
  tx(db, () => {
    const supplierIds = new Map();
    for (const name of plan.new_suppliers) {
      supplierIds.set(`new:${norm(name)}`, db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(name).lastInsertRowid);
    }
    const sid = (v) => (typeof v === 'string' && v.startsWith('new:') ? supplierIds.get(v) : v);
    for (const r of plan.rows) {
      if (r.action === 'create') {
        const p = { unit: 'each', unit_cost: 0, par_level: 0, units_per_pack: 1, active: 1, ...Object.fromEntries(Object.entries(r.set).filter(([, v]) => v !== undefined)) };
        p.supplier_id = sid(p.supplier_id);
        const use = cols.filter((c) => p[c] !== undefined);
        db.prepare(`INSERT INTO products (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`).run(...use.map((c) => p[c]));
      } else if (r.action === 'update') {
        const set = { ...r.set };
        if ('supplier_id' in set) set.supplier_id = sid(set.supplier_id);
        const use = Object.keys(set).filter((c) => cols.includes(c));
        db.prepare(`UPDATE products SET ${use.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...use.map((c) => set[c]), r.id);
      }
    }
  });
  return { ...plan.counts, suppliers_added: plan.new_suppliers.length };
}
