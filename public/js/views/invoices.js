import { api, confirmDialog, esc, fmtDate, fmtDateTime, money, openModal, qs, showError, toast } from '../lib.js';

// Supplier invoices: upload a PDF or photo, it's read and matched to a supplier and products, then checked and confirmed.

const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_BYTES = 10 * 1024 * 1024;
const MATCH = {
  learnt: ['Remembered', 'badge-completed', 'Matched the same way as last time for this supplier'],
  sku: ['Code match', 'badge-completed', 'The supplier’s product code matches'],
  name: ['Name match', 'badge-completed', 'The name matches'],
  similar: ['Best guess', 'badge-in_progress', 'A similar name – check it’s right'],
  manual: ['You chose', 'badge-sent', 'Picked by hand; it will be remembered for this supplier'],
  new: ['New product', 'badge-sent', 'Will be added to your products'],
};

const readAsBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(new Error(`Couldn’t read ${file.name}`));
  r.readAsDataURL(file);
});

function setupHelp(data) {
  if (data.demo) return '<p class="notice">Demo: uploading any PDF or photo makes up an invoice from one of your suppliers, so you can try the matching and checking. In the real app, the file you upload is read.</p>';
  if (data.ready) return '';
  return `
    <section class="card email-setup">
      <h2>First, switch on invoice reading (one-off, about 5 minutes)</h2>
      <p>Brewly uses <strong>Claude</strong>, an AI model from Anthropic, to read invoices – any supplier’s layout, PDFs or photos. It costs roughly <strong>5–10p per invoice</strong>, paid to Anthropic.</p>
      <ol>
        <li>Go to <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a> and sign up (or sign in).</li>
        <li>Under <strong>Billing</strong>, add a card and some credit (£5 goes a long way).</li>
        <li>Under <strong>API keys</strong>, click <strong>Create key</strong>, name it “Brewly” and copy it (it starts with <code>sk-ant-</code>).</li>
        <li>In Railway, open your app → <strong>Variables</strong>, add <code>ANTHROPIC_API_KEY</code> = the key, then click <strong>Deploy</strong>.</li>
      </ol>
    </section>`;
}

