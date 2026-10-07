import { api, esc, openModal, toast } from '../lib.js';

// Setup → Products → Import: products from a spreadsheet (Excel or CSV) or rows pasted from Excel. The file is
// read here in the browser, previewed by the server, and only imported once confirmed.

const TEMPLATE_HEADERS = ['Name', 'SKU', 'Category', 'Unit', 'Supplier', 'Unit cost', 'Par level', 'Recipe unit', 'Recipe units per pack', 'Allergens', 'VAT code', 'Active'];
const TEMPLATE_EXAMPLES = [
  ['Whole milk 4L', 'MLK-4L', 'Dairy', 'bottle', 'Valley Dairy', '3.20', '6', 'ml', '4000', 'Milk', 'ZERORATEDINPUT', 'yes'],
  ['Espresso beans 1kg', 'ESP-1KG', 'Coffee', 'bag', 'Origin Coffee Roasters', '18.50', '4', 'g', '1000', '', 'ZERORATEDINPUT', 'yes'],
];
const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

/** Splits CSV or tab-separated text (Excel copy & paste) into rows of cells. */
export function parseTable(text) {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

export function downloadFile(name, content, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Every product in the import layout, so it can be edited in Excel and imported back. */
export function exportProducts(products, allergenLabels) {
  const label = new Map(allergenLabels);
  const rows = products.map((p) => [p.name, p.sku ?? '', p.category ?? '', p.unit ?? '', p.supplier_name ?? '', p.unit_cost ?? 0, p.par_level ?? 0,
    p.recipe_unit ?? '', p.units_per_pack ?? 1, (p.allergens ?? '').split(',').filter(Boolean).map((k) => label.get(k) ?? k).join(', '), p.vat_code ?? '', p.active ? 'yes' : 'no']);
  downloadFile(`Atlas products ${new Date().toISOString().slice(0, 10)}.csv`, toCsv([TEMPLATE_HEADERS, ...rows]));
}

function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  // The standalone demo has a stand-in for Node's Buffer that would confuse the Excel reader; hide it while it loads.
  const standIn = globalThis.Buffer && typeof globalThis.Buffer.isBuffer !== 'function' ? globalThis.Buffer : null;
  if (standIn) delete globalThis.Buffer;
  const restore = () => { if (standIn) globalThis.Buffer = standIn; };
  const failed = new Error('Couldn’t load the Excel reader (are you online?). In Excel use File → Save As → CSV (Comma delimited), then choose that file instead.');
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src: XLSX_URL, async: true, charset: 'utf-8' });
    s.onload = () => { restore(); if (window.XLSX) resolve(window.XLSX); else reject(failed); };
    s.onerror = () => { restore(); reject(failed); };
    document.head.append(s);
  });
}

async function readFile(file) {
  if (/\.xlsx?$/i.test(file.name)) {
    const XLSX = await loadXlsx();
    const book = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheet = book.Sheets[book.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true });
  }
  return parseTable(await file.text());
}

// The heading row is the first one with a Name (or Product / Item) column, so a title above the table is skipped;
// failing that, the first row with anything in it. The rows below it are products.
const NAME_HEADING = /^(product|item)?\s*(name)?$/i;
function split(table) {
  const rows = table.map((r) => (Array.isArray(r) ? r : []).map((c) => (typeof c === 'string' ? c.trim() : c)));
  const filled = (r) => r.some((c) => c !== '' && c !== null && c !== undefined);
  let start = rows.slice(0, 20).findIndex((r) => r.some((c) => typeof c === 'string' && c && NAME_HEADING.test(c)));
  if (start < 0) start = rows.findIndex(filled);
  if (start < 0) return null;
  return { headers: rows[start].map((h) => String(h ?? '')), rows: rows.slice(start + 1), heading_line: start + 1 };
}

const ACTIONS = { create: ['New', 'badge-completed'], update: ['Update', 'badge-in_progress'], same: ['No change', 'badge-draft'], error: ['Problem', 'badge-cancelled'] };

