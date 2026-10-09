import { loadLocations } from '../app.js';
import { exportProducts, openProductImport } from './product-import.js';
import { installCard, wireInstallCard } from '../install.js';
import { api, confirmDialog, esc, isDemo, field, fmtDate, fmtDateTime, input, money, openModal, qs, select, statusBadge, textarea, toast, siteScope, siteFilter } from '../lib.js';

const yesNo = (v) => (v ? 'Yes' : 'No');
const activeBox = (v) => field('Active', `<input type="checkbox" name="active" ${v === undefined || v ? 'checked' : ''}>`, { className: 'field-inline' });

// A simple list page: table of rows, "Add" button and click-to-edit modal. With search: true, a box that filters
// the rows as you type (remembered while you move around). With bulk: { label, run(rows) }, tick boxes on each
// row and a button to act on the ticked ones.
const searchText = new Map();
function listPage(ctx, { title, rows, columns, canEdit = true, addLabel, form, save, extraActions = '', search = false, bulk = null }) {
  const key = title.split(' · ')[0];
  // A search can be opened from a link (?q=…), e.g. a category's products.
  if (search && ctx.query?.q) searchText.set(key, ctx.query.q);
  const selectable = canEdit && !!bulk && rows.length > 0;
  const cellText = (r) => columns.map((c) => (c.value ? c.value(r) : r[c.key] ?? '')).join(' ').toLowerCase();
  ctx.el.innerHTML = `
    <div class="page-head">
      <h1>${esc(title)}</h1>
      <div class="actions">${extraActions}${canEdit && addLabel ? `<button class="btn btn-primary" id="add">+ ${esc(addLabel)}</button>` : ''}</div>
    </div>
    ${search && rows.length ? `<div class="list-tools">
      <input type="search" id="list-search" placeholder="Search ${esc(key.toLowerCase())}…" aria-label="Search" value="${esc(searchText.get(key) ?? '')}" autocomplete="off">
      <span class="muted small" id="list-count"></span>
      ${selectable ? `<span class="bulk-bar" id="bulk-bar" hidden><strong id="bulk-n"></strong>
        <button class="btn btn-primary btn-small" id="bulk-run">${esc(bulk.label)}</button>
        ${(bulk.more ?? []).map((m, i) => `<button class="btn btn-small" data-bulk-more="${i}">${esc(m.label)}</button>`).join('')}
        <button class="btn btn-ghost btn-small" id="bulk-clear">Clear</button></span>` : ''}
    </div>` : ''}
    <section class="card">
      ${rows.length ? `<div class="table-wrap"><table class="${selectable ? 'selectable' : ''}">
        <thead><tr>${selectable ? '<th class="pick"><input type="checkbox" id="pick-all" aria-label="Select all shown"></th>' : ''}${columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r, i) => `<tr class="${canEdit ? 'clickable' : ''} ${r.active === 0 ? 'inactive' : ''}" data-i="${i}">
          ${selectable ? `<td class="pick"><input type="checkbox" data-pick="${i}" aria-label="Select ${esc(r.name ?? '')}"></td>` : ''}
          ${columns.map((c) => `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(r) : esc(c.value ? c.value(r) : r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div><div class="empty" id="no-match" hidden>Nothing matches your search.</div>` : '<div class="empty">Nothing here yet.</div>'}
    </section>`;
  const el = ctx.el;
  const trs = [...el.querySelectorAll('tr[data-i]')];
  const shown = () => trs.filter((tr) => !tr.hidden);
  const picked = () => [...el.querySelectorAll('[data-pick]:checked')].map((c) => rows[Number(c.dataset.pick)]);
  const refreshBulk = () => {
    if (!selectable) return;
    const n = picked().length;
    el.querySelector('#bulk-bar').hidden = !n;
    el.querySelector('#bulk-n').textContent = `${n} selected`;
    const visible = shown().map((tr) => tr.querySelector('[data-pick]'));
    const all = el.querySelector('#pick-all');
    all.checked = visible.length > 0 && visible.every((c) => c.checked);
    all.indeterminate = !all.checked && visible.some((c) => c.checked);
  };
  const box = el.querySelector('#list-search');
  const filter = () => {
    const words = (box?.value ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    trs.forEach((tr) => {
      const text = cellText(rows[Number(tr.dataset.i)]);
      tr.hidden = !words.every((w) => text.includes(w));
    });
    const n = shown().length;
    const count = el.querySelector('#list-count');
    if (count) count.textContent = words.length ? `${n} of ${rows.length}` : `${rows.length}`;
    const none = el.querySelector('#no-match');
    if (none) none.hidden = n > 0;
    refreshBulk();
  };
  box?.addEventListener('input', () => { searchText.set(key, box.value); filter(); });
  if (box) filter();
  if (!canEdit) return;
  if (selectable) {
    el.querySelectorAll('[data-pick]').forEach((c) => c.addEventListener('change', refreshBulk));
    el.querySelector('#pick-all').addEventListener('change', (e) => {
      shown().forEach((tr) => { tr.querySelector('[data-pick]').checked = e.target.checked; });
      refreshBulk();
    });
    el.querySelector('#bulk-clear').addEventListener('click', () => { el.querySelectorAll('[data-pick]').forEach((c) => { c.checked = false; }); refreshBulk(); });
    el.querySelector('#bulk-run').addEventListener('click', () => bulk.run(picked()));
    el.querySelectorAll('[data-bulk-more]').forEach((b) => b.addEventListener('click', () => bulk.more[Number(b.dataset.bulkMore)].run(picked())));
  }
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
  el.querySelector('#add')?.addEventListener('click', () => open(null));
  trs.forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, .pick')) return;
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
        setTimeout(() => toast('New staff need an invite before they can sign in: tick them and choose “Invite selected”.'), 2700);
      }
      ctx.rerender();
    },
  });
  const preview = form.querySelector('#team-preview');
  const load = async () => {
    preview.innerHTML = '<div class="loading">Loading your Square team…</div>';
    try {
      const rows = await api(`/square/team${qs({ deactivate_others: form.deactivate_others.checked ? 'true' : undefined })}`);
      // Updates that change nothing are shown as "No change", after the ones that do.
      for (const r of rows) if (r.action === 'update' && !r.changes?.length) r.action = 'same';
      const order = { create: 0, update: 1, deactivate: 2, same: 3, skip: 4 };
      rows.sort((a, b) => order[a.action] - order[b.action] || a.name.localeCompare(b.name));
      const n = (a) => rows.filter((r) => r.action === a).length;
      const summary = [[n('create'), 'to add'], [n('update'), 'to update'], [n('deactivate'), 'to deactivate'], [n('same'), 'no change'], [n('skip'), 'skipped']]
        .filter(([c]) => c).map(([c, l]) => `<strong>${c}</strong> ${l}`).join(' · ');
      preview.innerHTML = rows.length ? `<p>${summary}</p><div class="table-wrap"><table>
        <thead><tr><th>Person</th><th>Change</th><th>What changes</th><th>Site</th><th class="num">Hourly rate</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.action === 'skip' || r.action === 'deactivate' || r.action === 'same' ? 'inactive' : ''}">
          <td>${esc(r.name)}${r.email ? `<small>${esc(r.email)}${r.no_email ? ' · no email in Square' : ''}</small>` : ''}</td>
          <td>${r.action === 'same' ? 'No change' : ACTION_LABELS[r.action]}</td>
          <td class="small">${r.action === 'update' ? `<ul class="import-changes">${r.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`
            : r.action === 'create' ? 'New in Atlas' : r.reason ? esc(r.reason) : r.action === 'deactivate' ? 'Can no longer sign in or be rota’d' : '<span class="muted">Already up to date</span>'}</td>
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

// Edit selected staff: each change is optional ("leave as it is"); only what's picked is changed for everyone.
function openBulkStaff(ctx, people, { roles, locOptions, access }) {
  const KEEP = '__keep';
  const names = people.map((p) => p.name);
  const { form } = openModal({
    title: `Edit ${people.length} ${people.length === 1 ? 'person' : 'people'}`,
    submitLabel: 'Apply changes',
    body: `
      <p class="small muted">${esc(names.slice(0, 8).join(', '))}${names.length > 8 ? ` and ${names.length - 8} more` : ''}</p>
      <p class="small">Only the things you change here are updated – everything else stays as it is for each person.</p>
      <div class="row">
        <label class="field"><span>Role</span>
          <select name="role_pick">
            <option value="${KEEP}">— Leave as it is —</option>
            ${roles.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}
            <option value="__new">✎ New role…</option>
            <option value="">No role</option>
          </select>
          <input name="role_new" placeholder="Type the new role" maxlength="50" hidden>
        </label>
        ${field('Home site', select('location_id', [[KEEP, '— Leave as it is —'], ...locOptions], KEEP))}
      </div>
      <div class="row">
        ${field('Access', select('permission_set_id', [[KEEP, '— Leave as it is —'], ...access], KEEP))}
        ${field('Hourly rate (£)', input('hourly_rate', '', 'type="number" min="0" step="0.01" placeholder="Leave as it is"'))}
        ${field('Active', select('active', [[KEEP, '— Leave as it is —'], ['1', 'Active'], ['0', 'Deactivated (can’t sign in or be rostered)']], KEEP))}
      </div>`,
    onSubmit: async (v) => {
      const changes = {};
      if (v.role_pick !== KEEP) changes.rota_group = v.role_pick === '__new' ? (v.role_new ?? '').trim() : v.role_pick || null;
      if (v.role_pick === '__new' && !changes.rota_group) throw new Error('Type the new role');
      if (v.location_id !== KEEP) changes.location_id = Number(v.location_id) || null;
      if (v.permission_set_id !== KEEP) changes.permission_set_id = v.permission_set_id;
      if (v.hourly_rate !== null && v.hourly_rate !== '') changes.hourly_rate = Number(v.hourly_rate);
      if (v.active !== KEEP) changes.active = v.active === '1';
      if (!Object.keys(changes).length) throw new Error('Choose at least one thing to change');
      const r = await api('/users/bulk', { method: 'POST', body: { ids: people.map((p) => p.id), changes } });
      toast(`Updated ${r.updated} ${r.updated === 1 ? 'person' : 'people'}${r.square_updated ? ` – ${r.square_updated} also updated in Square` : ''}`);
      if (r.square_errors?.length) setTimeout(() => toast(`Not updated in Square: ${r.square_errors.join('; ')}`, 'error'), 2600);
      ctx.rerender();
    },
  });
  const pick = form.querySelector('[name=role_pick]');
  const typed = form.querySelector('[name=role_new]');
  pick.addEventListener('change', () => { typed.hidden = pick.value !== '__new'; if (!typed.hidden) typed.focus(); });
}

// The form for a staff member's details, shared by the Staff page and the rota (where admins can click a name).
function staffEditor(state, rows, perms, settings = {}) {
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
  // Permissions tab: what they can do in each part of Atlas. By default they get whatever their Access allows;
  // unticking "Template permissions" lets each permission be ticked for just this person. People who aren't admins can
  // only tick what they can do themselves (and never managing staff).
  const setPerms = Object.fromEntries(perms.sets.map((s) => [s.id, s.permissions]));
  const grantable = (key) => state.isAdmin || (key !== 'staff.manage' && state.can(key));
  const permsPanel = (u) => {
    const own = !!u.custom_access;
    const has = new Set(u.id ? u.permissions ?? [] : setPerms[staffSet?.id] ?? []);
    const isAdmin = u.role === 'admin';
    return `<div class="perm-panel" data-set-perms="${esc(JSON.stringify(setPerms))}">
      <p class="perm-admin-note notice" ${isAdmin ? '' : 'hidden'}>Admins can do everything at every site, so there’s nothing to tick. Change their Access on the Details tab to choose permissions.</p>
      <div class="perm-body" ${isAdmin ? 'hidden' : ''}>
        <label class="check-row perm-own"><input type="checkbox" name="use_template" ${own ? '' : 'checked'}>
          <span><strong>Template permissions</strong>
          <small>Ticked: they get exactly what their Access template (on the Details tab) allows. Untick to choose their permissions one by one.</small></span></label>
        <div class="perm-areas">${perms.areas.map((a) => `<fieldset class="perm-area">
          <legend><label><input type="checkbox" class="perm-all" ${a.permissions.every((p) => has.has(p.key)) ? 'checked' : ''} ${own ? '' : 'disabled'}> ${esc(a.area)}</label></legend>
          ${a.permissions.map((p) => `<label class="check-row"><input type="checkbox" name="perm" value="${esc(p.key)}" ${has.has(p.key) ? 'checked' : ''}
            ${own && grantable(p.key) ? '' : 'disabled'} ${grantable(p.key) ? '' : 'data-locked'}><span>${esc(p.label)}${grantable(p.key) ? '' : ' <small class="muted">(only an admin can give this)</small>'}</span></label>`).join('')}
        </fieldset>`).join('')}</div>
      </div></div>`;
  };
  // Roles already in use, plus a few common ones, to pick from.
  const rotaGroups = [...new Set([...rows.map((r) => r.rota_group).filter(Boolean), 'Management', 'Front of house', 'Kitchen', 'Bar'])].sort((a, b) => a.localeCompare(b));
  const form = (u) => `
      <div class="staff-tabs" role="tablist">
        <button type="button" role="tab" class="is-on" data-staff-tab="details" aria-selected="true">Details</button>
        <button type="button" role="tab" data-staff-tab="perms" aria-selected="false">Permissions${u.custom_access ? ' <span class="badge badge-sent">Own</span>' : ''}</button>
      </div>
      <div data-staff-panel="details">
      <div class="row">${field('Name', input('name', u.name, 'required'))}${field('Email (used to sign in)', input('email', u.email, 'type="email" required'))}</div>
      <div class="row">
        ${field('Access', select('permission_set_id', accessOptions(u), accessValue(u)), { hint: state.isAdmin ? 'Set up what each option allows under Setup → Permissions' : '' })}
        ${field('Home site', select('location_id', state.isAdmin ? [['', '—'], ...locOptions] : locOptions, u.location_id ?? state.locationId))}
      </div>
      ${u.role === 'admin' ? '<p class="small muted">Admins can work with every site.</p>' : sitesField(u)}
      <div class="row">
        <input type="hidden" name="position" value="${esc(u.position ?? '')}">
        ${field('Role', input('rota_group', u.rota_group, 'list="rota-groups" maxlength="50" placeholder="e.g. Kitchen, Front of house"'), { hint: 'What they do – groups people together on the rota' })}
        ${field('Hourly rate (£)', input('hourly_rate', u.hourly_rate, 'type="number" min="0" step="0.01"'))}
      </div>
      <datalist id="rota-groups">${rotaGroups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
      ${squareBox(u, settings)}
      ${u.id ? inviteBox(u) : ''}
      ${field(u.id ? 'New password (leave blank to keep)' : 'Password (optional)', input('password', '', 'type="password" minlength="8" autocomplete="new-password"'), { hint: u.id ? 'At least 8 characters' : 'Leave blank and send them an invite, so they choose their own' })}
      ${activeBox(u.active)}
      <label class="check-row"><input type="checkbox" name="paid_breaks" ${u.paid_breaks ? 'checked' : ''}>
        <span><strong>Paid breaks</strong><small>They don’t clock their breaks in Square, so no missed or short break warnings show for them on any report</small></span></label>
      </div>
      <div data-staff-panel="perms" hidden>${permsPanel(u)}</div>`;
  const save = async (v, row, formEl) => {
    const template = formEl.querySelector('[name=use_template]');
    delete v.use_template;
    delete v.perm;
    if (template) v.custom_permissions = !template.checked ? [...formEl.querySelectorAll('input[name=perm]:checked')].map((i) => i.value) : null;
    v.site_ids = [...formEl.querySelectorAll('input[name=site_pick]:checked')].map((i) => Number(i.value));
    delete v.site_pick;
    if (v.all_sites === undefined) delete v.site_ids;
    const saved = await (row ? api(`/users/${row.id}`, { method: 'PUT', body: v }) : api('/users', { method: 'POST', body: v }));
    squareToast(saved, settings);
    return saved;
  };
  return { locOptions, accessOptions, rotaGroups, form, save };
}

// The staff form's tabs and Permissions tab (the form is drawn in a pop-up, so these listen on the page).
const permBoxes = (form) => [...form.querySelectorAll('input[name=perm]')];
function showSetPerms(form) {
  const panel = form.querySelector('.perm-panel');
  const access = form.querySelector('[name=permission_set_id]')?.value;
  const isAdmin = access === 'admin';
  panel.querySelector('.perm-admin-note').hidden = !isAdmin;
  panel.querySelector('.perm-body').hidden = isAdmin;
  if (isAdmin || !form.querySelector('[name=use_template]').checked) return;
  const set = new Set(JSON.parse(panel.dataset.setPerms)[access] ?? []);
  for (const b of permBoxes(form)) b.checked = set.has(b.value);
  syncAreaTicks(form);
}
// Each section's own tick shows whether everything in it is ticked.
const syncAreaTicks = (form) => form.querySelectorAll('.perm-area').forEach((f) => {
  f.querySelector('.perm-all').checked = [...f.querySelectorAll('input[name=perm]')].every((b) => b.checked);
});
document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-staff-tab]');
  if (!tab) return;
  const form = tab.closest('form');
  form.querySelectorAll('[data-staff-tab]').forEach((t) => { t.classList.toggle('is-on', t === tab); t.setAttribute('aria-selected', String(t === tab)); });
  form.querySelectorAll('[data-staff-panel]').forEach((p) => { p.hidden = p.dataset.staffPanel !== tab.dataset.staffTab; });
});
document.addEventListener('change', (e) => {
  const form = e.target.closest('form');
  if (!form?.querySelector('.perm-panel')) return;
  if (e.target.name === 'permission_set_id') showSetPerms(form);
  if (e.target.name === 'use_template') {
    const on = !e.target.checked;
    for (const b of permBoxes(form)) b.disabled = !on || b.hasAttribute('data-locked');
    form.querySelectorAll('.perm-all').forEach((b) => { b.disabled = !on; });
    if (!on) showSetPerms(form);
  }
  if (e.target.classList.contains('perm-all')) {
    for (const b of e.target.closest('fieldset').querySelectorAll('input[name=perm]:not([data-locked])')) b.checked = e.target.checked;
  }
  if (e.target.name === 'perm') syncAreaTicks(form);
});

/** Opens a staff member's details to edit, from anywhere (the rota's names, for admins). */
export async function openStaffEditor(ctx, userId) {
  const [rows, perms, settings] = await Promise.all([api('/users'), api('/permissions'), api('/invites/settings')]);
  const person = rows.find((r) => r.id === userId);
  if (!person) { toast('That staff member couldn’t be found', 'error'); return; }
  const editor = staffEditor(ctx.state, rows, perms, settings);
  openModal({
    title: `Edit ${person.name}`,
    body: editor.form(person),
    wide: true,
    onSubmit: async (v, form) => {
      await editor.save(v, person, form);
      toast('Saved');
      ctx.rerender();
    },
  });
}

export async function renderStaff(ctx) {
  const { state } = ctx;
  // Admins see every site's staff by default, so moving someone to another home site doesn't hide them.
  const scope = siteScope(state, ctx.query.scope);
  const [everyone, square, perms, invites] = await Promise.all([
    api(`/users${qs({ location_id: scope === 'all' ? undefined : state.locationId })}`),
    state.isAdmin ? api('/square/status') : null,
    api('/permissions'),
    api('/invites/settings'),
  ]);
  if (ctx.stale()) return;
  const status = JOIN_STATUS.some(([k]) => k === ctx.query.status) ? ctx.query.status : '';
  const rows = status ? everyone.filter((u) => u.active && joinStatus(u).key === status) : everyone;
  const editor = staffEditor(state, everyone, perms, invites);
  const siteName = (id) => state.locations.find((l) => l.id === id)?.name ?? '';
  const sitesLabel = (u) => {
    if (u.role === 'admin' || u.all_sites) return 'All sites';
    const ids = [...new Set([u.location_id, ...(u.site_ids ?? [])].filter(Boolean))];
    return ids.length === 1 ? siteName(ids[0]) : `${ids.length} sites`;
  };
  listPage(ctx, {
    title: state.multiSite ? 'Staff' : `Staff · ${state.location?.name ?? ''}`,
    rows,
    search: true,
    bulk: {
      label: 'Edit selected',
      run: (people) => openBulkStaff(ctx, people, { roles: editor.rotaGroups, locOptions: editor.locOptions, access: editor.accessOptions({}) }),
      more: [{ label: 'Invite selected', run: (people) => sendInvites(ctx, people) }],
    },
    addLabel: 'Add staff member',
    extraActions: `${state.isAdmin && square?.configured ? '<button class="btn" id="import-square">Import from Square</button>' : ''}
      ${siteFilter(state, scope)}
      <select id="join-filter" aria-label="Who has joined"><option value="">Everyone</option>
        ${JOIN_STATUS.map(([k, label]) => `<option value="${k}" ${k === status ? 'selected' : ''}>${label}</option>`).join('')}</select>`,
    columns: [
      { label: 'Name', key: 'name' },
      { label: 'Email', key: 'email' },
      { label: 'Access', value: (r) => r.access_name ?? '' },
      { label: 'Sites', value: sitesLabel },
      { label: 'Site', value: (r) => r.location_name ?? 'All (admin)' },
      { label: 'Role', value: (r) => r.rota_group ?? '' },
      { label: 'Hourly rate', num: true, value: (r) => money(r.hourly_rate) },
      { label: 'Active', value: (r) => yesNo(r.active) },
      { label: 'Atlas', value: (r) => joinStatus(r).label, html: (r) => joinBadge(r) },
      ...(invites.square_ready ? [{ label: 'Square', value: (r) => (r.square_member_id ? 'Linked' : '–') }] : []),
    ],
    form: editor.form,
    save: async (v, row, form) => {
      const saved = await editor.save(v, row, form);
      // On a single site's list, say where someone went if their home site changed.
      if (scope !== 'all' && saved.location_id && saved.location_id !== state.locationId) {
        const site = state.locations.find((l) => l.id === saved.location_id)?.name ?? 'another site';
        setTimeout(() => toast(`${saved.name} now works from ${site}, so they're listed there. Use “Show all sites” to see everyone.`), 2600);
      }
    },
  });
  ctx.el.querySelector('#import-square')?.addEventListener('click', () => openSquareImport(ctx));
  ctx.el.querySelector('#join-filter').addEventListener('change', (e) => ctx.navigate(`admin/staff${qs({ scope: ctx.query.scope, status: e.target.value || undefined })}`));

  // Who has joined Atlas, and inviting everyone who hasn't been invited yet.
  const active = everyone.filter((u) => u.active);
  const count = (k) => active.filter((u) => joinStatus(u).key === k).length;
  const notInvited = active.filter((u) => joinStatus(u).key === 'none' && u.id !== state.user.id);
  ctx.el.querySelector('.page-head').insertAdjacentHTML('afterend', `<div class="join-summary card">
    <div><strong>${count('joined')}</strong> of ${active.length} have joined Atlas
      <span class="muted">· ${count('invited')} invited, not signed in yet · ${count('none')} not invited</span></div>
    ${invites.email_ready ? '' : '<p class="muted small">Email isn’t set up yet, so invites can’t be emailed – open a person and use “Copy invite link” to send it by text or WhatsApp.</p>'}
    ${notInvited.length && invites.email_ready ? `<button class="btn btn-small" id="invite-rest">Invite ${notInvited.length} ${notInvited.length === 1 ? 'person' : 'people'} not invited yet</button>` : ''}
  </div>`);
  ctx.el.querySelector('#invite-rest')?.addEventListener('click', () => sendInvites(ctx, notInvited));
}

