import { loadLocations } from '../app.js';
import { api, esc, field, fmtDateTime, input, money, openModal, qs, select, statusBadge, textarea, toast } from '../lib.js';

const yesNo = (v) => (v ? 'Yes' : 'No');
const activeBox = (v) => field('Active', `<input type="checkbox" name="active" ${v === undefined || v ? 'checked' : ''}>`, { className: 'field-inline' });

// A simple list page: table of rows, "Add" button and click-to-edit modal.
function listPage(ctx, { title, rows, columns, canEdit = true, addLabel, form, save, extraActions = '' }) {
  ctx.el.innerHTML = `
    <div class="page-head">
      <h1>${esc(title)}</h1>
      <div class="actions">${extraActions}${canEdit && addLabel ? `<button class="btn btn-primary" id="add">+ ${esc(addLabel)}</button>` : ''}</div>
    </div>
    <section class="card">
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr>${columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r, i) => `<tr class="${canEdit ? 'clickable' : ''} ${r.active === 0 ? 'inactive' : ''}" data-i="${i}">
          ${columns.map((c) => `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(r) : esc(c.value ? c.value(r) : r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">Nothing here yet.</div>'}
    </section>`;
  if (!canEdit) return;
  const open = (row) => openModal({
    title: row ? `Edit ${row.name ?? row.title}` : addLabel,
    body: form(row ?? {}),
    wide: true,
    onSubmit: async (v) => {
      await save(v, row);
      toast('Saved');
      ctx.rerender();
    },
  });
  ctx.el.querySelector('#add')?.addEventListener('click', () => open(null));
  ctx.el.querySelectorAll('tr[data-i]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;
    open(rows[Number(tr.dataset.i)]);
  }));
}

export async function renderStaff(ctx) {
  const { state } = ctx;
  const scope = state.isAdmin ? (ctx.query.scope ?? 'site') : 'site';
  const rows = await api(`/users${qs({ location_id: scope === 'all' ? undefined : state.locationId })}`);
  if (ctx.stale()) return;
  const locOptions = state.locations.map((l) => [l.id, l.name]);
  listPage(ctx, {
    title: `Staff · ${scope === 'all' ? 'All sites' : state.location?.name ?? ''}`,
    rows,
    addLabel: 'Add staff member',
    extraActions: state.isAdmin
      ? `<a class="btn" href="#/admin/staff${scope === 'all' ? '' : '?scope=all'}">${scope === 'all' ? 'This site only' : 'Show all sites'}</a>`
      : '',
    columns: [
      { label: 'Name', key: 'name' },
      { label: 'Email', key: 'email' },
      { label: 'Role', value: (r) => r.role[0].toUpperCase() + r.role.slice(1) },
      { label: 'Position', key: 'position' },
      { label: 'Site', value: (r) => r.location_name ?? 'All (admin)' },
      { label: 'Hourly rate', num: true, value: (r) => money(r.hourly_rate) },
      { label: 'Active', value: (r) => yesNo(r.active) },
    ],
    form: (u) => `
      <div class="row">${field('Name', input('name', u.name, 'required'))}${field('Email (used to sign in)', input('email', u.email, 'type="email" required'))}</div>
      <div class="row">
        ${field('Role', select('role', state.isAdmin ? [['staff', 'Staff'], ['manager', 'Manager'], ['admin', 'Admin (all sites)']] : [['staff', 'Staff']], u.role ?? 'staff'))}
        ${field('Home site', select('location_id', state.isAdmin ? [['', '—'], ...locOptions] : locOptions.filter(([id]) => id === state.user.location_id), u.location_id ?? state.locationId))}
      </div>
      <div class="row">
        ${field('Position', input('position', u.position, 'placeholder="e.g. Barista"'))}
        ${field('Hourly rate (£)', input('hourly_rate', u.hourly_rate, 'type="number" min="0" step="0.01"'))}
      </div>
      ${field(u.id ? 'New password (leave blank to keep)' : 'Password', input('password', '', `type="password" minlength="8" autocomplete="new-password" ${u.id ? '' : 'required'}`), { hint: 'At least 8 characters' })}
      ${activeBox(u.active)}`,
    save: (v, row) => (row
      ? api(`/users/${row.id}`, { method: 'PUT', body: v })
      : api('/users', { method: 'POST', body: v })),
  });
}

