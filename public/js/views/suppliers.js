import { api, esc, field, input, money, openModal, showError, textarea, toast } from '../lib.js';
import { DAY_NAMES, scheduleSummary } from '../delivery.js';

// Stock & Ordering → Suppliers: the list, and each supplier's page with four tabs – General (address and contact
// details), Ordering (where orders go, the minimum, delivery days and cut-offs, and whether they're used for
// ordering), Accounting and payments (Xero contact, payment terms, and the references that tell Atlas which site an
// invoice is for) and Products.

const TABS = [['general', 'General'], ['ordering', 'Ordering'], ['accounting', 'Accounting & payments'], ['products', 'Products']];
const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

export async function renderList(ctx) {
  const { el, state, stale, navigate, query } = ctx;
  const canEdit = state.can('setup.products');
  const rows = await api('/suppliers');
  if (stale()) return;
  const showAll = query.show === 'all';
  const shown = showAll ? rows : rows.filter((s) => s.active);

  el.innerHTML = `
    <div class="page-head"><h1>Suppliers</h1>
      <div class="actions">${canEdit ? '<button class="btn btn-primary" id="sup-add">+ Add supplier</button>' : ''}</div></div>
    <div class="list-tools"><input type="search" id="sup-search" placeholder="Search suppliers…" aria-label="Search" autocomplete="off">
      <a class="small" href="#/admin/suppliers${showAll ? '' : '?show=all'}">${showAll ? 'Hide inactive suppliers' : 'Show inactive suppliers too'}</a></div>
    <section class="card">
      ${shown.length ? `<div class="table-wrap"><table class="sup-table">
        <thead><tr><th>Supplier</th><th>Contact</th><th>Deliveries</th><th class="num">Min order</th><th>Ordering</th><th>Xero</th><th class="num">Products</th></tr></thead>
        <tbody>${shown.map((s) => `<tr data-sup="${s.id}" class="${s.active ? '' : 'is-off'}" tabindex="0">
          <td><a href="#/admin/suppliers/${s.id}"><strong>${esc(s.name)}</strong></a>${s.active ? '' : ' <span class="badge">Inactive</span>'}</td>
          <td>${esc(s.contact_name ?? '')}${s.phone ? `<small class="muted">${esc(s.phone)}</small>` : ''}</td>
          <td>${esc(scheduleSummary(s.delivery_schedule))}</td>
          <td class="num">${s.min_order ? money(s.min_order) : '–'}</td>
          <td>${s.orders_enabled ? '<span class="tone-good">✓ Yes</span>' : '<span class="muted">No</span>'}</td>
          <td>${s.xero_contact_id ? '<span class="tone-good" title="Linked to a Xero contact">✓ Linked</span>' : '<span class="muted">–</span>'}</td>
          <td class="num">${s.product_count}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No suppliers yet.</div>'}
    </section>`;

  el.querySelectorAll('tr[data-sup]').forEach((tr) => {
    const go = () => navigate(`admin/suppliers/${tr.dataset.sup}`);
    tr.addEventListener('click', (e) => { if (!e.target.closest('a')) go(); });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
  el.querySelector('#sup-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    el.querySelectorAll('tr[data-sup]').forEach((tr) => { tr.hidden = !!q && !tr.textContent.toLowerCase().includes(q); });
  });
  el.querySelector('#sup-add')?.addEventListener('click', () => openModal({
    title: 'Add supplier',
    body: field('Name', input('name', '', 'required maxlength="100" placeholder="e.g. Valley Dairy"')),
    submitLabel: 'Add and set up',
    onSubmit: async (v) => {
      const s = await api('/suppliers', { method: 'POST', body: { name: v.name } });
      toast(`${s.name} added – fill in their details`);
      navigate(`admin/suppliers/${s.id}`);
    },
  }));
}

export async function renderSupplier(ctx) {
  const { el, state, params, query, stale, rerender } = ctx;
  const canEdit = state.can('setup.products');
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : 'general';
  const [s, products, xero] = await Promise.all([
    api(`/suppliers/${params[0]}`),
    tab === 'products' ? api('/products') : null,
    tab === 'accounting' ? api('/xero').catch(() => null) : null,
  ]);
  if (stale()) return;
  const dis = canEdit ? '' : 'disabled';
  const sites = state.locations.filter((l) => l.active);

  const general = () => `<form class="card sup-form" data-form>
      <div class="row">${field('Name', input('name', s.name, `required maxlength="100" ${dis}`))}${field('Contact name', input('contact_name', s.contact_name, `maxlength="100" ${dis}`))}</div>
      <div class="row">${field('Email', input('email', s.email, `maxlength="200" ${dis}`), { hint: 'General enquiries' })}${field('Phone', input('phone', s.phone, `type="tel" maxlength="50" ${dis}`))}</div>
      ${field('Address', textarea('address', s.address, `rows="3" maxlength="500" ${dis}`))}
      ${field('Notes', textarea('notes', s.notes, `rows="3" maxlength="2000" ${dis}`))}
      <label class="check-row"><input type="checkbox" name="active" ${s.active ? 'checked' : ''} ${dis}><span>Active – untick if you no longer use this supplier</span></label>
      ${canEdit ? '<p><button class="btn btn-primary">Save</button></p>' : ''}
    </form>`;

  const byDay = new Map((s.delivery_schedule ?? []).map((d) => [d.day, d]));
  const dayOpts = (chosen) => DAY_NAMES.map((n, i) => `<option value="${i + 1}" ${i + 1 === chosen ? 'selected' : ''}>${n}</option>`).join('');
  const timeOpts = (chosen) => TIMES.concat(chosen && !TIMES.includes(chosen) ? [chosen] : []).map((t) => `<option ${t === chosen ? 'selected' : ''}>${t}</option>`).join('');
  const ordering = () => `<form class="card sup-form" data-form>
      <label class="check-row sup-switch"><input type="checkbox" name="orders_enabled" ${s.orders_enabled ? 'checked' : ''} ${dis}>
        <span><strong>Set up for ordering</strong><small class="muted">Untick to leave them out of New order (e.g. a supplier you only get invoices from)</small></span></label>
      <div class="row">${field('Order email address', input('order_email', s.order_email, `maxlength="1000" placeholder="orders@supplier.co.uk" ${dis}`), { hint: 'Orders are emailed here (their general email if blank)' })}
        ${field('Minimum order (£)', input('min_order', s.min_order ?? 0, `type="number" min="0" step="0.01" ${dis}`))}</div>
      ${field('CC email addresses', input('cc_emails', s.cc_emails, `maxlength="1000" placeholder="e.g. rep@supplier.co.uk, accounts@yourcafe.co.uk" ${dis}`), { hint: 'Copied in on every order – separate them with commas' })}
      <h3 class="sup-sub">Delivery days and cut-offs</h3>
      <p class="muted small">Tick the days they deliver, and when the order has to be in for each.</p>
      ${s.order_days && !(s.delivery_schedule ?? []).length ? `<p class="notice small">You’d noted their order days as “${esc(s.order_days)}” – tick the matching days below.</p>` : ''}
      <div class="table-wrap"><table class="sup-days">
        <thead><tr><th>Delivers</th><th>Delivery day</th><th>Order cut-off</th><th></th></tr></thead>
        <tbody>${DAY_NAMES.map((name, i) => {
          const day = i + 1;
          const d = byDay.get(day);
          const off = !d ? 'disabled' : '';
          return `<tr data-day="${day}" class="${d ? '' : 'is-off'}">
            <td><input type="checkbox" data-deliver ${d ? 'checked' : ''} ${dis} aria-label="Delivers on ${name}"></td>
            <td><strong>${name}</strong></td>
            <td><select data-cutoff-day ${off} ${dis} aria-label="Cut-off day for ${name}">${dayOpts(d?.cutoff_day ?? (day === 1 ? 7 : day - 1))}</select></td>
            <td><select data-cutoff-time ${off} ${dis} aria-label="Cut-off time for ${name}">${timeOpts(d?.cutoff_time ?? '22:00')}</select></td></tr>`;
        }).join('')}</tbody></table></div>
      ${canEdit ? '<p class="sup-actions"><button type="button" class="btn btn-small" data-copy-first>Copy the first time to every day</button><button class="btn btn-primary">Save</button></p>' : ''}
    </form>`;

  const refRows = (list) => list.map((r) => `<tr>
      <td><select data-ref-site ${dis} aria-label="Site">${sites.map((l) => `<option value="${l.id}" ${l.id === r.location_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></td>
      <td><input data-ref value="${esc(r.reference ?? '')}" maxlength="100" placeholder="e.g. HB1042" ${dis} aria-label="Reference"></td>
      <td>${canEdit ? '<button type="button" class="btn btn-small btn-ghost" data-ref-del title="Remove">✕</button>' : ''}</td></tr>`).join('');
  const accounting = () => `<form class="card sup-form" data-form>
      <h3 class="sup-sub">Xero</h3>
      <div class="sup-xero" id="sup-xero">${s.xero_contact_id
        ? `<p>✓ Linked to <strong>${esc(s.xero_contact_name ?? 'a Xero contact')}</strong> ${canEdit ? '<button type="button" class="btn btn-small btn-ghost" data-unlink>Unlink</button>' : ''}</p>`
        : `<p class="muted small">Not linked yet – the first bill sent to Xero links them to the contact with the same name (or adds one).</p>`}
        ${canEdit ? (xero?.connected ? `<div class="sup-xero-search"><input type="search" id="xero-q" placeholder="Search your Xero contacts…" value="${esc(s.xero_contact_id ? '' : s.name)}" aria-label="Search Xero contacts">
          <button type="button" class="btn btn-small" id="xero-find">Search</button></div><ul class="sup-xero-results" id="xero-results"></ul>`
          : '<p class="muted small">Connect Xero (Setup → Xero) to pick the contact here.</p>') : ''}</div>
      ${field('Payment terms (days)', input('payment_terms_days', s.payment_terms_days, `type="number" min="0" max="365" step="1" placeholder="e.g. 30" ${dis}`),
        { hint: 'Used for the due date in Xero when the invoice doesn’t show one' })}
      <h3 class="sup-sub">References for each site</h3>
      <p class="muted small">What ${esc(s.name)} prints on each site’s invoices – usually your account or customer number with them. When an invoice arrives with one of these on it, it goes to that site automatically.</p>
      <div class="table-wrap"><table class="sup-refs"><thead><tr><th>Site</th><th>Reference on their invoices</th><th></th></tr></thead>
        <tbody id="ref-rows">${refRows(s.site_refs.length ? s.site_refs : [])}</tbody></table></div>
      ${canEdit ? '<p class="sup-actions"><button type="button" class="btn btn-small" id="ref-add">+ Add a reference</button><button class="btn btn-primary">Save</button></p>' : ''}
    </form>`;

  const productsTab = () => {
    const mine = products.filter((p) => p.supplier_id === s.id);
    return `<section class="card">
      ${mine.length ? `<div class="table-wrap"><table><thead><tr><th>Product</th><th>Category</th><th>Unit</th><th class="num">Cost</th><th>Active</th></tr></thead>
        <tbody>${mine.map((p) => `<tr class="${p.active ? '' : 'is-off'}"><td><strong>${esc(p.name)}</strong>${p.sku ? `<small class="muted">${esc(p.sku)}</small>` : ''}</td>
          <td>${esc(p.category ?? '')}</td><td>${esc(p.unit)}</td><td class="num">${money(p.unit_cost)}</td><td>${p.active ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">No products from this supplier yet.</div>'}
      <p class="small"><a href="#/admin/products?q=${encodeURIComponent(s.name)}">Add or change products on the Products page →</a></p>
    </section>`;
  };

  el.innerHTML = `
    <p class="small"><a href="#/admin/suppliers">← Suppliers</a></p>
    <div class="page-head"><h1>${esc(s.name)}${s.active ? '' : ' <span class="badge">Inactive</span>'}</h1></div>
    <nav class="tabs">${TABS.map(([k, label]) => `<a href="#/admin/suppliers/${s.id}?tab=${k}" class="${k === tab ? 'active' : ''}">${label}</a>`).join('')}</nav>
    ${tab === 'general' ? general() : tab === 'ordering' ? ordering() : tab === 'accounting' ? accounting() : productsTab()}`;

  const form = el.querySelector('[data-form]');
  if (!form || !canEdit) return;
  const save = async (body) => {
    try {
      await api(`/suppliers/${s.id}`, { method: 'PUT', body });
      toast('Saved');
      rerender();
    } catch (err) { showError(err); }
  };

  if (tab === 'general') {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = form.elements;
      save({ name: f.name.value, contact_name: f.contact_name.value, email: f.email.value, phone: f.phone.value, address: f.address.value, notes: f.notes.value, active: f.active.checked });
    });
  }

  if (tab === 'ordering') {
    form.querySelectorAll('tr[data-day]').forEach((tr) => tr.querySelector('[data-deliver]').addEventListener('change', (e) => {
      tr.classList.toggle('is-off', !e.target.checked);
      tr.querySelectorAll('select').forEach((x) => { x.disabled = !e.target.checked; });
    }));
    form.querySelector('[data-copy-first]').addEventListener('click', () => {
      const rows = [...form.querySelectorAll('tr[data-day]')].filter((tr) => tr.querySelector('[data-deliver]').checked);
      if (!rows.length) return;
      const t = rows[0].querySelector('[data-cutoff-time]').value;
      rows.forEach((tr) => { tr.querySelector('[data-cutoff-time]').value = t; });
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = form.elements;
      const schedule = [...form.querySelectorAll('tr[data-day]')].filter((tr) => tr.querySelector('[data-deliver]').checked).map((tr) => ({
        day: Number(tr.dataset.day), cutoff_day: Number(tr.querySelector('[data-cutoff-day]').value), cutoff_time: tr.querySelector('[data-cutoff-time]').value,
      }));
      save({ orders_enabled: f.orders_enabled.checked, order_email: f.order_email.value, cc_emails: f.cc_emails.value, min_order: f.min_order.value, delivery_schedule: schedule });
    });
  }

  if (tab === 'accounting') {
    const body = form.querySelector('#ref-rows');
    const wireRows = () => body.querySelectorAll('[data-ref-del]').forEach((b) => { b.onclick = () => b.closest('tr').remove(); });
    wireRows();
    form.querySelector('#ref-add').addEventListener('click', () => {
      body.insertAdjacentHTML('beforeend', refRows([{ location_id: sites[0]?.id, reference: '' }]));
      wireRows();
      body.querySelector('tr:last-child [data-ref]').focus();
    });
    form.querySelector('[data-unlink]')?.addEventListener('click', () => save({ xero_contact_id: null, xero_contact_name: null }));
    const find = async () => {
      const list = form.querySelector('#xero-results');
      list.innerHTML = '<li class="muted small">Searching…</li>';
      try {
        const found = await api(`/xero/contacts?q=${encodeURIComponent(form.querySelector('#xero-q').value)}`);
        list.innerHTML = found.length ? found.map((c, i) => `<li><span><strong>${esc(c.name)}</strong>${c.email ? ` <small class="muted">${esc(c.email)}</small>` : ''}</span>
          <button type="button" class="btn btn-small" data-pick-contact="${i}">Link</button></li>`).join('') : '<li class="muted small">No contacts found in Xero.</li>';
        list.querySelectorAll('[data-pick-contact]').forEach((b) => b.addEventListener('click', () => {
          const c = found[Number(b.dataset.pickContact)];
          save({ xero_contact_id: c.id, xero_contact_name: c.name });
        }));
      } catch (err) { list.innerHTML = `<li class="notice">${esc(err.message)}</li>`; }
    };
    form.querySelector('#xero-find')?.addEventListener('click', find);
    form.querySelector('#xero-q')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const refs = [...body.querySelectorAll('tr')].map((tr) => ({ location_id: Number(tr.querySelector('[data-ref-site]').value), reference: tr.querySelector('[data-ref]').value.trim() }))
        .filter((r) => r.reference);
      try {
        await api(`/suppliers/${s.id}`, { method: 'PUT', body: { payment_terms_days: form.elements.payment_terms_days.value } });
        await api(`/suppliers/${s.id}/site-refs`, { method: 'PUT', body: { refs } });
        toast('Saved');
        rerender();
      } catch (err) { showError(err); }
    });
  }
}