// Square: linked people's changes are copied there; new people can be added to Square as they're added here.
function squareBox(u, settings) {
  if (!settings.square_ready) return '';
  const team = settings.square_team_url ? `<a href="${esc(settings.square_team_url)}" target="_blank" rel="noopener">Square team page ↗</a>` : 'the Square Dashboard';
  if (u.square_member_id) {
    return `<p class="square-box small"><strong>✓ Linked to Square</strong> – changes to their name, email, home site, pay and whether they’re active are copied to Square when you save. Set their POS passcode on ${team}.</p>`;
  }
  return `<label class="check-row square-box"><input type="checkbox" name="add_to_square" ${u.id ? '' : 'checked'}>
    <span><strong>${u.id ? 'Add to Square' : 'Also add to Square'}</strong>
    <small>Adds them to your Square team (or links them, if they’re already there with this email) with their home site and pay. You then set their POS passcode on ${team}.</small></span></label>`;
}

function squareToast(saved, settings) {
  const r = saved?.square_sync;
  if (!r) return;
  const later = (m, kind) => setTimeout(() => toast(m, kind), 2600);
  if (r.status === 'error') later(`Saved in Atlas, but Square didn’t accept the change: ${r.error}`, 'error');
  else if (r.status === 'created') later(`${saved.name} added to Square – now set their POS passcode in the Square Dashboard.`);
  else if (r.status === 'linked') later(`${saved.name} was already in Square, so they’re now linked.`);
  else if (r.status === 'owner') later('The Square account owner can only be changed in Square itself.');
  if (r.warning) setTimeout(() => toast(r.warning, 'error'), 5200);
}