export async function renderLocations(ctx) {
  const rows = await api('/locations');
  if (ctx.stale()) return;
  listPage(ctx, {
    title: 'Locations',
    rows,
    addLabel: 'Add location',
    columns: [
      { label: 'Name', key: 'name' },
      { label: 'Address', key: 'address' },
      { label: 'Phone', key: 'phone' },
      { label: 'Active', value: (r) => yesNo(r.active) },
    ],
    form: (l) => `${field('Name', input('name', l.name, 'required'))}${field('Address', textarea('address', l.address))}${field('Phone', input('phone', l.phone))}${activeBox(l.active)}`,
    save: async (v, row) => {
      if (row) await api(`/locations/${row.id}`, { method: 'PUT', body: v });
      else await api('/locations', { method: 'POST', body: v });
      await loadLocations();
    },
  });
}

export async function renderSuppliers(ctx) {
  const rows = await api('/suppliers');
  if (ctx.stale()) return;
  listPage(ctx, {
    title: 'Suppliers',
    rows,
    canEdit: ctx.state.isAdmin,
    addLabel: 'Add supplier',
    columns: [
      { label: 'Name', key: 'name' },
      { label: 'Contact', key: 'contact_name' },
      { label: 'Email', html: (r) => (r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '') },
      { label: 'Phone', html: (r) => (r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : '') },
      { label: 'Order days', key: 'order_days' },
      { label: 'Lead time', value: (r) => `${r.lead_time_days} day(s)` },
      { label: 'Min order', num: true, value: (r) => money(r.min_order) },
      { label: 'Products', num: true, key: 'product_count' },
    ],
    form: (s) => `
      <div class="row">${field('Name', input('name', s.name, 'required'))}${field('Contact name', input('contact_name', s.contact_name))}</div>
      <div class="row">${field('Order email', input('email', s.email, 'type="email"'))}${field('Phone', input('phone', s.phone))}</div>
      <div class="row">
        ${field('Order days / cut-off', input('order_days', s.order_days, 'placeholder="e.g. Mon, Thu by 2pm"'))}
        ${field('Lead time (days)', input('lead_time_days', s.lead_time_days ?? 1, 'type="number" min="0"'))}
        ${field('Minimum order (£)', input('min_order', s.min_order ?? 0, 'type="number" min="0" step="0.01"'))}
      </div>
      ${field('Notes', textarea('notes', s.notes))}${activeBox(s.active)}`,
    save: (v, row) => (row ? api(`/suppliers/${row.id}`, { method: 'PUT', body: v }) : api('/suppliers', { method: 'POST', body: v })),
  });
}

export async function renderProducts(ctx) {
  const { state } = ctx;
  const [rows, suppliers] = await Promise.all([api('/products'), api('/suppliers')]);
  if (ctx.stale()) return;
  listPage(ctx, {
    title: 'Products',
    rows,
    canEdit: state.isAdmin,
    addLabel: 'Add product',
    columns: [
      { label: 'Name', key: 'name' },
      { label: 'Category', key: 'category' },
      { label: 'Unit', key: 'unit' },
      { label: 'Supplier', key: 'supplier_name' },
      { label: 'Unit cost', num: true, value: (r) => money(r.unit_cost) },
      { label: 'Default par', num: true, key: 'par_level' },
      { label: '', html: (r) => `<button class="btn btn-small" data-pars="${r.id}">Site pars</button>` },
    ],
    form: (p) => `
      <div class="row">${field('Name', input('name', p.name, 'required'))}${field('SKU / supplier code', input('sku', p.sku))}</div>
      <div class="row">
        ${field('Category', input('category', p.category, 'list="categories"'))}
        ${field('Unit', input('unit', p.unit ?? 'each', 'required placeholder="each, case, kg…"'))}
      </div>
      <datalist id="categories">${[...new Set(rows.map((r) => r.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="row">
        ${field('Supplier', select('supplier_id', [['', '—'], ...suppliers.map((s) => [s.id, s.name])], p.supplier_id))}
        ${field('Unit cost (£)', input('unit_cost', p.unit_cost ?? 0, 'type="number" min="0" step="0.01"'))}
        ${field('Default par level', input('par_level', p.par_level ?? 0, 'type="number" min="0" step="any"'), { hint: 'Target stock to hold at each site' })}
      </div>
      ${activeBox(p.active)}`,
    save: (v, row) => (row ? api(`/products/${row.id}`, { method: 'PUT', body: v }) : api('/products', { method: 'POST', body: v })),
  });

  ctx.el.querySelectorAll('[data-pars]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const { product, pars } = await api(`/products/${b.dataset.pars}/pars`);
    const editable = state.isAdmin ? pars : pars.filter((p) => p.location_id === state.user.location_id);
    openModal({
      title: `Par levels · ${product.name}`,
      body: `<p class="muted">Leave blank to use the default par of ${product.par_level}.</p>
        ${editable.map((p) => field(p.location_name, input(`loc_${p.location_id}`, p.par_level, `type="number" min="0" step="any" placeholder="${product.par_level}"`))).join('')}`,
      onSubmit: async (v) => {
        await api(`/products/${product.id}/pars`, {
          method: 'PUT',
          body: { pars: editable.map((p) => ({ location_id: p.location_id, par_level: v[`loc_${p.location_id}`] })) },
        });
        toast('Par levels saved');
      },
    });
  }));
}

