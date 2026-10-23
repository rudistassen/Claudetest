import { HttpError } from './util.js';

/**
 * A stand-in for the demo and tests: "reads" an invoice from one of the suppliers already set up, with a couple
 * of prices changed and one item the system hasn't seen, so the matching and review can be tried without a key.
 */
export function demoInvoiceReader(db) {
  let n = 0;
  return {
    model: 'demo',
    demo: true,
    async read() {
      const suppliers = db.prepare(`SELECT s.* FROM suppliers s WHERE s.active = 1
        AND (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id AND p.active = 1) >= 3 ORDER BY s.id`).all();
      if (!suppliers.length) throw new HttpError(400, 'Add a supplier with some products first');
      const s = suppliers[n++ % suppliers.length];
      const products = db.prepare('SELECT * FROM products WHERE supplier_id = ? AND active = 1 ORDER BY id LIMIT 5').all(s.id);
      const lines = products.map((p, i) => {
        const price = Math.round(p.unit_cost * (i === 0 ? 1.06 : i === 2 ? 0.95 : 1) * 100) / 100;
        const qty = 2 + (i % 3) * 2;
        // Suppliers rarely use exactly our wording.
        const description = i === 1 ? `${p.name.toUpperCase()} ${p.unit ? `(${p.unit})` : ''}`.trim() : p.name;
        return { description, sku: p.sku, quantity: qty, unit: p.unit, unit_price: price, line_total: Math.round(qty * price * 100) / 100, vat_rate: 0 };
      });
      lines.push({ description: 'Seasonal special – spiced syrup 750ml', sku: 'SEAS-01', quantity: 2, unit: 'bottle', unit_price: 6.5, line_total: 13, vat_rate: 20 });
      const subtotal = Math.round(lines.reduce((t, l) => t + l.line_total, 0) * 100) / 100;
      const vat = Math.round(lines.reduce((t, l) => t + (l.line_total * (l.vat_rate ?? 0)) / 100, 0) * 100) / 100;
      const today = new Date().toISOString().slice(0, 10);
      return {
        is_invoice: true,
        supplier: { name: `${s.name} Ltd`, email: s.email, phone: s.phone, vat_number: 'GB123456789', address: null },
        invoice_number: `INV-${String(40000 + Math.floor(Math.random() * 9999))}`,
        invoice_date: today,
        due_date: null,
        order_reference: null,
        currency: 'GBP',
        lines,
        subtotal,
        vat,
        total: Math.round((subtotal + vat) * 100) / 100,
        notes: 'Demo: this invoice was made up from your products – in the real app the uploaded file is read.',
      };
    },
  };
}