// Whether someone has signed in to Atlas yet.
const JOIN_STATUS = [['none', 'Not invited'], ['invited', 'Invited, not joined'], ['joined', 'Joined']];
const shortDay = (sql) => fmtDate(String(sql).slice(0, 10), { day: 'numeric', month: 'short' });
export function joinStatus(u) {
  if (u.last_login_at) return { key: 'joined', label: `Joined · last seen ${shortDay(u.last_login_at)}`, tone: 'pass' };
  if (u.invited_at) return { key: 'invited', label: `Invited ${shortDay(u.invited_at)}`, tone: 'sent' };
  return { key: 'none', label: 'Not invited', tone: 'draft' };
}
const joinBadge = (u) => { const s = joinStatus(u); return `<span class="badge badge-${s.tone}">${esc(s.label)}</span>`; };

function inviteBox(u) {
  const s = joinStatus(u);
  return `<div class="invite-box" data-user="${u.id}">
    <div><span class="muted small">Atlas</span> ${joinBadge(u)}</div>
    <div class="invite-actions">
      <button type="button" class="btn btn-small" data-invite-email>${s.key === 'none' ? 'Email an invite' : 'Email a new invite'}</button>
      <button type="button" class="btn btn-small btn-ghost" data-invite-link>Copy invite link</button>
    </div>
    <small class="muted">They choose their own password from the link. ${s.key === 'joined' ? 'They’ve already signed in, so they only need this if they’re locked out.' : ''}</small>
  </div>`;
}