export async function renderSafetyTasks(ctx) {
  const { state } = ctx;
  const rows = await api('/safety/tasks');
  if (ctx.stale()) return;
  const range = (t) => {
    if (!t.requires_reading) return '';
    const u = t.reading_unit ?? '';
    return [t.min_value !== null ? `≥ ${t.min_value}${u}` : '', t.max_value !== null ? `≤ ${t.max_value}${u}` : ''].filter(Boolean).join(', ');
  };
  const locOptions = state.isAdmin
    ? [['', 'All locations'], ...state.locations.map((l) => [l.id, l.name])]
    : state.locations.filter((l) => l.id === state.user.location_id).map((l) => [l.id, l.name]);
  listPage(ctx, {
    title: 'Food safety checks',
    rows,
    addLabel: 'Add check',
    columns: [
      { label: 'Check', key: 'title' },
      { label: 'Category', key: 'category' },
      { label: 'Frequency', value: (r) => (r.frequency === 'daily' ? 'Daily' : 'Weekly') },
      { label: 'Applies to', value: (r) => r.location_name ?? 'All locations' },
      { label: 'Safe range', value: range },
      { label: 'Active', value: (r) => yesNo(r.active) },
    ],
    form: (t) => {
      const locked = t.id && !t.location_id && !state.isAdmin;
      return `
      ${locked ? '<p class="notice">This check is shared by every location and can only be changed by an admin.</p>' : ''}
      ${field('Check', input('title', t.title, 'required'))}
      ${field('Instructions', textarea('description', t.description))}
      <div class="row">
        ${field('Category', input('category', t.category ?? 'General', 'list="task-cats"'))}
        ${field('Frequency', select('frequency', [['daily', 'Daily'], ['weekly', 'Weekly']], t.frequency ?? 'daily'))}
        ${field('Applies to', select('location_id', locOptions, t.location_id ?? (state.isAdmin ? '' : state.user.location_id)))}
      </div>
      <datalist id="task-cats">${[...new Set(rows.map((r) => r.category))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      ${field('Requires a reading (e.g. temperature)', `<input type="checkbox" name="requires_reading" ${t.requires_reading ? 'checked' : ''}>`, { className: 'field-inline' })}
      <div class="row">
        ${field('Unit', input('reading_unit', t.reading_unit ?? '°C'))}
        ${field('Minimum safe value', input('min_value', t.min_value, 'type="number" step="any"'))}
        ${field('Maximum safe value', input('max_value', t.max_value, 'type="number" step="any"'))}
      </div>
      ${field('Sort order', input('sort_order', t.sort_order ?? 0, 'type="number"'))}
      ${activeBox(t.active)}`;
    },
    save: (v, row) => (row ? api(`/safety/tasks/${row.id}`, { method: 'PUT', body: v }) : api('/safety/tasks', { method: 'POST', body: v })),
  });
}

