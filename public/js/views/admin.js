import { loadLocations } from '../app.js';
import { api, confirmDialog, esc, isDemo, field, fmtDateTime, input, money, openModal, qs, select, statusBadge, textarea, toast } from '../lib.js';

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
    onSubmit: async (v, form) => {
      await save(v, row, form);
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

const ACTION_LABELS = { create: 'Add', update: 'Update', deactivate: 'Deactivate', skip: 'Skip' };

// Preview of importing Square Team members as the staff list, then the import itself.
function openSquareImport(ctx) {
  const { form } = openModal({
    title: 'Import staff from Square',
    wide: true,
    submitLabel: 'Import',
    body: `
      <p class="muted">Everyone in your Square team is added here, or updated if they're already here (matched by email, then name). Their hourly rate comes from their pay in Square. New people’s home site comes from the locations they’re assigned to in Square; people already here keep the home site set on this page.</p>
      <label class="check-row"><input type="checkbox" name="deactivate_others">
        <span><strong>Deactivate staff who aren’t in Square</strong>
        <small>For example the made-up demo staff. They keep their history but can no longer sign in or be put on the rota. You stay active.</small></span></label>
      <div id="team-preview"><div class="loading">Loading your Square team…</div></div>`,
    onSubmit: async (v) => {
      const r = await api('/square/import-staff', { method: 'POST', body: { deactivate_others: !!v.deactivate_others } });
      toast(`Staff imported: ${r.created} added, ${r.updated} updated, ${r.deactivated} deactivated`);
      if (r.need_password.length) {
        setTimeout(() => toast(`New staff need a password before they can sign in: click their name to set one.`), 2700);
      }
      ctx.rerender();
    },
  });
  const preview = form.querySelector('#team-preview');
  const load = async () => {
    preview.innerHTML = '<div class="loading">Loading your Square team…</div>';
    try {
      const rows = await api(`/square/team${qs({ deactivate_others: form.deactivate_others.checked ? 'true' : undefined })}`);
      const order = { create: 0, update: 1, deactivate: 2, skip: 3 };
      rows.sort((a, b) => order[a.action] - order[b.action] || a.name.localeCompare(b.name));
      const n = (a) => rows.filter((r) => r.action === a).length;
      const summary = [[n('create'), 'to add'], [n('update'), 'to update'], [n('deactivate'), 'to deactivate'], [n('skip'), 'skipped']]
        .filter(([c]) => c).map(([c, l]) => `<strong>${c}</strong> ${l}`).join(' · ');
      preview.innerHTML = rows.length ? `<p>${summary}</p><div class="table-wrap"><table>
        <thead><tr><th>Person</th><th>Change</th><th>Site</th><th class="num">Hourly rate</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.action === 'skip' || r.action === 'deactivate' ? 'inactive' : ''}">
          <td>${esc(r.name)}${r.email ? `<small>${esc(r.email)}${r.no_email ? ' · no email in Square' : ''}</small>` : ''}</td>
          <td>${ACTION_LABELS[r.action]}${r.action === 'update' && r.existing && r.existing.name !== r.name ? ` <small>was ${esc(r.existing.name)}</small>` : ''}${r.reason ? ` <small>${esc(r.reason)}</small>` : ''}</td>
          <td>${esc(r.site ?? '')}</td>
          <td class="num">${r.hourly_rate === null ? '' : money(r.hourly_rate)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">Your Square team is empty.</p>';
    } catch (err) {
      preview.innerHTML = `<p class="alert-text">${esc(err.message)}</p>`;
    }
  };
  form.deactivate_others.addEventListener('change', load);
  load();
}

export async function renderStaff(ctx) {
  const { state } = ctx;
  // Admins see every site's staff by default, so moving someone to another home site doesn't hide them.
  const scope = state.multiSite ? (ctx.query.scope ?? 'all') : 'site';
  const [rows, square, perms] = await Promise.all([
    api(`/users${qs({ location_id: scope === 'all' ? undefined : state.locationId })}`),
    state.isAdmin ? api('/square/status') : null,
    api('/permissions'),
  ]);
  if (ctx.stale()) return;
  const locOptions = state.locations.map((l) => [l.id, l.name]);
  // Admin, or a permission set. People who aren't admins can only hand out sets they're allowed to.
  const staffSet = perms.sets.find((s) => s.built_in === 'staff');
  const accessOptions = (u) => {
    const opts = perms.sets.filter((s) => s.assignable || s.id === u.access_set_id).map((s) => [s.id, s.name]);
    return state.isAdmin ? [['admin', 'Admin – everything, every site'], ...opts] : opts;
  };
  const accessValue = (u) => (u.role === 'admin' ? 'admin' : u.access_set_id ?? staffSet?.id ?? '');
  // Sites: every site (the default), or their home site plus the ones ticked. People who only have some sites
  // themselves can only give out those.
  const siteName = (id) => state.locations.find((l) => l.id === id)?.name ?? '';
  const sitesLabel = (u) => {
    if (u.role === 'admin' || u.all_sites) return 'All sites';
    const ids = [...new Set([u.location_id, ...(u.site_ids ?? [])].filter(Boolean))];
    return ids.length === 1 ? siteName(ids[0]) : `${ids.length} sites`;
  };
  const canGiveAll = state.isAdmin || !!state.user.all_sites;
  const sitesField = (u) => {
    const isNew = !u.id;
    const all = u.role === 'admin' || (isNew ? canGiveAll : !!u.all_sites);
    const ticked = new Set([u.location_id, ...(u.site_ids ?? [])]);
    return `<div class="field"><span>Sites they can work with</span>
      ${select('all_sites', [...(canGiveAll || all ? [['1', 'All sites']] : []), ['0', 'Only the sites ticked below']], all ? '1' : '0',
        `onchange="this.closest('form').querySelector('.site-picks').hidden = this.value === '1'"`)}
      <div class="site-picks" ${all ? 'hidden' : ''}>
        ${state.locations.filter((l) => l.active).map((l) => `<label class="check-row"><input type="checkbox" name="site_pick" value="${l.id}" ${ticked.has(l.id) ? 'checked' : ''}><span>${esc(l.name)}</span></label>`).join('')}
        <small>Their home site is always included.</small>
      </div></div>`;
  };
  listPage(ctx, {
    title: `Staff · ${scope === 'all' ? 'All sites' : state.location?.name ?? ''}`,
    rows,
    addLabel: 'Add staff member',
    extraActions: `${state.isAdmin && square?.configured ? '<button class="btn" id="import-square">Import from Square</button>' : ''}
      ${state.multiSite ? `<a class="btn" href="#/admin/staff${scope === 'all' ? '?scope=site' : ''}">${scope === 'all' ? 'This site only' : 'Show all sites'}</a>` : ''}`,
    columns: [
      { label: 'Name', key: 'name' },
      { label: 'Email', key: 'email' },
      { label: 'Access', value: (r) => r.access_name ?? '' },
      { label: 'Sites', value: sitesLabel },
      { label: 'Site', value: (r) => r.location_name ?? 'All (admin)' },
      { label: 'Hourly rate', num: true, value: (r) => money(r.hourly_rate) },
      { label: 'Active', value: (r) => yesNo(r.active) },
    ],
    form: (u) => `
      <div class="row">${field('Name', input('name', u.name, 'required'))}${field('Email (used to sign in)', input('email', u.email, 'type="email" required'))}</div>
      <div class="row">
        ${field('Access', select('permission_set_id', accessOptions(u), accessValue(u)), { hint: state.isAdmin ? 'Set up what each option allows under Setup → Permissions' : '' })}
        ${field('Home site', select('location_id', state.isAdmin ? [['', '—'], ...locOptions] : locOptions, u.location_id ?? state.locationId))}
      </div>
      ${u.role === 'admin' ? '<p class="small muted">Admins can work with every site.</p>' : sitesField(u)}
      <div class="row">
        <input type="hidden" name="position" value="${esc(u.position ?? '')}">
        ${field('Hourly rate (£)', input('hourly_rate', u.hourly_rate, 'type="number" min="0" step="0.01"'))}
      </div>
      ${field(u.id ? 'New password (leave blank to keep)' : 'Password', input('password', '', `type="password" minlength="8" autocomplete="new-password" ${u.id ? '' : 'required'}`), { hint: 'At least 8 characters' })}
      ${activeBox(u.active)}`,
    save: async (v, row, form) => {
      v.site_ids = [...form.querySelectorAll('input[name=site_pick]:checked')].map((i) => Number(i.value));
      delete v.site_pick;
      if (v.all_sites === undefined) delete v.site_ids;
      const saved = row ? await api(`/users/${row.id}`, { method: 'PUT', body: v }) : await api('/users', { method: 'POST', body: v });
      // On a single site's list, say where someone went if their home site changed.
      if (scope !== 'all' && saved.location_id && saved.location_id !== state.locationId) {
        const site = state.locations.find((l) => l.id === saved.location_id)?.name ?? 'another site';
        setTimeout(() => toast(`${saved.name} now works from ${site}, so they're listed there. Use “Show all sites” to see everyone.`), 2600);
      }
    },
  });
  ctx.el.querySelector('#import-square')?.addEventListener('click', () => openSquareImport(ctx));
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
    canEdit: ctx.state.can('setup.products'),
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
  const [rows, suppliers, meta] = await Promise.all([api('/products'), api('/suppliers'), api('/recipes/meta')]);
  const ALLERGEN_LIST = meta.allergens;
  if (ctx.stale()) return;
  listPage(ctx, {
    title: 'Products',
    rows,
    canEdit: state.can('setup.products'),
    addLabel: 'Add product',
    columns: [
      { label: 'Name', key: 'name' },
      { label: 'Category', key: 'category' },
      { label: 'Unit', key: 'unit' },
      { label: 'Supplier', key: 'supplier_name' },
      { label: 'Unit cost', num: true, value: (r) => money(r.unit_cost) },
      { label: 'Default par', num: true, key: 'par_level' },
      { label: 'Recipe unit', value: (r) => (r.units_per_pack && r.units_per_pack !== 1 ? `${r.units_per_pack} ${r.recipe_unit ?? ''} / ${r.unit}` : r.recipe_unit ?? r.unit) },
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
      <div class="row">
        ${field('Recipe unit', input('recipe_unit', p.recipe_unit ?? p.unit ?? '', 'placeholder="ml, g, slice, each"'), { hint: 'How recipes measure it' })}
        ${field('Recipe units per pack', input('units_per_pack', p.units_per_pack ?? 1, 'type="number" min="0.0001" step="any"'), { hint: 'e.g. 4L milk = 4000 (ml)' })}
      </div>
      <div class="field"><span>Allergens</span><div class="allergen-grid">${ALLERGEN_LIST.map(([k, label]) => `
        <label class="check"><input type="checkbox" name="allergen_${k}" ${(p.allergens ?? '').split(',').includes(k) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}</div></div>
      ${activeBox(p.active)}`,
    save: (v, row) => {
      const body = { ...v, allergens: ALLERGEN_LIST.map(([k]) => k).filter((k) => v[`allergen_${k}`]) };
      for (const [k] of ALLERGEN_LIST) delete body[`allergen_${k}`];
      return row ? api(`/products/${row.id}`, { method: 'PUT', body }) : api('/products', { method: 'POST', body });
    },
  });

  ctx.el.querySelectorAll('[data-pars]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const { product, pars } = await api(`/products/${b.dataset.pars}/pars`);
    const mine = new Set(state.locations.map((l) => l.id));
    const editable = state.isAdmin ? pars : pars.filter((p) => mine.has(p.location_id));
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
    : state.locations.filter((l) => l.active).map((l) => [l.id, l.name]);
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
        ${field('Applies to', select('location_id', locOptions, t.location_id ?? (state.isAdmin ? '' : state.locationId)))}
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
        <span class="muted">${esc(state.user.access_name ?? state.user.role)}${state.location && !state.isAdmin ? ` · ${esc(state.location.name)}` : ''}</span></p>
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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "Remove what isn't in Square": deletes sites not linked to Square and staff not in the Square team.
function cleanupSection(c) {
  if (!c.locations.length && !c.staff.length) return '';
  const siteLine = (l) => `<li><strong>${esc(l.name)}</strong> <span class="muted small">${[
    l.shifts && plural(l.shifts, 'rota shift'), l.checks && plural(l.checks, 'safety check'), l.wastage && plural(l.wastage, 'wastage record'), l.orders && plural(l.orders, 'order'),
  ].filter(Boolean).join(', ') || 'no records'}</span></li>`;
  return `
    <section class="card" id="cleanup">
      <h2>Remove what isn’t in Square</h2>
      ${!c.ready ? `<p class="notice">${!c.linked_sites.length ? 'Link your sites to Square locations above first.' : 'Import your staff from Square first (Setup → Staff → Import from Square), so Cafe Ops knows who to keep.'}</p>` : ''}
      <p class="muted">Deletes sites that aren’t linked to a Square location and staff who aren’t in your Square team, such as the made-up demo data, along with their rotas and records. Sites linked to Square (${esc(c.linked_sites.join(', ') || 'none yet')}) and you are always kept. A backup copy of your data is saved first.</p>
      ${c.locations.length ? `
        <label class="check-row"><input type="checkbox" name="remove_locations" ${c.linked_sites.length ? '' : 'disabled'}>
          <span><strong>Remove ${plural(c.locations.length, 'site')} not linked to Square</strong>
          <small>Their rota, food-safety checks, wastage, stock takes, orders and site-specific settings are deleted too.</small></span></label>
        <ul class="plain-list cleanup-list">${c.locations.map(siteLine).join('')}</ul>` : ''}
      ${c.staff.length ? `
        <label class="check-row"><input type="checkbox" name="remove_staff" ${c.team_linked ? '' : 'disabled'}>
          <span><strong>Remove ${plural(c.staff.length, 'staff member')} not in Square</strong>
          <small>Their shifts go too. Records they entered at the sites you keep stay, without their name.</small></span></label>
        <details><summary class="small">Show who</summary><ul class="plain-list cleanup-list">${c.staff.map((u) => `<li>${esc(u.name)} <span class="muted small">${esc(u.email)} · ${esc(u.location ?? 'all sites')}${u.active ? '' : ' · deactivated'}</span></li>`).join('')}</ul></details>` : ''}
      ${c.moves.length ? `<p class="small">Moving to a site you’re keeping: ${c.moves.map((m) => `${esc(m.name)} → ${esc(m.to_location)}`).join(', ')}.</p>` : ''}
      <button class="btn btn-danger" id="run-cleanup" disabled>Remove selected</button>
    </section>`;
}

function wireCleanup(ctx, c) {
  const box = ctx.el.querySelector('#cleanup');
  if (!box) return;
  const sites = box.querySelector('[name=remove_locations]');
  const staff = box.querySelector('[name=remove_staff]');
  const btn = box.querySelector('#run-cleanup');
  const update = () => { btn.disabled = !(sites?.checked || staff?.checked); };
  sites?.addEventListener('change', update);
  staff?.addEventListener('change', update);
  btn.addEventListener('click', async () => {
    const parts = [sites?.checked && plural(c.locations.length, 'site'), staff?.checked && plural(c.staff.length, 'staff member')].filter(Boolean);
    const ok = await confirmDialog(`This permanently deletes ${parts.join(' and ')} and their records. A backup copy of your data is saved first.`, { confirmLabel: 'Delete', title: 'Remove from Cafe Ops?' });
    if (!ok) return;
    btn.disabled = true;
    try {
      const r = await api('/square/cleanup', { method: 'POST', body: { remove_locations: !!sites?.checked, remove_staff: !!staff?.checked } });
      await loadLocations();
      toast(`Removed ${plural(r.locations_removed, 'site')} and ${plural(r.staff_removed, 'staff member')}${r.backup && !isDemo ? `. Backup saved as data\\${r.backup}` : ''}`);
      ctx.rerender();
    } catch (err) {
      toast(err.message, 'error');
      update();
    }
  });
}

export async function renderSquare(ctx) {
  const { el, state } = ctx;
  const [status, cleanup] = await Promise.all([api('/square/status'), api('/square/cleanup')]);
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
        ? `<p><span class="badge badge-completed">Connected</span> ${esc(status.environment)} · sales and clock-ins sync automatically every ${status.sync_minutes} minutes</p>
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
      <h2>Import sales and clock-ins</h2>
      <p class="muted">Imports completed orders and Square Team clock-ins (timecards). Re-importing a period replaces what was stored for it, so it’s safe to run again (e.g. after refunds or edited timecards).</p>
      <form class="filters" id="sync">
        <input type="date" name="from" value="${monthAgo}" max="${today}"> <span>to</span> <input type="date" name="to" value="${today}" max="${today}">
        <button class="btn btn-primary" type="submit">Import sales</button>
      </form>
    </section>` : ''}
    ${status.history.length ? `
    <section class="card">
      <h2>Recent syncs</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Started</th><th>Period</th><th>Status</th><th class="num">Orders</th><th class="num">Clock-ins</th><th>By</th><th>Message</th></tr></thead>
        <tbody>${status.history.map((h) => `<tr><td>${fmtDateTime(h.started_at)}</td><td>${esc(h.date_from)} – ${esc(h.date_to)}</td>
          <td>${statusBadge(h.status === 'ok' ? 'completed' : h.status === 'error' ? 'fail' : 'in_progress')}</td>
          <td class="num">${h.orders ?? '–'}</td><td class="num">${h.timecards ?? '–'}</td><td>${esc(h.triggered_by ?? '')}</td><td class="small">${esc(h.message ?? '')}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>` : ''}
    ${cleanupSection(cleanup)}`;

  wireCleanup(ctx, cleanup);
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

// --- Setup → Permissions: named permission sets, compared side by side ---

export async function renderPermissions(ctx) {
  const { el } = ctx;
  const data = await api('/permissions');
  if (ctx.stale()) return;
  const { areas, sets } = data;

  el.innerHTML = `
    <div class="page-head">
      <h1>Permissions</h1>
      <div class="actions"><button class="btn btn-primary" id="add">+ New permission set</button></div>
    </div>
    <p class="muted">Give each person a permission set on the Staff page. They can do what their set allows, at their home site.
      <strong>Admins</strong> can do everything at every site, so they don’t need a set. Only admins can give someone access to manage staff.</p>
    <section class="card">
      <div class="table-wrap"><table class="perm-matrix">
        <thead><tr><th></th>${sets.map((s) => `<th class="perm-set">
          <button class="link-btn" data-edit="${s.id}">${esc(s.name)}</button>
          <small>${s.people} ${s.people === 1 ? 'person' : 'people'}${s.built_in ? ' · built in' : ''}</small></th>`).join('')}</tr></thead>
        <tbody>${areas.map((a) => `
          <tr class="perm-area-row"><th colspan="${sets.length + 1}">${esc(a.area)}</th></tr>
          ${a.permissions.map((p) => `<tr><th scope="row">${esc(p.label)}</th>${sets.map((s) => (s.permissions.includes(p.key)
            ? '<td class="perm-yes"><span aria-hidden="true">✓</span><span class="sr-only">Yes</span></td>'
            : '<td class="perm-no"><span aria-hidden="true">–</span><span class="sr-only">No</span></td>')).join('')}</tr>`).join('')}`).join('')}
        </tbody>
      </table></div>
      <p class="muted small">Click a set’s name to change it. Changes apply the next time each person opens a page.</p>
    </section>`;

  const open = (set) => {
    const has = new Set(set?.permissions ?? []);
    openModal({
      title: set ? `Edit ${set.name}` : 'New permission set',
      wide: true,
      submitLabel: set ? 'Save' : 'Create',
      danger: set && !set.built_in ? 'Delete set' : null,
      body: `
        <div class="row">${field('Name', input('name', set?.name, 'required maxlength="60" placeholder="e.g. Supervisor"'))}
          ${field('Description', input('description', set?.description, 'maxlength="300" placeholder="Who it’s for"'))}</div>
        <p class="small muted">${set?.built_in ? 'This set is built in: people without a set get it by default. You can change what it allows but not delete it.' : 'Tick what people with this set can do.'}</p>
        <div class="perm-edit">${areas.map((a) => `
          <fieldset><legend>${esc(a.area)}</legend>
            ${a.permissions.map((p) => `<label class="check-row"><input type="checkbox" name="perm" value="${p.key}" ${has.has(p.key) ? 'checked' : ''}><span>${esc(p.label)}</span></label>`).join('')}
          </fieldset>`).join('')}</div>`,
      onSubmit: async (v, form) => {
        const body = { name: v.name, description: v.description, permissions: [...form.querySelectorAll('input[name=perm]:checked')].map((i) => i.value) };
        if (set) await api(`/permission-sets/${set.id}`, { method: 'PUT', body });
        else await api('/permission-sets', { method: 'POST', body });
        toast(set ? 'Permission set saved' : 'Permission set created');
        ctx.rerender();
      },
      onDanger: async () => {
        await api(`/permission-sets/${set.id}`, { method: 'DELETE' });
        toast('Permission set deleted');
        ctx.rerender();
      },
    });
  };
  el.querySelector('#add').addEventListener('click', () => open(null));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => open(sets.find((s) => s.id === Number(b.dataset.edit)))));
}