// Invites from a person's details (buttons are inside the edit dialog).
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-invite-email], [data-invite-link]');
  if (!b) return;
  const userId = Number(b.closest('[data-user]').dataset.user);
  b.disabled = true;
  try {
    if (b.matches('[data-invite-link]')) {
      const { link } = await api('/users/invite', { method: 'POST', body: { ids: [userId], link_only: true } });
      try { await navigator.clipboard.writeText(link); toast('Invite link copied – paste it into a text or WhatsApp. It works for 14 days.'); } catch { window.prompt('Copy this invite link (it works for 14 days):', link); }
    } else {
      const r = await api('/users/invite', { method: 'POST', body: { ids: [userId] } });
      toast(inviteSummary(r), r.sent.length ? 'ok' : 'error');
    }
  } catch (err) { toast(err.message, 'error'); }
  b.disabled = false;
});

function inviteSummary(r) {
  const parts = [];
  if (r.sent.length) parts.push(`Invite sent to ${r.sent.length === 1 ? r.sent[0].name : `${r.sent.length} people`}`);
  if (r.skipped.length) parts.push(`${r.skipped.length} skipped (${[...new Set(r.skipped.map((s) => s.reason))].join(', ')}: ${r.skipped.map((s) => s.name).join(', ')})`);
  if (r.failed.length) parts.push(`${r.failed.length} failed: ${r.failed[0].reason}`);
  return parts.join('. ') || 'Nobody to invite';
}

