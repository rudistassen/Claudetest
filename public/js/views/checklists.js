import { addDays, api, confirmDialog, esc, field, fmtDate, input, openModal, qs, select, showError, siteFilter, siteScope, textarea, toast, todayISO } from '../lib.js';

// Checklists & Tasks: the day's operational checklists for a site (opening, closing, cleaning…), tasks given to a
// person, a role or a site, and a private to-do list. Food-safety checks are in Compliance.

const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['7', 'Sun']];
const REPEATS = [['none', 'Doesn’t repeat'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month']];
const daysLabel = (d) => (d === '1234567' ? 'Every day' : d === '12345' ? 'Weekdays' : d === '67' ? 'Weekends' : DAYS.filter(([k]) => d.includes(k)).map(([, l]) => l).join(', '));
const when = (sqlUtc) => new Date(`${sqlUtc.replace(' ', 'T')}Z`).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const dayText = (d) => fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' });

// ---- Checklists: tick off today's ----

export async function renderChecklists(ctx) {
  const { el, state, query, stale, navigate, rerender } = ctx;
  siteScope(state, query.scope, 'site');
  const today = todayISO();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(query.date ?? '') && query.date <= today ? query.date : today;
  const data = await api(`/checklists${qs({ location_id: state.locationId, date: day })}`);
  if (stale()) return;
  const all = data.checklists.reduce((t, c) => t + c.total, 0);
  const done = data.checklists.reduce((t, c) => t + c.done, 0);
  el.innerHTML = `<div class="hip ck">
    <div class="page-head"><h1 class="hub-title">Checklists</h1>
      <div class="actions">${state.can('checklists.manage') ? '<a class="btn" href="#/checklists/setup">Set up checklists</a>' : ''}</div></div>
    <form class="filters" id="ck-filters">${siteFilter(state, 'site', { all: false })}
      ${data.can_tick_past ? `<label class="ck-day">Day <input type="date" name="date" value="${day}" min="${addDays(today, -7)}" max="${today}"></label>` : ''}</form>
    <p class="ck-summary">${day === today ? 'Today' : dayText(day)} · <strong>${done} of ${all}</strong> done${all && done === all ? ' ✨' : ''}</p>
    ${data.checklists.length ? data.checklists.map((c) => `<section class="card ck-list ${c.total && c.done === c.total ? 'is-done' : ''}">
      <header class="ck-head"><h2>${esc(c.name)}</h2><span class="ck-count">${c.done} / ${c.total}</span></header>
      ${c.description ? `<p class="muted small">${esc(c.description)}</p>` : ''}
      <div class="ck-bar" aria-hidden="true"><span style="width:${c.total ? (c.done / c.total) * 100 : 0}%"></span></div>
      <ul class="ck-items">${c.items.map((i) => `<li><label class="ck-item ${i.done ? 'is-done' : ''}">
        <input type="checkbox" data-tick="${i.id}" ${i.done ? 'checked' : ''}>
        <span class="ck-text">${esc(i.text)}</span>
        ${i.done ? `<small class="muted">${esc(i.done_by_name ?? '')} · ${when(i.done_at)}</small>` : ''}</label></li>`).join('')}</ul>
    </section>`).join('') : `<div class="card empty">No checklists for ${day === today ? 'today' : 'this day'} here.${state.can('checklists.manage') ? ' <a href="#/checklists/setup">Set one up</a>.' : ''}</div>`}
  </div>`;
  const form = el.querySelector('#ck-filters');
  form.addEventListener('change', () => navigate(`checklists${qs({ scope: form.scope?.value, date: form.date?.value && form.date.value !== today ? form.date.value : undefined })}`));
  form.addEventListener('submit', (e) => e.preventDefault());
  el.querySelectorAll('[data-tick]').forEach((b) => b.addEventListener('change', async () => {
    b.disabled = true;
    try {
      await api(`/checklists/items/${b.dataset.tick}/tick`, { method: 'POST', body: { location_id: state.locationId, date: day, done: b.checked } });
      rerender();
    } catch (err) { showError(err); b.checked = !b.checked; b.disabled = false; }
  }));
}

// Ready-made checklists to start from (they can be changed after adding).
const READY = [
  ['Opening checklist', 'Before the doors open', '1234567', ['Alarm off, lights and music on', 'Coffee machine and grinder on; flush the group heads', 'Dial in the espresso and taste a shot', 'Tills open, card machines charged, float counted', 'Milk, syrups and cups stocked at the bar', 'Cake and food display filled and labelled', 'Tables, chairs and outside seating out and wiped', 'Toilets checked and stocked', 'Floors clear and dry; wet floor signs away', 'Doors unlocked and open sign on']],
  ['Closing checklist', 'After the last customer leaves', '1234567', ['Back-flush and clean the coffee machine; steam wands soaked', 'Grinder hopper emptied and cleaned', 'Fridges and display covered, food labelled or thrown away', 'Dishwasher emptied and cleaned', 'All surfaces cleaned and sanitised', 'Floors swept and mopped', 'Bins emptied and taken out', 'Tills cashed up and the safe locked', 'Equipment switched off (except fridges)', 'Windows and doors locked, alarm set']],
  ['Mid-shift checklist', 'Around the middle of the day', '1234567', ['Toilets checked and cleaned', 'Bins emptied if more than half full', 'Milk, cups, lids and napkins restocked', 'Tables cleared and wiped', 'Coffee tasted and grinder adjusted if needed']],
  ['Weekly deep clean', 'Once a week', '1', ['Descale the kettle and hot water tower', 'Clean behind and under the fridges', 'Deep-clean the grinder burrs', 'Wipe down shelves and stockroom', 'Clean windows and door glass', 'Check use-by dates on everything in stock']],
];

// ---- Checklists: set up ----

export async function renderChecklistSetup(ctx) {
  const { el, state, stale, rerender } = ctx;
  const rows = await api('/checklists/setup');
  if (stale()) return;
  const sites = state.locations.filter((l) => l.active);
  el.innerHTML = `<div class="hip ck">
    <div class="page-head"><h1 class="hub-title">Set up checklists</h1>
      <div class="actions"><a class="btn" href="#/checklists">← Checklists</a><button class="btn btn-primary" id="ck-new">+ New checklist</button></div></div>
    <p class="muted">Opening, closing, cleaning and anything else staff should tick off – separate from the food-safety checks in Compliance.</p>
    <section class="card ck-ready"><h2>Ready-made</h2><p class="muted small">Add one as a starting point for ${state.isAdmin ? 'every site' : 'your site'}, then change it to suit.</p>
      <div class="chips">${READY.map(([name], i) => `<button type="button" class="chip chip-btn" data-ready="${i}">+ ${esc(name)}</button>`).join('')}</div></section>
    ${rows.length ? `<ul class="ck-setup">${rows.map((c) => `<li class="card">
      <div><h2>${esc(c.name)}</h2>
        <p class="small muted">${c.location_id ? esc(c.location_name) : 'Every site'} · ${daysLabel(c.days)} · ${c.items.length} item${c.items.length === 1 ? '' : 's'}</p>
        ${c.description ? `<p class="small">${esc(c.description)}</p>` : ''}</div>
      ${c.can_edit ? `<button class="btn btn-small" data-edit="${c.id}">Edit</button>` : '<span class="muted small">Set up by an admin</span>'}
    </li>`).join('')}</ul>` : '<div class="card empty">No checklists yet – add one with <strong>+ New checklist</strong>.</div>'}
  </div>`;

  const edit = (c) => {
    const siteOptions = [...(state.isAdmin ? [['all', 'Every site']] : []), ...sites.map((l) => [l.id, l.name])];
    const { form } = openModal({
      title: c ? `Edit ${c.name}` : 'New checklist',
      body: `${field('Name', input('name', c?.name, 'required maxlength="100" placeholder="e.g. Opening checklist"'))}
        ${field('Description (optional)', input('description', c?.description, 'maxlength="500" placeholder="e.g. Before the doors open"'))}
        ${field('Site', select('location_id', siteOptions, c ? (c.location_id ?? 'all') : state.locationId))}
        <fieldset class="ck-days"><legend>Which days</legend>${DAYS.map(([k, l]) => `<label class="chip-check"><input type="checkbox" data-day="${k}" ${(c?.days ?? '1234567').includes(k) ? 'checked' : ''}>${l}</label>`).join('')}</fieldset>
        ${field('Things to check (one per line)', textarea('items', c ? c.items.map((i) => i.text).join('\n') : '', 'rows="9" required placeholder="Lights and music on\nCoffee machine on and flushed\nTills open with a float\nTables and chairs out"'))}`,
      submitLabel: c ? 'Save' : 'Add checklist',
      wide: true,
      onSubmit: async (v, f) => {
        const body = {
          name: v.name, description: v.description, location_id: v.location_id === 'all' ? null : Number(v.location_id),
          days: [...f.querySelectorAll('[data-day]:checked')].map((b) => b.dataset.day).join(''),
          items: String(v.items ?? '').split('\n').map((t) => t.trim()).filter(Boolean),
        };
        await api(c ? `/checklists/${c.id}` : '/checklists', { method: c ? 'PUT' : 'POST', body });
        toast(c ? 'Checklist saved' : 'Checklist added');
        rerender();
      },
      danger: c ? 'Delete checklist' : null,
      onDanger: async () => {
        if (!(await confirmDialog(`Delete “${c.name}”? Past ticks are kept.`, { confirmLabel: 'Delete' }))) return;
        await api(`/checklists/${c.id}`, { method: 'DELETE' });
        toast('Checklist deleted');
        rerender();
      },
    });
    return form;
  };
  el.querySelector('#ck-new').addEventListener('click', () => edit(null));
  el.querySelectorAll('[data-ready]').forEach((b) => b.addEventListener('click', async () => {
    const [name, description, days, items] = READY[Number(b.dataset.ready)];
    b.disabled = true;
    try {
      await api('/checklists', { method: 'POST', body: { name, description, days, items, location_id: state.isAdmin ? null : state.locationId } });
      toast(`${name} added`);
      rerender();
    } catch (err) { showError(err); b.disabled = false; }
  }));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(rows.find((c) => c.id === Number(b.dataset.edit)))));
}