export async function renderList(ctx) {
  const { el, state, query, stale, navigate } = ctx;
  const status = query.status === 'confirmed' ? 'confirmed' : 'review';
  const [data, inbox] = await Promise.all([api(`/invoices${qs({ status })}`), api('/invoice-inbox').catch(() => null)]);
  if (stale()) return;

  el.innerHTML = `
    <div class="page-head">
      <h1>Supplier invoices</h1>
      <div class="actions"><button class="btn btn-primary" id="upload" ${data.ready ? '' : 'disabled'}>Upload invoices</button></div>
    </div>
    ${setupHelp(data)}
    <div class="tabs">
      <a href="#/invoices" class="${status === 'review' ? 'active' : ''}">To check${data.to_check ? ` (${data.to_check})` : ''}</a>
      <a href="#/invoices?status=confirmed" class="${status === 'confirmed' ? 'active' : ''}">Confirmed</a>
    </div>
    ${data.ready ? '<div class="drop-hint muted small">Tip: you can drag PDFs or photos of invoices straight onto this page.</div>' : ''}
    <section class="card">
      ${data.invoices.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Supplier</th><th>Invoice</th><th>Date</th>${state.multiSite ? '<th>Site</th>' : ''}<th>Lines</th><th class="num">Total</th><th>${status === 'review' ? 'Uploaded' : 'Confirmed'}</th></tr></thead>
        <tbody>${data.invoices.map((i) => `<tr class="clickable" data-open="${i.id}">
          <td><strong>${esc(i.supplier_name ?? 'Unknown supplier')}</strong>${i.new_supplier ? ' <span class="badge badge-sent">New supplier</span>' : ''}${i.source === 'email' ? ' <span class="badge" title="Arrived in the invoice inbox">✉ Emailed</span>' : ''}</td>
          <td>${esc(i.invoice_number ?? '–')}</td>
          <td>${i.invoice_date ? fmtDate(i.invoice_date) : '–'}</td>
          ${state.multiSite ? `<td>${esc(i.location_name)}</td>` : ''}
          <td>${i.line_count}${i.unmatched && status === 'review' ? ` <span class="small alert-text">${i.unmatched} to match</span>` : ''}</td>
          <td class="num">${i.total === null ? '–' : money(i.total)}</td>
          <td class="small muted">${fmtDateTime(status === 'review' ? i.created_at : i.confirmed_at)}</td></tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty">${status === 'review' ? 'No invoices waiting to be checked.' : 'No confirmed invoices yet.'}</div>`}
    </section>
    ${inbox ? inboxCard(inbox, state) : ''}`;
  wireInbox(ctx);

  el.querySelectorAll('[data-open]').forEach((tr) => tr.addEventListener('click', () => navigate(`invoices/${tr.dataset.open}`)));
  if (!data.ready) return;
  el.querySelector('#upload').addEventListener('click', () => openUpload(ctx));
  // Drag and drop files onto the page.
  el.ondragover = (e) => { e.preventDefault(); el.classList.add('is-dropping'); };
  el.ondragleave = (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('is-dropping'); };
  el.ondrop = (e) => {
    e.preventDefault();
    el.classList.remove('is-dropping');
    if (e.dataTransfer.files.length) openUpload(ctx, [...e.dataTransfer.files]);
  };
}

// --- The shared invoice inbox (Microsoft 365) ---

const EMAIL_STATUS = { imported: ['Added', 'badge-received'], skipped: ['Skipped', ''], failed: ['Couldn’t read', 'badge-cancelled'] };

// What Brewly can see of the inbox settings in Railway (names only), so a missing or misspelt one stands out.
function setupChecklist(setup) {
  if (!setup?.some((v) => v.status !== 'missing')) return '';
  const line = (v) => {
    if (v.status === 'ok') return `<li class="tone-good">✓ <code>${esc(v.name)}</code> found</li>`;
    if (v.status === 'empty') return `<li class="tone-bad">✗ <code>${esc(v.name)}</code> is there but empty – paste its value in again</li>`;
    if (v.status === 'misnamed') return `<li class="tone-bad">✗ <code>${esc(v.name)}</code> not found – there’s one called <code>${esc(v.found)}</code>${/\s/.test(v.found) ? ' (it has a space in it)' : v.found !== v.found.toUpperCase() ? ' (it needs capital letters)' : ''}; rename it to exactly <code>${esc(v.name)}</code></li>`;
    return `<li class="tone-bad">✗ <code>${esc(v.name)}</code> not found – add it in Railway → Variables</li>`;
  };
  return `<div class="notice inbox-setup"><strong>Nearly there – Brewly can see some of the settings:</strong><ul>${setup.map(line).join('')}</ul>
    <span class="small">After changing Variables in Railway, click <strong>Deploy</strong> (or <strong>Apply changes</strong>) and wait a couple of minutes.</span></div>`;
}

function inboxCard(inbox, state) {
  if (!inbox.configured) {
    return `<details class="card inbox-card" ${inbox.setup?.some((v) => v.status !== 'missing') ? 'open' : ''}><summary><strong>✉ Invoice inbox</strong> <span class="muted small">– have emailed invoices added automatically</span></summary>
      <p>Invoices emailed to a shared Microsoft 365 inbox (for example <em>invoices@yourcompany.co.uk</em>) can be read and added here on their own, every few minutes.
      To switch it on, an admin registers Brewly in Microsoft Entra with permission to read that mailbox, then adds these settings in Railway:</p>
      <ul class="small"><li><code>MS_TENANT_ID</code>, <code>MS_CLIENT_ID</code>, <code>MS_CLIENT_SECRET</code> – from the app registration</li>
        <li><code>INVOICE_MAILBOX</code> – the shared inbox’s email address</li></ul>
      ${setupChecklist(inbox.setup)}
      <p class="muted small">Brewly only reads the mailbox – it never sends, moves or deletes emails.</p></details>`;
  }
  const sites = state.locations.filter((l) => l.active);
  return `<section class="card inbox-card">
    <div class="card-head"><h2>✉ Invoice inbox</h2>
      <button class="btn btn-small" id="inbox-check" ${inbox.reader_ready ? '' : 'disabled'}>Check now</button></div>
    <p class="small">Invoices emailed to <strong>${esc(inbox.mailbox)}</strong> are read and added above to check, every few minutes.
      ${inbox.last_check ? `Last checked ${fmtDateTime(inbox.last_check.replace('T', ' ').slice(0, 19))}.` : 'Not checked yet.'}</p>
    ${inbox.last_error ? `<p class="notice notice-warn">${esc(inbox.last_error)}</p>` : ''}
    ${!inbox.reader_ready ? '<p class="notice">Invoice reading needs ANTHROPIC_API_KEY before emailed invoices can be read.</p>' : ''}
    ${state.isAdmin && sites.length > 1 ? `<label class="field inbox-site"><span>Emailed invoices go to</span>
      <select id="inbox-site">${sites.map((l) => `<option value="${l.id}" ${l.id === (inbox.default_site_id ?? sites[0].id) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
      <small>…unless a site’s name is in the email’s subject or first lines (e.g. “Invoice – Harbour”). You can change the site on each invoice too.</small></label>` : ''}
    ${inbox.recent.length ? `<h3>Recent emails</h3><div class="table-wrap"><table class="inbox-list">
      <thead><tr><th>Received</th><th>From</th><th>Subject</th><th>Result</th></tr></thead>
      <tbody>${inbox.recent.map((m) => `<tr>
        <td class="small">${m.received_at ? fmtDateTime(m.received_at.replace('T', ' ').slice(0, 19)) : '–'}</td>
        <td>${esc(m.from_name ?? m.from_address ?? '')}</td>
        <td>${esc(m.subject ?? '')}</td>
        <td><span class="badge ${EMAIL_STATUS[m.status]?.[1] ?? ''}">${EMAIL_STATUS[m.status]?.[0] ?? esc(m.status)}</span>
          ${m.invoice_ids.map((id) => `<a href="#/invoices/${id}" class="small">open</a>`).join(' ')}
          ${m.detail ? `<small class="muted">${esc(m.detail)}</small>` : ''}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted small">No emails with invoices yet – only emails that arrive from now on are read.</p>'}
  </section>`;
}

function wireInbox(ctx) {
  const { el } = ctx;
  el.querySelector('#inbox-check')?.addEventListener('click', async (e) => {
    const b = e.target;
    b.disabled = true;
    b.textContent = 'Checking…';
    try {
      const r = await api('/invoice-inbox/check', { method: 'POST' });
      toast(r.error ? r.error : r.invoices ? `${r.invoices} invoice${r.invoices === 1 ? '' : 's'} added from the inbox` : 'No new invoices in the inbox', r.error ? 'error' : 'ok');
      ctx.rerender();
    } catch (err) { showError(err); b.disabled = false; b.textContent = 'Check now'; }
  });
  el.querySelector('#inbox-site')?.addEventListener('change', async (e) => {
    try {
      await api('/invoice-inbox', { method: 'PUT', body: { default_site_id: Number(e.target.value) } });
      toast('Saved');
    } catch (err) { showError(err); }
  });
}

function openUpload(ctx, dropped = []) {
  const { state, navigate } = ctx;
  let files = dropped;
  const sites = state.locations.filter((l) => l.active);
  const { form } = openModal({
    title: 'Upload invoices',
    submitLabel: 'Read invoices',
    body: `
      ${sites.length > 1 ? `<label class="field"><span>Delivered to</span><select name="location_id">${sites.map((l) => `<option value="${l.id}" ${l.id === state.locationId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>` : ''}
      <label class="drop-zone" for="invoice-files">
        <strong>Choose invoice files</strong>
        <span class="muted small">PDFs, or photos of paper invoices (JPEG or PNG). You can pick several at once.</span>
        <input type="file" id="invoice-files" accept=".pdf,application/pdf,image/jpeg,image/png,image/webp" multiple hidden>
      </label>
      <ul class="upload-list" id="upload-list"></ul>
      <p class="small muted">Each invoice takes about 20–60 seconds to read. You check everything before it’s saved to your products.</p>`,
    onSubmit: async (v) => {
      if (!files.length) throw new Error('Choose at least one invoice');
      const list = form.querySelector('#upload-list');
      const done = [];
      const failed = [];
      for (const [i, file] of files.entries()) {
        const li = list.children[i];
        li.className = 'is-reading';
        li.querySelector('.upload-state').textContent = 'Reading…';
        try {
          if (!FILE_TYPES.includes(file.type)) throw new Error(/heic|heif/i.test(file.type || file.name) ? 'iPhone photo format – set the camera to “Most Compatible”, or save it as JPEG' : 'Not a PDF, JPEG or PNG');
          if (file.size > MAX_BYTES) throw new Error('Over 10 MB');
          const inv = await api('/invoices/scan', { method: 'POST', body: { location_id: v.location_id ?? state.locationId, file_name: file.name, media_type: file.type, data: await readAsBase64(file) } });
          done.push(inv);
          li.className = 'is-done';
          li.querySelector('.upload-state').textContent = `✓ ${inv.matched_supplier_name ?? inv.supplier_name ?? 'Read'} · ${inv.lines.length} lines`;
        } catch (err) {
          failed.push(file.name);
          li.className = 'is-failed';
          li.querySelector('.upload-state').textContent = err.message;
        }
      }
      if (failed.length) {
        files = files.filter((f) => failed.includes(f.name));
        throw new Error(`${failed.length} couldn’t be read (see above). ${done.length ? `${done.length} read OK and waiting to be checked.` : ''}`);
      }
      toast(`${done.length} invoice${done.length === 1 ? '' : 's'} read – check ${done.length === 1 ? 'it' : 'them'} and confirm`);
      navigate(done.length === 1 ? `invoices/${done[0].id}` : 'invoices');
    },
  });
  const list = form.querySelector('#upload-list');
  const show = () => {
    list.innerHTML = files.map((f) => `<li><span>${esc(f.name)}</span><span class="upload-state muted small">${(f.size / 1024 / 1024).toFixed(1)} MB</span></li>`).join('');
  };
  form.querySelector('#invoice-files').addEventListener('change', (e) => { files = [...e.target.files]; show(); });
  const zone = form.querySelector('.drop-zone');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('is-over'); files = [...e.dataTransfer.files]; show(); });
  show();
}

export async function renderInvoice(ctx) {
  const { el, state, params, stale, navigate, rerender } = ctx;
  const invId = Number(params[0]);
  const [inv, suppliers, products, cats, vat] = await Promise.all([api(`/invoices/${invId}`), api('/suppliers'), api('/products'),
    api('/product-categories').catch(() => []), api('/vat-codes').catch(() => ({ codes: [] }))]);
  const categories = cats.map((c) => c.name);
  // A new product's VAT code: what was chosen, else the usual one for the VAT rate on the invoice line.
  const vatForRate = (rate) => ({ 20: 'INPUT2', 5: 'RRINPUT', 0: 'ZERORATEDINPUT' })[Number(rate)] ?? '';
  const vatSelect = (cls, chosen) => `<select class="${cls}" aria-label="VAT code"><option value="">VAT code…</option>${vat.codes.map((v) => `<option value="${esc(v.code)}" ${v.code === chosen ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>`;
  const catSelect = (cls, chosen) => `<select class="${cls}" aria-label="Category"><option value="">Category…</option>${categories.map((c) => `<option ${c === chosen ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
  if (stale()) return;
  const editable = inv.status === 'review';
  const canAdd = state.can('setup.products');
  const sites = state.locations.filter((l) => l.active);
  const productById = new Map(products.map((p) => [p.id, p]));

  const productOptions = (supplierId, selected) => {
    const theirs = products.filter((p) => p.active && p.supplier_id === supplierId);
    const others = products.filter((p) => p.active && p.supplier_id !== supplierId);
    const opt = (p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}${p.unit ? ` (${esc(p.unit)})` : ''}</option>`;
    return `<option value="">— Not a stock item —</option>
      ${canAdd ? `<option value="new" ${selected === 'new' ? 'selected' : ''}>➕ Add as a new product</option>` : ''}
      ${theirs.length ? `<optgroup label="This supplier’s products">${theirs.map(opt).join('')}</optgroup>` : ''}
      <optgroup label="${theirs.length ? 'Other products' : 'Products'}">${others.map(opt).join('')}</optgroup>`;
  };
  // Price on the invoice against the product's current cost.
  const costCell = (line, productId, checked) => {
    const p = typeof productId === 'number' ? productById.get(productId) : null;
    if (!p || line.unit_price === null || line.unit_price === undefined) return '<span class="muted small">–</span>';
    if (Math.abs(p.unit_cost - line.unit_price) < 0.005) return `<span class="small muted">${money(p.unit_cost)} – same</span>`;
    const change = p.unit_cost ? ((line.unit_price - p.unit_cost) / p.unit_cost) * 100 : null;
    const big = change !== null && Math.abs(change) > 50;
    return `<label class="cost-change">
      ${editable ? `<input type="checkbox" data-update-cost ${checked ? 'checked' : ''}>` : ''}
      <span>${money(p.unit_cost)} → <strong>${money(line.unit_price)}</strong>
        ${change === null ? '' : `<span class="${change > 0 ? 'tone-bad' : 'tone-good'}">${change > 0 ? '▲' : '▼'}${Math.abs(change).toFixed(1)}%</span>`}
        ${editable ? `<small>${big ? 'Big change – check the units match' : 'Update cost'}</small>` : line.update_cost ? '<small>Cost updated</small>' : ''}</span></label>`;
  };
  const matchBadge = (m) => (m && MATCH[m] ? `<span class="badge ${MATCH[m][1]}" title="${esc(MATCH[m][2])}">${MATCH[m][0]}</span>` : '<span class="badge badge-cancelled">Not matched</span>');

  const supplierSelect = () => `<select name="supplier_id" id="inv-supplier" ${editable ? '' : 'disabled'}>
    ${!inv.supplier_id ? `<option value="" disabled ${canAdd ? '' : 'selected'}>— Choose the supplier —</option>` : ''}
    ${!inv.supplier_id && canAdd ? `<option value="new" selected>➕ Add new supplier: ${esc(inv.supplier_name ?? '')}</option>` : ''}
    ${suppliers.map((s) => `<option value="${s.id}" ${s.id === inv.supplier_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
  </select>`;
  const recognisedFrom = inv.supplier_id && inv.supplier_name && inv.supplier_name !== inv.matched_supplier_name
    ? `<small class="muted">Recognised from “${esc(inv.supplier_name)}” on the invoice</small>`
    : !inv.supplier_id ? `<small class="alert-text">“${esc(inv.supplier_name ?? 'The supplier')}” isn’t one of your suppliers yet</small>` : '';
  const input = (name, value, attrs = '') => `<input name="${name}" value="${esc(value ?? '')}" ${attrs} ${editable ? '' : 'disabled'}>`;
  // Money shows two decimal places (3.10, not 3.1); quantities as they are.
  const numIn = (cls, value, step = '0.01') => {
    const shown = value === null || value === undefined ? '' : step === '0.01' ? Number(value).toFixed(2) : String(value);
    return editable ? `<input class="${cls}" type="number" step="${step}" value="${shown}">` : shown || '–';
  };

  el.innerHTML = `
    <div class="page-head">
      <h1>${esc(inv.matched_supplier_name ?? inv.supplier_name ?? 'Invoice')} ${inv.invoice_number ? `· ${esc(inv.invoice_number)}` : ''}</h1>
      <div class="actions">
        <a class="btn" href="#/invoices${editable ? '' : '?status=confirmed'}">‹ All invoices</a>
        ${editable || state.isAdmin ? '<button class="btn btn-ghost" id="delete">Delete</button>' : ''}
        ${editable ? '<button class="btn" id="save">Save for later</button><button class="btn btn-primary" id="confirm">Confirm invoice</button>' : ''}
      </div>
    </div>
    ${editable ? '' : `<p class="publish-ok">✓ Confirmed by ${esc(inv.confirmed_by_name ?? 'someone')} on ${fmtDateTime(inv.confirmed_at)}</p>`}
    ${!editable && (inv.xero_url || inv.xero_ready) ? `<div class="xero-bar ${inv.xero_url ? 'is-sent' : ''}">
      ${inv.xero_url ? `<span>✓ In Xero as a draft bill${inv.xero_sent_at ? ` · sent ${fmtDateTime(inv.xero_sent_at)}` : ''}</span><a class="btn btn-small" href="${esc(inv.xero_url)}" target="_blank" rel="noopener">Open in Xero ↗</a>`
        : `<span>Not in Xero yet</span><button class="btn btn-small btn-primary" id="send-xero">Send to Xero</button>`}
      ${inv.xero_error ? `<small class="${inv.xero_url ? 'muted' : 'tone-bad'}">${esc(inv.xero_error)}</small>` : ''}
    </div>` : ''}
    ${inv.warnings.map((w) => `<p class="notice notice-warn">⚠ ${esc(w.text)}${w.id ? ` – <a href="#/invoices/${w.id}">open it</a>` : ''}</p>`).join('')}
    <div class="invoice-layout">
      <section class="card invoice-doc"><div id="doc" class="loading">Loading the invoice…</div>
        <p class="small muted">${esc(inv.file_name ?? '')} · ${inv.source === 'email'
          ? `emailed by ${esc(inv.email_from ?? 'unknown sender')}${inv.email_subject ? ` (“${esc(inv.email_subject)}”)` : ''}, added`
          : `uploaded by ${esc(inv.created_by_name ?? '')}`} ${fmtDateTime(inv.created_at)}</p></section>
      <section class="card invoice-form">
        <div class="row">
          <label class="field"><span>Supplier</span>${supplierSelect()}${recognisedFrom}</label>
          ${sites.length > 1 ? `<label class="field"><span>Delivered to</span><select name="location_id" ${editable ? '' : 'disabled'}>${sites.map((l) => `<option value="${l.id}" ${l.id === inv.location_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>` : ''}
        </div>
        <div class="row">
          <label class="field"><span>Invoice number</span>${input('invoice_number', inv.invoice_number)}</label>
          <label class="field"><span>Invoice date</span>${input('invoice_date', inv.invoice_date, 'type="date"')}</label>
          <label class="field"><span>Due date</span>${input('due_date', inv.due_date, 'type="date"')}</label>
        </div>
        ${inv.notes ? `<p class="small muted">Note: ${esc(inv.notes)}</p>` : ''}
        <h2 class="spaced">Items <span class="muted small">${inv.lines.length} line${inv.lines.length === 1 ? '' : 's'}${inv.unmatched ? ` · <span class="alert-text">${inv.unmatched} not matched</span>` : ''}</span></h2>
        <div class="table-wrap"><table class="invoice-lines">
          <thead><tr><th>On the invoice</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th><th>Your product</th><th>Cost</th></tr></thead>
          <tbody>${inv.lines.map((l) => `<tr data-line="${l.id}">
            <td class="inv-desc">${editable ? `<input class="l-desc" value="${esc(l.description)}">` : esc(l.description)}
              ${l.sku ? `<small class="muted">Code ${esc(l.sku)}</small>` : ''}${l.unit ? `<small class="muted">per ${esc(l.unit)}</small>` : ''}</td>
            <td class="num">${numIn('l-qty', l.quantity, 'any')}</td>
            <td class="num">${numIn('l-price', l.unit_price)}</td>
            <td class="num">${numIn('l-total', l.line_total)}</td>
            <td class="inv-product">${editable ? `<select class="l-product">${productOptions(inv.supplier_id, l.product_id ?? (l.match === 'new' ? 'new' : null))}</select>` : esc(l.product_name ?? '— Not a stock item —')}
              ${editable ? `<span class="l-newbits" ${l.match === 'new' && !l.product_id ? '' : 'hidden'}>${catSelect('l-newcat', l.new_category)}${vatSelect('l-newvat', l.new_vat_code ?? vatForRate(l.vat_rate))}</span>` : ''}
              <span class="l-badge">${matchBadge(l.match)}</span>
              ${editable && canAdd && (!l.product_id || l.match === 'similar') ? '<button type="button" class="link-btn l-new" title="Add this as a new product, choosing its name, unit and cost">+ New product</button>' : ''}</td>
            <td class="l-cost">${costCell(l, l.product_id, !!l.update_cost)}</td></tr>`).join('')}</tbody>
        </table></div>
        <div class="invoice-totals">
          <span class="muted">Lines add up to <strong id="lines-sum">${money(inv.lines_total)}</strong></span>
          <label>Subtotal ${numIn('t-subtotal', inv.subtotal)}</label>
          <label>VAT ${numIn('t-vat', inv.vat)}</label>
          <label>Total ${editable ? numIn('t-total', inv.total) : `<strong>${inv.total === null ? '–' : money(inv.total)}</strong>`}</label>
        </div>
        ${editable ? `<p class="small muted">Confirming ${canAdd ? 'adds any new supplier or products, ' : ''}updates the costs you’ve ticked, and remembers how you matched each item for next time.</p>` : ''}
      </section>
    </div>`;

  // Show the original next to the details.
  (async () => {
    const doc = el.querySelector('#doc');
    try {
      const r = await fetch(`/api/invoices/${invId}/file`);
      if (!r.ok) throw new Error();
      const url = URL.createObjectURL(await r.blob());
      if (stale()) return;
      doc.className = '';
      doc.innerHTML = inv.file_type === 'application/pdf'
        ? `<iframe src="${url}" title="Invoice" class="invoice-frame"></iframe><a class="small" href="${url}" target="_blank" rel="noopener">Open in a new tab</a>`
        : `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Invoice" class="invoice-img"></a>`;
    } catch {
      doc.className = 'muted';
      doc.textContent = 'The original file couldn’t be shown.';
    }
  })();

  if (!editable) {
    el.querySelector('#delete')?.addEventListener('click', () => remove());
    el.querySelector('#send-xero')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Sending…';
      try {
        const r = await api(`/invoices/${inv.id}/xero`, { method: 'POST' });
        toast(r.warning ?? 'Sent to Xero as a draft bill');
      } catch (err) { showError(err); }
      ctx.rerender();
    });
    return;
  }

  const rows = () => [...el.querySelectorAll('tr[data-line]')];
  const line = (tr) => inv.lines.find((l) => l.id === Number(tr.dataset.line));
  const val = (tr, cls) => { const v = tr.querySelector(cls)?.value; return v === '' || v === undefined ? null : Number(v); };
  const refreshRow = (tr) => {
    const l = line(tr);
    const raw = tr.querySelector('.l-product').value;
    const productId = raw === 'new' ? 'new' : raw ? Number(raw) : null;
    const price = val(tr, '.l-price');
    const p = typeof productId === 'number' ? productById.get(productId) : null;
    const change = p && price !== null && p.unit_cost ? Math.abs(price - p.unit_cost) / p.unit_cost : null;
    const keep = productId === l.product_id && tr.dataset.touched !== '1' ? !!l.update_cost : change !== null && change > 0.001 && change <= 0.5;
    tr.querySelector('.l-cost').innerHTML = costCell({ ...l, unit_price: price }, productId, keep);
    const match = productId === 'new' ? 'new' : !productId ? null : productId === l.product_id ? l.match : 'manual';
    tr.querySelector('.l-badge').innerHTML = matchBadge(match);
    // Adding it as a new product: choose its category and VAT code here.
    const bits = tr.querySelector('.l-newbits');
    if (bits) bits.hidden = productId !== 'new';
  };
  const refreshSum = () => {
    const sum = rows().reduce((t, tr) => t + (val(tr, '.l-total') ?? 0), 0);
    el.querySelector('#lines-sum').textContent = money(Math.round(sum * 100) / 100);
  };
  rows().forEach((tr) => {
    tr.querySelector('.l-product').addEventListener('change', () => { tr.dataset.touched = '1'; refreshRow(tr); });
    tr.querySelector('.l-price').addEventListener('input', () => { tr.dataset.touched = '1'; refreshRow(tr); });
    tr.querySelector('.l-total').addEventListener('input', refreshSum);
    tr.querySelector('.l-qty').addEventListener('input', () => {
      const q = val(tr, '.l-qty');
      const pr = val(tr, '.l-price');
      if (q !== null && pr !== null) { tr.querySelector('.l-total').value = (Math.round(q * pr * 100) / 100).toFixed(2); refreshSum(); }
    });
  });
  // "+ New product": add the line as a new product (name, unit and cost filled in from the invoice, to check),
  // then pick it for the line.
  rows().forEach((tr) => tr.querySelector('.l-new')?.addEventListener('click', async () => {
    const l = line(tr);
    const sup = el.querySelector('#inv-supplier');
    const supplierId = Number(sup.value) || null;
    const supplierName = supplierId ? sup.selectedOptions[0]?.textContent.trim() : null;
    const price = val(tr, '.l-price');
    openModal({
      title: 'Add a new product',
      body: `
        <label class="field"><span>Name</span><input name="name" required maxlength="150" value="${esc(tr.querySelector('.l-desc')?.value ?? l.description)}"></label>
        <div class="row">
          <label class="field"><span>Unit</span><input name="unit" maxlength="30" value="${esc(l.unit ?? 'each')}" placeholder="e.g. case of 12, kg, bottle"></label>
          <label class="field"><span>Cost per unit (£)</span><input name="unit_cost" type="number" min="0" step="0.01" value="${price ?? ''}"></label>
        </div>
        <div class="row">
          <label class="field"><span>Category</span><select name="category" ${categories.length ? 'required' : ''}><option value="">${categories.length ? '— Choose —' : '— None yet —'}</option>${categories.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
          <label class="field"><span>VAT code</span>${vatSelect('', vatForRate(l.vat_rate)).replace('<select class=""', '<select name="vat_code" required')}</label>
        </div>
        <label class="field"><span>Supplier’s code</span><input name="sku" maxlength="50" value="${esc(l.sku ?? '')}"></label>
        <p class="muted small">${supplierName ? `From ${esc(supplierName)}. ` : 'Choose the supplier above first to link the product to them. '}You can add par levels, allergens and more later under Stock &amp; Ordering → Products.</p>`,
      submitLabel: 'Add product',
      onSubmit: async (v) => {
        const made = await api('/products', { method: 'POST', body: { name: v.name, unit: v.unit || 'each', unit_cost: v.unit_cost === '' ? 0 : Number(v.unit_cost), category: v.category || null, vat_code: v.vat_code || null, sku: v.sku || null, supplier_id: supplierId } });
        products.push(made);
        productById.set(made.id, made);
        // Every line's list gets the new product; this line picks it.
        rows().forEach((r) => {
          const sel = r.querySelector('.l-product');
          const cur = r === tr ? made.id : sel.value === 'new' ? 'new' : sel.value ? Number(sel.value) : null;
          sel.innerHTML = productOptions(supplierId, cur);
        });
        tr.dataset.touched = '1';
        refreshRow(tr);
        toast(`${made.name} added – remember to save the invoice`);
      },
    });
  }));
  // Picking a different supplier re-sorts each line's product list to put their products first.
  el.querySelector('#inv-supplier').addEventListener('change', (e) => {
    const sid = Number(e.target.value) || null;
    rows().forEach((tr) => {
      const sel = tr.querySelector('.l-product');
      const cur = sel.value === 'new' ? 'new' : sel.value ? Number(sel.value) : null;
      sel.innerHTML = productOptions(sid, cur);
    });
  });

  const body = () => {
    const sup = el.querySelector('#inv-supplier').value;
    const field = (n) => el.querySelector(`[name=${n}]`)?.value || null;
    const t = (cls) => { const v = el.querySelector(cls)?.value; return v === '' || v === undefined ? null : Number(v); };
    return {
      supplier_id: sup && sup !== 'new' ? Number(sup) : null,
      new_supplier: sup === 'new',
      location_id: field('location_id') ? Number(field('location_id')) : undefined,
      invoice_number: field('invoice_number'),
      invoice_date: field('invoice_date'),
      due_date: field('due_date'),
      subtotal: t('.t-subtotal'),
      vat: t('.t-vat'),
      total: t('.t-total'),
      notes: inv.notes,
      lines: rows().map((tr) => {
        const l = line(tr);
        const raw = tr.querySelector('.l-product').value;
        return {
          id: l.id,
          description: tr.querySelector('.l-desc').value,
          sku: l.sku,
          unit: l.unit,
          vat_rate: l.vat_rate,
          quantity: val(tr, '.l-qty'),
          unit_price: val(tr, '.l-price'),
          line_total: val(tr, '.l-total'),
          product: raw === 'new' ? 'new' : raw ? Number(raw) : null,
          new_category: raw === 'new' ? tr.querySelector('.l-newcat')?.value || null : null,
          new_vat_code: raw === 'new' ? tr.querySelector('.l-newvat')?.value || null : null,
          update_cost: !!tr.querySelector('[data-update-cost]')?.checked,
        };
      }),
    };
  };
  const busy = (on) => el.querySelectorAll('.page-head button').forEach((b) => { b.disabled = on; });

  el.querySelector('#save').addEventListener('click', async () => {
    busy(true);
    try {
      await api(`/invoices/${invId}`, { method: 'PUT', body: body() });
      toast('Saved – it’s waiting under “To check”');
      rerender();
    } catch (err) { showError(err); busy(false); }
  });
  el.querySelector('#confirm').addEventListener('click', async () => {
    const b = body();
    const newProducts = b.lines.filter((l) => l.product === 'new').length;
    const costs = b.lines.filter((l) => l.update_cost).length;
    const unmatched = b.lines.filter((l) => !l.product).length;
    const msg = [
      b.new_supplier ? `add the supplier “${inv.supplier_name}”` : null,
      newProducts ? `add ${newProducts} new product${newProducts === 1 ? '' : 's'}` : null,
      costs ? `update the cost of ${costs} product${costs === 1 ? '' : 's'}` : null,
    ].filter(Boolean);
    if (!(await confirmDialog(`Confirm this invoice${msg.length ? ` and ${msg.join(', ')}` : ''}?${unmatched ? ` ${unmatched} line${unmatched === 1 ? ' isn’t' : 's aren’t'} matched to a product and will be kept as ${unmatched === 1 ? 'it is' : 'they are'}.` : ''}`, { confirmLabel: 'Confirm invoice', title: 'Confirm invoice' }))) return;
    busy(true);
    try {
      const r = await api(`/invoices/${invId}/confirm`, { method: 'POST', body: b });
      const parts = [
        r.costs_updated ? `${r.costs_updated} cost${r.costs_updated === 1 ? '' : 's'} updated` : null,
        r.products_added ? `${r.products_added} product${r.products_added === 1 ? '' : 's'} added` : null,
        r.supplier_added ? 'supplier added' : null,
      ].filter(Boolean);
      toast(`Invoice confirmed${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
      navigate('invoices');
    } catch (err) { showError(err); busy(false); }
  });
  el.querySelector('#delete').addEventListener('click', () => remove());

  async function remove() {
    if (!(await confirmDialog('Delete this invoice and its uploaded file? Nothing it already changed (costs, products) is undone.', { confirmLabel: 'Delete', title: 'Delete invoice' }))) return;
    try {
      await api(`/invoices/${invId}`, { method: 'DELETE' });
      toast('Invoice deleted');
      navigate('invoices');
    } catch (err) { showError(err); }
  }
}