async function sendInvites(ctx, people) {
  const list = people.filter((p) => p.active);
  if (!list.length) { toast('Nobody active to invite', 'error'); return; }
  const again = list.filter((p) => joinStatus(p).key !== 'none').length;
  const ok = await confirmDialog(`Email an invite to join Atlas to ${list.length === 1 ? list[0].name : `${list.length} people`}?${again ? ` ${again} of them ${again === 1 ? 'has' : 'have'} been invited or joined before – their old links will stop working.` : ''} Each person gets a link to choose their own password.`,
    { title: 'Send invites', confirmLabel: `Send ${list.length} invite${list.length === 1 ? '' : 's'}` });
  if (!ok) return;
  try {
    const r = await api('/users/invite', { method: 'POST', body: { ids: list.map((p) => p.id) } });
    toast(inviteSummary(r), r.failed.length && !r.sent.length ? 'error' : 'ok');
    ctx.rerender();
  } catch (err) { toast(err.message, 'error'); }
}

// Opening hours, Monday first: tick the days the site is open and set the times. The rota warns about any time
// in them with nobody on.
const WEEK_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function openingHoursField(l) {
  let hours = null;
  try { hours = l.opening_hours ? JSON.parse(l.opening_hours) : null; } catch { hours = null; }
  return `<fieldset class="oh-field"><legend>Opening hours</legend>
    <p class="small muted">The rota warns if nobody is on at any time while the site is open. Untick days it’s closed. Use 00:00 to close at midnight.</p>
    <table class="oh-table"><tbody>${WEEK_DAYS.map((d, i) => {
      const h = hours?.[i];
      return `<tr data-oh-day="${i}"><th>${d}</th>
        <td><label class="check"><input type="checkbox" name="oh_on_${i}" ${h ? 'checked' : ''}> Open</label></td>
        <td><input type="time" name="oh_open_${i}" value="${esc(h?.open ?? '')}" aria-label="${d} opens" ${h ? '' : 'disabled'}></td>
        <td class="oh-to">to</td>
        <td><input type="time" name="oh_close_${i}" value="${esc(h?.close ?? '')}" aria-label="${d} closes" ${h ? '' : 'disabled'}></td></tr>`;
    }).join('')}</tbody></table>
    <button type="button" class="btn btn-small" data-oh-copy>Copy Monday to every day</button>
  </fieldset>`;
}
// The seven days from the form, or null if no day is ticked (opening hours not set).
function readOpeningHours(form) {
  const days = WEEK_DAYS.map((d, i) => {
    if (!form.querySelector(`[name=oh_on_${i}]`).checked) return null;
    const open = form.querySelector(`[name=oh_open_${i}]`).value;
    const close = form.querySelector(`[name=oh_close_${i}]`).value;
    if (!open || !close) throw new Error(`Enter ${d}’s opening and closing times, or untick it`);
    return { open, close };
  });
  return days.some(Boolean) ? days : null;
}
document.addEventListener('change', (e) => {
  const m = /^oh_on_(\d)$/.exec(e.target.name ?? '');
  if (!m) return;
  const row = e.target.closest('tr');
  row.querySelectorAll('input[type=time]').forEach((t) => { t.disabled = !e.target.checked; });
  if (e.target.checked) row.querySelector('input[type=time]').focus();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-oh-copy]')) return;
  const form = e.target.closest('form');
  const on = form.querySelector('[name=oh_on_0]').checked;
  const open = form.querySelector('[name=oh_open_0]').value;
  const close = form.querySelector('[name=oh_close_0]').value;
  for (let i = 1; i < 7; i++) {
    form.querySelector(`[name=oh_on_${i}]`).checked = on;
    form.querySelector(`[name=oh_open_${i}]`).value = open;
    form.querySelector(`[name=oh_close_${i}]`).value = close;
    form.querySelectorAll(`[data-oh-day="${i}"] input[type=time]`).forEach((t) => { t.disabled = !on; });
  }
});

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
      { label: 'Opening hours', value: (r) => (r.opening_hours ? 'Set' : 'Not set') },
      { label: 'Active', value: (r) => yesNo(r.active) },
    ],
    form: (l) => `${field('Name', input('name', l.name, 'required'))}${field('Address', textarea('address', l.address))}${field('Phone', input('phone', l.phone))}
      ${openingHoursField(l)}${activeBox(l.active)}`,
    save: async (v, row, form) => {
      for (const k of Object.keys(v)) if (k.startsWith('oh_')) delete v[k];
      v.opening_hours = readOpeningHours(form);
      if (row) await api(`/locations/${row.id}`, { method: 'PUT', body: v });
      else await api('/locations', { method: 'POST', body: v });
      await loadLocations();
    },
  });
}