// ---- Tasks ----

export async function renderTasks(ctx) {
  const { el, state, query, stale, navigate, rerender } = ctx;
  const manager = state.can('tasks.manage');
  const tab = manager && (query.tab === 'all' || query.tab === 'done') ? query.tab : 'mine';
  const scope = manager ? siteScope(state, query.scope) : 'all';
  const [mine, all, who] = await Promise.all([
    api('/tasks/mine'),
    manager && tab !== 'mine' ? api(`/tasks${qs({ status: tab === 'done' ? 'done' : 'open', location_id: scope === 'all' ? undefined : state.locationId })}`) : null,
    manager ? api('/tasks/people') : null,
  ]);
  if (stale()) return;
  const list = tab === 'mine' ? mine : all;
  const assigned = (t) => (t.assign_to === 'person' ? esc(t.user_name ?? '') : t.assign_to === 'role' ? `${esc(t.role)} at ${esc(t.location_name)}` : `Everyone at ${esc(t.location_name)}`);
  const badge = (t) => (t.status === 'done' ? '<span class="tk-tag is-done">Done</span>' : t.status === 'overdue' ? '<span class="tk-tag is-late">Overdue</span>' : '');
  const row = (t) => `<li class="tk ${t.status === 'done' ? 'is-done' : ''}">
    ${t.status !== 'done' && (t.mine || t.can_manage) ? `<button type="button" class="tk-check" data-done="${t.id}" aria-label="Mark “${esc(t.title)}” done" title="Mark done"></button>` : `<span class="tk-check ${t.status === 'done' ? 'is-on' : ''}" aria-hidden="true"></span>`}
    <div class="tk-main"><strong>${esc(t.title)}</strong> ${badge(t)}
      ${t.notes ? `<p class="small">${esc(t.notes)}</p>` : ''}
      <small class="muted">${[
        t.due_on ? `${t.status === 'overdue' ? 'Was due' : 'Due'} ${dayText(t.due_on)}` : 'No due date',
        t.repeat !== 'none' ? REPEATS.find(([k]) => k === t.repeat)[1].toLowerCase() : '',
        tab === 'mine' ? (t.assign_to === 'person' ? '' : assigned(t)) : assigned(t),
        t.status === 'done' ? `done by ${esc(t.done_by_name ?? '')}` : t.created_by_name ? `from ${esc(t.created_by_name)}` : '',
      ].filter(Boolean).join(' · ')}</small></div>
    <span class="tk-actions">${t.status === 'done' && (t.can_manage || t.done_by === state.user.id) ? `<button type="button" class="btn btn-small btn-ghost" data-reopen="${t.id}">Reopen</button>` : ''}
      ${t.can_manage && tab !== 'mine' ? `<button type="button" class="btn btn-small" data-edit="${t.id}">Edit</button>` : ''}</span>
  </li>`;
  const tabs = manager ? `<div class="seg ck-tabs" role="tablist">${[['mine', 'My tasks'], ['all', 'All open tasks'], ['done', 'Done']].map(([k, l]) => `<a class="${tab === k ? 'is-on' : ''}" href="#/tasks${qs({ tab: k === 'mine' ? undefined : k, scope: query.scope })}">${l}</a>`).join('')}</div>` : '';
  el.innerHTML = `<div class="hip ck">
    <div class="page-head"><h1 class="hub-title">Tasks</h1><div class="actions">${manager ? '<button class="btn btn-primary" id="tk-new">+ New task</button>' : ''}</div></div>
    ${tabs}
    ${manager && tab !== 'mine' && state.multiSite ? `<form class="filters" id="tk-filters">${siteFilter(state, scope)}</form>` : ''}
    ${list.length ? `<ul class="tk-list card">${list.map(row).join('')}</ul>`
      : `<div class="card empty">${tab === 'mine' ? 'Nothing to do – no tasks have been given to you.' : tab === 'done' ? 'No tasks done in the last 60 days.' : 'No open tasks.'}</div>`}
  </div>`;
  const form = el.querySelector('#tk-filters');
  form?.addEventListener('change', () => navigate(`tasks${qs({ tab, scope: form.scope.value })}`));

  el.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api(`/tasks/${b.dataset.done}/done`, { method: 'POST', body: {} });
      toast(r.next_due_on ? `Done – next due ${dayText(r.next_due_on)}` : 'Done ✓');
      rerender();
    } catch (err) { showError(err); b.disabled = false; }
  }));
  el.querySelectorAll('[data-reopen]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/tasks/${b.dataset.reopen}/reopen`, { method: 'POST' }); toast('Reopened'); rerender(); } catch (err) { showError(err); }
  }));

  const edit = (t) => {
    const { form: f } = openModal({
      title: t ? 'Edit task' : 'New task',
      body: `${field('Task', input('title', t?.title, 'required maxlength="200" placeholder="e.g. Deep-clean the coffee grinder"'))}
        ${field('Notes (optional)', textarea('notes', t?.notes, 'rows="2" maxlength="2000"'))}
        ${field('Give it to', select('assign_to', [['person', 'A person'], ['role', 'Everyone in a role at a site'], ['site', 'Everyone at a site']], t?.assign_to ?? 'person'))}
        <div data-for="person">${field('Person', select('user_id', who.people.map((p) => [p.id, `${p.name}${p.location_name ? ` – ${p.location_name}` : ''}`]), t?.user_id ?? who.people[0]?.id))}</div>
        <div data-for="role">${field('Role', select('role', who.roles.map((r) => [r, r]), t?.role ?? who.roles[0]))}</div>
        <div data-for="role site">${field('Site', select('location_id', who.sites.map((l) => [l.id, l.name]), t?.location_id ?? state.locationId))}</div>
        <div class="row">${field('Due (optional)', input('due_on', t?.due_on, 'type="date"'))}${field('Repeats', select('repeat', REPEATS, t?.repeat ?? 'none'))}</div>
        <p class="muted small">They’ll see it in Tasks and on My Atlas, and get a notification. A repeating task moves on to its next date each time it’s done.</p>`,
      submitLabel: t ? 'Save' : 'Give task',
      onSubmit: async (v) => {
        await api(t ? `/tasks/${t.id}` : '/tasks', { method: t ? 'PUT' : 'POST', body: { ...v, user_id: v.assign_to === 'person' ? v.user_id : null } });
        toast(t ? 'Task saved' : 'Task given');
        rerender();
      },
      danger: t ? 'Delete task' : null,
      onDanger: async () => {
        if (!(await confirmDialog(`Delete “${t.title}”?`, { confirmLabel: 'Delete' }))) return;
        await api(`/tasks/${t.id}`, { method: 'DELETE' });
        toast('Task deleted');
        rerender();
      },
    });
    const show = () => {
      const mode = f.querySelector('[name=assign_to]').value;
      f.querySelectorAll('[data-for]').forEach((d) => { d.hidden = !d.dataset.for.split(' ').includes(mode); });
    };
    f.querySelector('[name=assign_to]').addEventListener('change', show);
    show();
  };
  el.querySelector('#tk-new')?.addEventListener('click', () => edit(null));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(list.find((t) => t.id === Number(b.dataset.edit)))));
}