export async function renderAccount(ctx) {
  const { el, state } = ctx;
  el.innerHTML = `
    <div class="page-head"><h1>Your account</h1></div>
    <section class="card narrow">
      <p><strong>${esc(state.user.name)}</strong><br>${esc(state.user.email)}<br>
        <span class="muted">${esc(state.user.role)}${state.location && !state.isAdmin ? ` · ${esc(state.location.name)}` : ''}</span></p>
      <form id="pw">
        <h2>Change password</h2>
        ${field('Current password', input('current_password', '', 'type="password" required autocomplete="current-password"'))}
        ${field('New password', input('new_password', '', 'type="password" minlength="8" required autocomplete="new-password"'))}
        <button class="btn btn-primary" type="submit">Update password</button>
      </form>
    </section>`;
  el.querySelector('#pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/auth/password', { method: 'POST', body: { current_password: f.current_password.value, new_password: f.new_password.value } });
      f.reset();
      toast('Password updated');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

export async function renderSquare(ctx) {
  const { el, state } = ctx;
  const status = await api('/square/status');
  let squareLocations = [];
  let squareError = null;
  if (status.configured) {
    try { squareLocations = await api('/square/locations'); } catch (err) { squareError = err.message; }
  }
  if (ctx.stale()) return;
  const sites = state.locations;
  const unlinked = squareLocations.filter((l) => !l.linked_location);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const monthAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 27 * 86400000).toISOString().slice(0, 10);

  el.innerHTML = `
    <div class="page-head"><h1>Square</h1></div>
    <section class="card">
      <h2>Connection</h2>
      ${status.configured
        ? `<p><span class="badge badge-completed">Connected</span> ${esc(status.environment)} · sales sync automatically every ${status.sync_minutes} minutes</p>
           ${squareError ? `<p class="alert-text">${esc(squareError)}</p>` : ''}`
        : `<p><span class="badge badge-draft">Not connected</span></p>
           <ol class="steps">
             <li>Go to <strong>developer.squareup.com</strong>, sign in with your Square account and create an application (e.g. “Cafe Ops”).</li>
             <li>Switch the app to <strong>Production</strong> and copy the <strong>Production access token</strong>.</li>
             <li>Set it where the app runs: <code>SQUARE_ACCESS_TOKEN=…</code> then restart the app.</li>
           </ol>
           <p class="muted small">The token is only read from the server’s environment and is never shown in or saved by the app. Use <code>SQUARE_ENVIRONMENT=sandbox</code> with a sandbox token to try it with test data.</p>`}
    </section>
    ${status.configured && !squareError ? `
    <section class="card">
      <h2>Link your sites to Square locations</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Site</th><th>Square location</th></tr></thead>
        <tbody>${sites.map((s) => `<tr><td>${esc(s.name)}</td><td>
          <select data-link="${s.id}"><option value="">— Not linked —</option>
            ${squareLocations.map((l) => `<option value="${esc(l.id)}" ${s.square_location_id === l.id ? 'selected' : ''} ${l.linked_location && l.linked_location.id !== s.id ? 'disabled' : ''}>${esc(l.name)}${l.address ? ` · ${esc(l.address)}` : ''}${l.status !== 'ACTIVE' ? ' (inactive)' : ''}</option>`).join('')}
          </select></td></tr>`).join('')}</tbody>
      </table></div>
      ${unlinked.length ? `
        <h3 class="group-title">Square locations not linked to a site</h3>
        <ul class="plain-list">${unlinked.map((l) => `<li><strong>${esc(l.name)}</strong> <span class="muted">${esc(l.address)}</span>
          <button class="btn btn-small" data-import="${esc(l.id)}">Add as new site</button></li>`).join('')}</ul>` : ''}
    </section>
    <section class="card">
      <h2>Import sales</h2>
      <p class="muted">Re-importing a period replaces what was stored for it, so it’s safe to run again (e.g. after refunds).</p>
      <form class="filters" id="sync">
        <input type="date" name="from" value="${monthAgo}" max="${today}"> <span>to</span> <input type="date" name="to" value="${today}" max="${today}">
        <button class="btn btn-primary" type="submit">Import sales</button>
      </form>
    </section>` : ''}
    ${status.history.length ? `
    <section class="card">
      <h2>Recent syncs</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Started</th><th>Period</th><th>Status</th><th class="num">Orders</th><th>By</th><th>Message</th></tr></thead>
        <tbody>${status.history.map((h) => `<tr><td>${fmtDateTime(h.started_at)}</td><td>${esc(h.date_from)} – ${esc(h.date_to)}</td>
          <td>${statusBadge(h.status === 'ok' ? 'completed' : h.status === 'error' ? 'fail' : 'in_progress')}</td>
          <td class="num">${h.orders ?? '–'}</td><td>${esc(h.triggered_by ?? '')}</td><td class="small">${esc(h.message ?? '')}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>` : ''}`;

  el.querySelectorAll('[data-link]').forEach((sel) => sel.addEventListener('change', async () => {
    try {
      await api(`/locations/${sel.dataset.link}/square`, { method: 'PUT', body: { square_location_id: sel.value || null } });
      await loadLocations();
      toast('Link saved');
      ctx.rerender();
    } catch (err) { toast(err.message, 'error'); ctx.rerender(); }
  }));
  el.querySelectorAll('[data-import]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('/square/import-location', { method: 'POST', body: { square_location_id: b.dataset.import } });
      await loadLocations();
      toast('Site added and linked');
      ctx.rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));
  el.querySelector('#sync')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const r = await api('/square/sync', { method: 'POST', body: { from: f.from.value, to: f.to.value } });
      toast(`Imported ${r.orders} order(s) across ${r.days} site-day(s)`);
      ctx.rerender();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Import sales';
    }
  });
}