// A product's pack quantity also fills in its recipe units per pack while the recipe unit is the same as the unit
// (e.g. a 1.5 Kg pack measured in Kg in recipes is 1.5 recipe units).
document.addEventListener('input', (e) => {
  if (!['pack_quantity', 'unit', 'recipe_unit'].includes(e.target.name)) return;
  const form = e.target.closest('form');
  if (!form?.pack_quantity || !form.units_per_pack) return;
  const same = form.unit.value.trim().toLowerCase() && form.unit.value.trim().toLowerCase() === form.recipe_unit.value.trim().toLowerCase();
  if (same && Number(form.pack_quantity.value) > 0) form.units_per_pack.value = form.pack_quantity.value;
});

// The product form (Stock & Ordering → Products, and the ✎ beside an ingredient when editing a recipe).
async function productFormKit() {
  const [suppliers, meta, cats, vat] = await Promise.all([api('/suppliers'), api('/recipes/meta'), api('/product-categories'), api('/vat-codes')]);
  const vatName = new Map(vat.codes.map((v) => [v.code, v.name]));
  const vatOptions = (code) => [['', '— Choose —'], ...vat.codes.map((v) => [v.code, `${v.name} (${v.code})`]), ...(code && !vatName.has(code) ? [[code, code]] : [])];
  const catOptions = [['', cats.length ? '— Choose —' : '— Add categories first —'], ...cats.map((c) => [c.name, c.name])];
  const ALLERGEN_LIST = meta.allergens;
  return {
    vatName, vatOptions, catOptions, ALLERGEN_LIST,
    form: (p) => `
      <div class="row">${field('Name', input('name', p.name, 'required'))}${field('SKU / supplier code', input('sku', p.sku))}</div>
      <div class="row">
        ${field('Category', select('category', catOptions, p.category ?? '', cats.length ? 'required' : ''), { hint: 'Manage them under Product categories' })}
        ${field('VAT code', select('vat_code', vatOptions(p.vat_code), p.vat_code ?? '', 'required'), { hint: vat.from_xero ? 'Your VAT rates in Xero' : 'As Xero names them' })}
      </div>
      <div class="row">
        ${field('Pack quantity', input('pack_quantity', p.pack_quantity, 'type="number" min="0.0001" step="any" placeholder="e.g. 1.5"'), { hint: 'How much is in one pack, in the unit beside it' })}
        ${field('Unit', input('unit', p.unit ?? 'each', 'required placeholder="each, case, kg…"'), { hint: 'e.g. 1.5 Kg = a 1.5 kg pack' })}
      </div>
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
  };
}

/** Edits a product in a pop-up, e.g. from a recipe; onSaved gets the product as saved. */
export async function openProductEditor(product, onSaved) {
  const kit = await productFormKit();
  openModal({
    title: `Edit ${product.name}`,
    body: kit.form(product),
    wide: true,
    onSubmit: async (v) => {
      await kit.save(v, product);
      toast('Product saved');
      await onSaved?.();
    },
  });
}

export async function renderProducts(ctx) {
  const { state } = ctx;
  const [rows, kit] = await Promise.all([api('/products'), productFormKit()]);
  const { vatName, vatOptions, catOptions, ALLERGEN_LIST } = kit;
  if (ctx.stale()) return;
  listPage(ctx, {
    title: 'Products',
    rows,
    search: true,
    canEdit: state.can('setup.products'),
    addLabel: 'Add product',
    bulk: {
      label: 'Set VAT code',
      run: (picked) => bulkSet(picked, 'vat_code', 'VAT code', vatOptions(null)),
      more: [{ label: 'Set category', run: (picked) => bulkSet(picked, 'category', 'Category', catOptions) }],
    },
    extraActions: `${rows.length ? '<button class="btn" id="export-products">Export</button>' : ''}${state.can('setup.products') ? '<button class="btn" id="import-products">Import</button>' : ''}`,
    columns: [
      { label: 'Name', key: 'name' },
      { label: 'Category', value: (r) => r.category ?? '', html: (r) => (r.category ? esc(r.category) : '<span class="tone-warn">No category</span>') },
      { label: 'VAT', value: (r) => (r.vat_code ? vatName.get(r.vat_code) ?? r.vat_code : 'No VAT code'),
        html: (r) => (r.vat_code ? `<span title="${esc(r.vat_code)}">${esc(vatName.get(r.vat_code) ?? r.vat_code)}</span>` : '<span class="tone-warn">Not set</span>') },
      { label: 'Pack', value: (r) => (r.pack_quantity ? `${Number(r.pack_quantity)} ${r.unit ?? ''}`.trim() : r.unit ?? '') },
      { label: 'Supplier', key: 'supplier_name' },
      { label: 'Unit cost', num: true, value: (r) => money(r.unit_cost) },
      { label: 'Default par', num: true, key: 'par_level' },
      { label: 'Recipe unit', value: (r) => (r.units_per_pack && r.units_per_pack !== 1 ? `${r.units_per_pack} ${r.recipe_unit ?? ''} / ${r.unit}` : r.recipe_unit ?? r.unit) },
      { label: '', html: (r) => `<button class="btn btn-small" data-pars="${r.id}">Site pars</button>` },
    ],
    form: kit.form,
    save: kit.save,
  });

  // Ticked products: give them all the same VAT code or category.
  function bulkSet(picked, key, label, options) {
    openModal({
      title: `${label} for ${picked.length} product${picked.length === 1 ? '' : 's'}`,
      body: field(label, select(key, options, '', 'required')),
      onSubmit: async (v) => {
        const r = await api('/products/bulk', { method: 'POST', body: { ids: picked.map((p) => p.id), [key]: v[key] } });
        toast(`${r.changed} product${r.changed === 1 ? '' : 's'} updated`);
        ctx.rerender();
      },
    });
  }

  ctx.el.querySelector('#import-products')?.addEventListener('click', () => openProductImport(ctx));
  ctx.el.querySelector('#export-products')?.addEventListener('click', () => exportProducts(rows, ALLERGEN_LIST));
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
    </section>
    ${installCard()}`;
  wireInstallCard(el);
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
      ${!c.ready ? `<p class="notice">${!c.linked_sites.length ? 'Link your sites to Square locations above first.' : 'Import your staff from Square first (People → Staff → Import from Square), so Atlas knows who to keep.'}</p>` : ''}
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
    const ok = await confirmDialog(`This permanently deletes ${parts.join(' and ')} and their records. A backup copy of your data is saved first.`, { confirmLabel: 'Delete', title: 'Remove from Atlas?' });
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
             <li>Go to <strong>developer.squareup.com</strong>, sign in with your Square account and create an application (e.g. “Atlas”).</li>
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
    <p class="muted">Give each person a permission set on the Staff page (their <strong>Access</strong>). They can do what their set allows, at their sites.
      <strong>Admin</strong> is everything, at every site, including the admin-only pages (Permissions, Locations, Square and Email reports): to make someone an admin, choose
      “Admin – everything, every site” as their Access on the Staff page. Only admins can do that.</p>
    <section class="card">
      <div class="table-wrap"><table class="perm-matrix">
        <thead><tr><th></th><th class="perm-set perm-admin"><strong>Admin</strong>
          <small>${data.admins ?? 0} ${data.admins === 1 ? 'person' : 'people'} · built in · everything</small></th>${sets.map((s) => `<th class="perm-set">
          <button class="link-btn" data-edit="${s.id}">${esc(s.name)}</button>
          <small>${s.people} ${s.people === 1 ? 'person' : 'people'}${s.built_in ? ' · built in' : ''}</small></th>`).join('')}</tr></thead>
        <tbody>${areas.map((a) => `
          <tr class="perm-area-row"><th colspan="${sets.length + 2}">${esc(a.area)}</th></tr>
          ${a.permissions.map((p) => `<tr><th scope="row">${esc(p.label)}</th><td class="perm-yes perm-admin"><span aria-hidden="true">✓</span><span class="sr-only">Yes</span></td>${sets.map((s) => (s.permissions.includes(p.key)
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