export function openProductImport(ctx) {
  let data = null;
  let plan = null;
  const { form } = openModal({
    title: 'Import products',
    wide: true,
    submitLabel: 'Import',
    body: `
      <p>Add products in bulk, or update the ones you have, from a spreadsheet. The first row must be the column headings;
        <strong>Name</strong> is the only one you must have. <a href="#" id="template">Download the template</a> to see the rest.</p>
      <div class="import-pick">
        <label class="btn" for="import-file">Choose a file…</label>
        <input type="file" id="import-file" accept=".csv,.tsv,.txt,.xlsx,.xls" hidden>
        <span class="muted small" id="file-name">Excel (.xlsx) or CSV</span>
      </div>
      <details class="import-paste"><summary>…or paste rows copied from Excel</summary>
        <textarea id="import-text" rows="5" placeholder="Copy the cells in Excel (including the heading row) and paste here"></textarea>
      </details>
      <div id="import-preview"></div>
      <details class="small muted import-help"><summary>How it works</summary>
        <ul>
          <li>Products already in Atlas are matched by <strong>SKU</strong>, then by <strong>name</strong>, and updated. Anything else is added as new.</li>
          <li>A blank cell leaves that detail as it is. Nothing is deleted – to stop using a product, put <strong>no</strong> in the Active column.</li>
          <li>A supplier that isn’t set up yet is added for you.</li>
          <li>Allergens: the names separated by commas, e.g. <em>Milk, Gluten, Soya</em>. Put <em>none</em> to clear them.</li>
          <li>VAT code: the Xero code, e.g. <em>INPUT2</em> (20%) or <em>ZERORATEDINPUT</em> – or just <em>20%</em>, <em>5%</em>, <em>zero</em>, <em>exempt</em> or <em>no VAT</em>.</li>
          <li>You’ll see exactly what will change before anything is saved. To edit everything in Excel, use <strong>Export</strong> on the Products page, change it, and import it back.</li>
        </ul>
      </details>`,
    onSubmit: async () => {
      if (!plan || !(plan.counts.create + plan.counts.update)) throw new Error('There’s nothing to import yet');
      const r = await api('/products/import', { method: 'POST', body: { ...data, apply: true } });
      toast(`Imported: ${r.create} added, ${r.update} updated${r.suppliers_added ? `, ${r.suppliers_added} new supplier${r.suppliers_added === 1 ? '' : 's'}` : ''}`);
      ctx.rerender();
    },
  });
  const submit = form.querySelector('button[type=submit]');
  const preview = form.querySelector('#import-preview');
  const setSubmit = () => {
    const n = plan ? plan.counts.create + plan.counts.update : 0;
    submit.disabled = !n;
    submit.textContent = n ? `Import ${n} product${n === 1 ? '' : 's'}` : 'Import';
  };
  setSubmit();

  const show = async (table, source) => {
    plan = null;
    setSubmit();
    data = table && split(table);
    if (!data) { preview.innerHTML = `<p class="alert-text">${esc(source)} looks empty.</p>`; return; }
    preview.innerHTML = '<div class="loading">Checking…</div>';
    try {
      plan = await api('/products/import', { method: 'POST', body: data });
    } catch (err) {
      preview.innerHTML = `<p class="alert-text">${esc(err.message)}</p>`;
      return;
    }
    const c = plan.counts;
    const used = plan.columns.filter((x) => x.field).map((x) => x.heading);
    const ignored = plan.columns.filter((x) => !x.field && x.heading).map((x) => x.heading);
    const order = { error: 0, create: 1, update: 2, same: 3 };
    const rows = [...plan.rows].sort((a, b) => order[a.action] - order[b.action] || a.line - b.line);
    preview.innerHTML = `
      <div class="import-summary">
        <span><strong>${c.create}</strong> new</span><span><strong>${c.update}</strong> to update</span>
        <span><strong>${c.same}</strong> unchanged</span>${c.error ? `<span class="alert-text"><strong>${c.error}</strong> with problems (skipped)</span>` : ''}
      </div>
      <p class="small muted">Using columns: ${used.map(esc).join(', ')}${ignored.length ? ` · ignoring: ${ignored.map(esc).join(', ')}` : ''}</p>
      ${plan.new_suppliers.length ? `<p class="small">New suppliers to add: <strong>${plan.new_suppliers.map(esc).join(', ')}</strong></p>` : ''}
      ${rows.length ? `<div class="table-wrap import-table"><table>
        <thead><tr><th>Line</th><th>Product</th><th></th><th>Details</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.action === 'same' ? 'inactive' : ''}">
          <td class="num">${r.line}</td><td>${esc(r.name)}</td>
          <td><span class="badge ${ACTIONS[r.action][1]}">${ACTIONS[r.action][0]}</span></td>
          <td class="small">${r.action === 'error' ? `<span class="alert-text">${esc(r.error)}</span>` : r.action === 'update' ? esc(r.changes.join(', ')) : ''}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No products found under the heading row.</p>'}`;
    setSubmit();
  };

  form.querySelector('#template').addEventListener('click', (e) => {
    e.preventDefault();
    downloadFile('Atlas products template.csv', toCsv([TEMPLATE_HEADERS, ...TEMPLATE_EXAMPLES]));
  });
  form.querySelector('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    form.querySelector('#file-name').textContent = file.name;
    form.querySelector('#import-text').value = '';
    preview.innerHTML = '<div class="loading">Reading the file…</div>';
    try {
      await show(await readFile(file), file.name);
    } catch (err) {
      preview.innerHTML = `<p class="alert-text">${esc(err.message)}</p>`;
    }
  });
  let timer;
  form.querySelector('#import-text').addEventListener('input', (e) => {
    clearTimeout(timer);
    const text = e.target.value;
    timer = setTimeout(() => {
      if (!text.trim()) { preview.innerHTML = ''; plan = null; setSubmit(); return; }
      form.querySelector('#file-name').textContent = 'Excel (.xlsx) or CSV';
      show(parseTable(text), 'What you pasted');
    }, 400);
  });
}