// ---- My to-do ----

export async function renderTodo(ctx) {
  const { el, stale, rerender } = ctx;
  const rows = await api('/todos');
  if (stale()) return;
  const today = todayISO();
  const open = rows.filter((t) => !t.done_at);
  const done = rows.filter((t) => t.done_at);
  const item = (t) => `<li class="tk ${t.done_at ? 'is-done' : ''}">
    <button type="button" class="tk-check ${t.done_at ? 'is-on' : ''}" data-toggle="${t.id}" aria-label="${t.done_at ? 'Not done' : 'Done'}"></button>
    <div class="tk-main"><strong>${esc(t.text)}</strong>
      ${t.due_on ? `<small class="${!t.done_at && t.due_on < today ? 'tone-bad' : 'muted'}">${!t.done_at && t.due_on < today ? 'Was due' : 'Due'} ${dayText(t.due_on)}</small>` : ''}</div>
    <span class="tk-actions"><button type="button" class="icon-btn" data-del="${t.id}" aria-label="Delete" title="Delete">✕</button></span></li>`;
  el.innerHTML = `<div class="hip ck">
    <div class="page-head"><h1 class="hub-title">My to-do</h1></div>
    <p class="muted">Just for you – nobody else can see this list.</p>
    <form class="card td-add" id="td-add"><input name="text" required maxlength="300" placeholder="Add something to do…" aria-label="To-do">
      <input type="date" name="due_on" aria-label="Due (optional)" title="Due (optional)"><button class="btn btn-primary">Add</button></form>
    ${open.length ? `<ul class="tk-list card">${open.map(item).join('')}</ul>` : '<div class="card empty">Nothing to do ✨</div>'}
    ${done.length ? `<h2 class="td-done-head">Done in the last two weeks</h2><ul class="tk-list card">${done.map(item).join('')}</ul>` : ''}
  </div>`;
  el.querySelector('#td-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/todos', { method: 'POST', body: { text: f.text.value, due_on: f.due_on.value || null } });
      rerender();
    } catch (err) { showError(err); }
  });
  el.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const t = rows.find((x) => x.id === Number(b.dataset.toggle));
    try { await api(`/todos/${t.id}`, { method: 'PUT', body: { done: !t.done_at } }); rerender(); } catch (err) { showError(err); }
  }));
  el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/todos/${b.dataset.del}`, { method: 'DELETE' }); rerender(); } catch (err) { showError(err); }
  }));
}
