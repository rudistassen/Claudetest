import { addDays, api, confirmDialog, esc, field, fmtDate, fmtDateTime, input, openModal, qs, select, showError, statusBadge, textarea, toast, todayISO, siteScope, siteFilter, sitePicker } from '../lib.js';

// Trail: food-safety checklists, the compliance report and setting up checks for each site.
function trailTabs(state, active) {
  const items = [['safety', 'Checklist', true], ['safety/report', 'Compliance report', state.can('safety.report')], ['safety/setup', 'Set up', state.can('safety.manage')]]
    .filter(([, , ok]) => ok);
  return items.length > 1 ? `<div class="tabs trail-tabs">${items.map(([p, l]) => `<a href="#/${p}" class="${active === p ? 'active' : ''}">${l}</a>`).join('')}</div>` : '';
}

function rangeText(t) {
  const u = t.reading_unit ?? '';
  if (t.min_value !== null && t.max_value !== null) return `${t.min_value}${u} to ${t.max_value}${u}`;
  if (t.min_value !== null) return `${t.min_value}${u} or above`;
  if (t.max_value !== null) return `${t.max_value}${u} or below`;
  return '';
}

const outOfRange = (t, v) => (t.min_value !== null && v < t.min_value) || (t.max_value !== null && v > t.max_value);

function taskRow(t, state) {
  const c = t.check;
  const range = t.requires_reading ? `<span class="range">Safe: ${esc(rangeText(t))}</span>` : '';
  let action;
  if (c) {
    action = `
      <div class="check-done">
        ${statusBadge(c.status)}
        ${c.reading !== null ? `<strong>${c.reading}${esc(t.reading_unit ?? '')}</strong>` : ''}
        <span class="muted">${esc(c.completed_by_name ?? '')} · ${fmtDateTime(c.completed_at)}</span>
        <button class="btn btn-small btn-ghost" data-redo="${t.id}">Redo</button>
        ${state.can('safety.manage') ? `<button class="btn btn-small btn-ghost" data-undo="${c.id}">Clear</button>` : ''}
      </div>
      ${c.corrective_action ? `<p class="corrective"><strong>Action taken:</strong> ${esc(c.corrective_action)}</p>` : ''}
      ${c.notes ? `<p class="muted small">${esc(c.notes)}</p>` : ''}`;
  } else if (t.requires_reading) {
    action = `
      <form class="reading-form" data-task="${t.id}">
        <input type="number" step="0.1" name="reading" placeholder="${esc(t.reading_unit ?? '')}" required aria-label="Reading">
        <button class="btn btn-primary btn-small" type="submit">Record</button>
      </form>`;
  } else {
    action = `
      <div class="check-actions">
        <button class="btn btn-primary btn-small" data-pass="${t.id}">✓ Done</button>
        <button class="btn btn-small" data-fail="${t.id}">Report issue</button>
      </div>`;
  }
  return `
    <li class="task ${c ? `task-${c.status}` : ''}">
      <div class="task-text"><strong>${esc(t.title)}</strong>${t.description ? `<small>${esc(t.description)}</small>` : ''}${range}</div>
      <div class="task-action">${action}</div>
    </li>`;
}

function section(title, tasks, state) {
  if (!tasks.length) return '';
  const groups = new Map();
  for (const t of tasks) groups.set(t.category, [...(groups.get(t.category) ?? []), t]);
  const done = tasks.filter((t) => t.check).length;
  return `
    <section class="card">
      <header class="card-head"><h2>${esc(title)}</h2><span class="pill ${done === tasks.length ? 'pill-good' : ''}">${done} / ${tasks.length}</span></header>
      ${[...groups].map(([cat, list]) => `<h3 class="group-title">${esc(cat)}</h3><ul class="task-list">${list.map((t) => taskRow(t, state)).join('')}</ul>`).join('')}
    </section>`;
}

export async function renderChecklist(ctx) {
  const { el, state, query, stale } = ctx;
  const date = query.date || todayISO();
  const data = await api(`/safety/checklist${qs({ location_id: state.locationId, date })}`);
  if (stale()) return;
  const daily = data.tasks.filter((t) => t.frequency === 'daily');
  const weekly = data.tasks.filter((t) => t.frequency === 'weekly');
  const isToday = date === todayISO();

  el.innerHTML = `
    <div class="page-head">
      <h1>Trail${state.multiSite ? '' : ` · ${esc(state.location?.name ?? '')}`}</h1>
      <div class="actions">
        ${sitePicker(state)}
        <button class="btn" data-day="-1">‹</button>
        <input type="date" id="check-date" value="${date}" max="${todayISO()}">
        <button class="btn" data-day="1" ${isToday ? 'disabled' : ''}>›</button>
      </div>
    </div>
    ${trailTabs(state, 'safety')}
    ${!isToday ? `<p class="notice">You are recording checks for ${fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}. Late entries are time-stamped.</p>` : ''}
    ${section(`Daily checks · ${fmtDate(date)}`, daily, state)}
    ${section(`Weekly checks · week of ${fmtDate(data.week_start)}`, weekly, state)}
    ${!data.tasks.length ? `<div class="empty">No checks are set up for this site.${state.can('safety.manage') ? ' <a href="#/safety/setup">Set them up</a>' : ''}</div>` : ''}`;

  const go = (d) => ctx.navigate(`safety${d === todayISO() ? '' : `?date=${d}`}`);
  el.querySelector('#check-date').addEventListener('change', (e) => e.target.value && go(e.target.value));
  el.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => go(addDays(date, Number(b.dataset.day)))));

  const task = (id) => data.tasks.find((t) => t.id === Number(id));
  const submit = async (body) => {
    await api('/safety/checks', { method: 'POST', body: { location_id: state.locationId, date, ...body } });
    toast(body.status === 'fail' || body.corrective_action ? 'Issue recorded' : 'Check recorded');
    ctx.rerender();
  };

  const issueModal = (t, reading) => openModal({
    title: reading !== undefined ? 'Reading out of safe range' : 'Report an issue',
    body: `
      <p><strong>${esc(t.title)}</strong></p>
      ${reading !== undefined ? `<p class="alert-text">${reading}${esc(t.reading_unit ?? '')} is outside the safe range (${esc(rangeText(t))}).</p>` : ''}
      ${field('Corrective action taken', textarea('corrective_action', '', 'required placeholder="e.g. Moved stock to backup fridge, called engineer, discarded high-risk food"'))}
      ${field('Notes (optional)', textarea('notes', ''))}`,
    submitLabel: 'Record issue',
    onSubmit: (v) => submit({ task_id: t.id, reading, status: 'fail', corrective_action: v.corrective_action, notes: v.notes }),
  });

  const readingModal = (t) => openModal({
    title: t.title,
    body: `${field(`Reading (${t.reading_unit ?? ''}) – safe: ${rangeText(t)}`, `<input type="number" step="0.1" name="reading" required>`)}
      ${field('Corrective action (required if out of range)', textarea('corrective_action', ''))}
      ${field('Notes', textarea('notes', ''))}`,
    onSubmit: (v) => submit({ task_id: t.id, reading: v.reading, corrective_action: v.corrective_action, notes: v.notes }),
  });

  el.querySelectorAll('.reading-form').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = task(f.dataset.task);
    const reading = Number(f.reading.value);
    if (outOfRange(t, reading)) issueModal(t, reading);
    else submit({ task_id: t.id, reading }).catch(showError);
  }));
  el.querySelectorAll('[data-pass]').forEach((b) => b.addEventListener('click', () => submit({ task_id: Number(b.dataset.pass), status: 'pass' }).catch(showError)));
  el.querySelectorAll('[data-fail]').forEach((b) => b.addEventListener('click', () => issueModal(task(b.dataset.fail))));
  el.querySelectorAll('[data-redo]').forEach((b) => b.addEventListener('click', () => {
    const t = task(b.dataset.redo);
    if (t.requires_reading) readingModal(t);
    else openModal({
      title: t.title,
      body: `${field('Result', '<select name="status"><option value="pass">Pass</option><option value="fail">Issue found</option></select>')}
        ${field('Corrective action (required for issues)', textarea('corrective_action', t.check?.corrective_action))}
        ${field('Notes', textarea('notes', t.check?.notes))}`,
      onSubmit: (v) => submit({ task_id: t.id, status: v.status, corrective_action: v.corrective_action, notes: v.notes }),
    });
  }));
  el.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Clear this check so it can be completed again?', { confirmLabel: 'Clear' }))) return;
    try {
      await api(`/safety/checks/${b.dataset.undo}`, { method: 'DELETE' });
      ctx.rerender();
    } catch (err) { showError(err); }
  }));
}

export async function renderReport(ctx) {
  const { el, state, query, stale } = ctx;
  const to = query.to || todayISO();
  const from = query.from || addDays(to, -13);
  const scope = siteScope(state, query.scope);
  const data = await api(`/safety/report${qs({ from, to, location_id: scope === 'all' ? undefined : state.locationId })}`);
  if (stale()) return;

  const cell = (r) => {
    if (!r.due) return '<td class="cell-na">–</td>';
    const tone = r.done === r.due ? (r.fails ? 'warn' : 'good') : r.done ? 'warn' : 'bad';
    return `<td class="cell-${tone}" title="${r.done}/${r.due} done${r.fails ? `, ${r.fails} failed` : ''}">${r.done}/${r.due}${r.fails ? ' ⚠' : ''}</td>`;
  };

  el.innerHTML = `
    <div class="page-head">
      <h1>Trail compliance</h1>
      <form class="actions" id="range">
        ${siteFilter(state, scope)}
        <input type="date" name="from" value="${from}"> <span>to</span> <input type="date" name="to" value="${to}" max="${todayISO()}">
        <button class="btn" type="submit">Update</button>
        <button class="btn" type="button" id="print">Print</button>
      </form>
    </div>
    ${trailTabs(state, 'safety/report')}
    <section class="card">
      <h2>Daily checks completed</h2>
      <div class="table-wrap">
        <table class="grid-table">
          <thead><tr><th>Site</th><th>Overall</th>${data.days.map((d) => `<th>${fmtDate(d, { day: 'numeric', month: 'short' })}</th>`).join('')}</tr></thead>
          <tbody>${data.locations.map((l) => `<tr><th>${esc(l.name)}</th><td><strong>${Math.round(l.compliance_pct)}%</strong></td>${l.days.map(cell).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
      <h2 class="spaced">Weekly checks completed</h2>
      <div class="table-wrap">
        <table class="grid-table">
          <thead><tr><th>Site</th>${data.weeks.map((w) => `<th>w/c ${fmtDate(w, { day: 'numeric', month: 'short' })}</th>`).join('')}</tr></thead>
          <tbody>${data.locations.map((l) => `<tr><th>${esc(l.name)}</th>${l.weeks.map(cell).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
    </section>
    <section class="card">
      <h2>Failed checks and corrective actions (${data.failures.length})</h2>
      ${data.failures.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Site</th><th>Check</th><th>Reading</th><th>Corrective action</th><th>By</th></tr></thead>
        <tbody>${data.failures.map((f) => `<tr>
          <td>${f.frequency === 'weekly' ? 'w/c ' : ''}${fmtDate(f.period)}</td><td>${esc(f.location_name)}</td><td>${esc(f.title)}</td>
          <td>${f.reading !== null ? `${f.reading}${esc(f.reading_unit ?? '')}` : '–'}</td>
          <td>${esc(f.corrective_action)}</td><td>${esc(f.completed_by_name ?? '')}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No failed checks in this period.</p>'}
    </section>`;

  el.querySelector('#range').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    ctx.navigate(`safety/report${qs({ from: f.from.value, to: f.to.value, scope: f.scope?.value })}`);
  });
  el.querySelector('#print').addEventListener('click', () => window.print());
}

// --- Set up: the checks each site does ---

const WHEN = { daily: 'Daily', weekly: 'Weekly' };

export async function renderSetup(ctx) {
  const { el, state, query, stale } = ctx;
  const active = state.locations.filter((l) => l.active);
  const siteId = active.find((l) => String(l.id) === query.site)?.id ?? state.locationId;
  const data = await api(`/safety/setup${qs({ location_id: siteId })}`);
  if (stale()) return;
  const site = active.find((l) => l.id === siteId);
  const cats = [...new Set(data.tasks.map((t) => t.category))];
  const tag = (t) => (t.scope === 'shared'
    ? (t.on_here ? '<span class="badge badge-sent">Every site</span>' : '<span class="badge badge-draft">Off here</span>')
    : t.replaces_task_id ? `<span class="badge badge-in_progress">Changed for ${esc(site?.name ?? 'this site')}</span>`
      : `<span class="badge badge-completed">${esc(site?.name ?? 'This site')} only</span>${t.active ? '' : ' <span class="badge badge-draft">Off</span>'}`);
  const row = (t) => {
    const hidden = t.scope === 'shared' && t.replaced_by; // replaced here by the site's own version, shown instead
    if (hidden) return '';
    const actions = t.scope === 'shared'
      ? `<button class="btn btn-small" data-customise="${t.id}">Change for this site</button>
         <button class="btn btn-small btn-ghost" data-toggle="${t.id}" data-on="${t.on_here ? 0 : 1}">${t.on_here ? 'Turn off here' : 'Turn on here'}</button>
         ${state.isAdmin ? `<button class="btn btn-small btn-ghost" data-edit="${t.id}">Edit for every site</button>` : ''}`
      : `<button class="btn btn-small" data-edit="${t.id}">Edit</button>
         ${t.replaces_task_id ? `<button class="btn btn-small btn-ghost" data-revert="${t.id}">Use the shared version</button>`
           : `<button class="btn btn-small btn-ghost" data-toggle-own="${t.id}" data-on="${t.active ? 0 : 1}">${t.active ? 'Turn off' : 'Turn on'}</button>`}`;
    return `<li class="setup-task ${t.on_here ? '' : 'is-off'}">
      <div><strong>${esc(t.title)}</strong> ${tag(t)}
        <small>${WHEN[t.frequency]}${t.requires_reading ? ` · reading, safe ${esc(rangeText(t)) || 'any value'}` : ''}${t.replaces_title ? ` · instead of “${esc(t.replaces_title)}”` : ''}</small>
        ${t.description ? `<small>${esc(t.description)}</small>` : ''}</div>
      <span class="setup-actions">${actions}</span></li>`;
  };

  el.innerHTML = `
    <div class="page-head">
      <h1>Trail · Set up</h1>
      <div class="actions">
        ${active.length > 1 ? `<select id="setup-site" aria-label="Site">${active.map((l) => `<option value="${l.id}" ${l.id === siteId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>` : ''}
        <button class="btn btn-primary" id="add">+ Add check</button>
      </div>
    </div>
    ${trailTabs(state, 'safety/setup')}
    <p class="muted">The checks ${esc(site?.name ?? 'this site')} does. Shared checks are the same at every site: change one for just this site, or turn it off here, without affecting the others.</p>
    ${['daily', 'weekly'].map((freq) => {
      const list = data.tasks.filter((t) => t.frequency === freq);
      return `<section class="card">
        <h2>${WHEN[freq]} checks</h2>
        ${list.length ? cats.filter((c) => list.some((t) => t.category === c)).map((c) => `<h3 class="group-title">${esc(c)}</h3>
          <ul class="plain-list setup-list">${list.filter((t) => t.category === c).map(row).join('')}</ul>`).join('') : '<p class="muted">None yet.</p>'}
      </section>`;
    }).join('')}`;

  const byId = (id) => data.tasks.find((t) => t.id === Number(id));
  const form = (t, { forEverySite = false } = {}) => `
    ${field('Check', input('title', t.title, 'required'))}
    ${field('Instructions', textarea('description', t.description))}
    <div class="row">
      ${field('Category', input('category', t.category ?? 'General', 'list="task-cats"'))}
      ${field('How often', select('frequency', [['daily', 'Daily'], ['weekly', 'Weekly']], t.frequency ?? 'daily'))}
      ${forEverySite === null ? field('For', select('scope', [['site', `${site?.name ?? 'This site'} only`], ['all', 'Every site']], 'site')) : ''}
    </div>
    <datalist id="task-cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    ${field('Needs a reading (e.g. a temperature)', `<input type="checkbox" name="requires_reading" ${t.requires_reading ? 'checked' : ''}>`, { className: 'field-inline' })}
    <div class="row">
      ${field('Unit', input('reading_unit', t.reading_unit ?? '°C'))}
      ${field('Lowest safe value', input('min_value', t.min_value, 'type="number" step="any"'))}
      ${field('Highest safe value', input('max_value', t.max_value, 'type="number" step="any"'))}
    </div>
    ${field('Order in the list', input('sort_order', t.sort_order ?? 0, 'type="number"'), { hint: 'Lower numbers come first' })}`;
  const done = (msg) => { toast(msg); ctx.rerender(); };

  el.querySelector('#setup-site')?.addEventListener('change', (e) => ctx.navigate(`safety/setup${qs({ site: e.target.value })}`));
  el.querySelector('#add').addEventListener('click', () => openModal({
    title: `Add a check`,
    wide: true,
    body: form({}, { forEverySite: state.isAdmin ? null : false }),
    onSubmit: async (v) => {
      const every = v.scope === 'all';
      delete v.scope;
      await api('/safety/tasks', { method: 'POST', body: { ...v, location_id: every ? null : siteId } });
      done(every ? 'Check added for every site' : `Check added for ${site?.name ?? 'this site'}`);
    },
  }));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const t = byId(b.dataset.edit);
    openModal({
      title: t.scope === 'shared' ? `Edit “${t.title}” for every site` : `Edit “${t.title}”`,
      wide: true,
      body: `${t.scope === 'shared' ? '<p class="notice">This changes the check at every site that uses it.</p>' : ''}${form(t)}`,
      danger: t.scope === 'site' && !t.replaces_task_id ? (t.has_history ? 'Remove (keeps its history)' : 'Delete check') : null,
      onDanger: async () => {
        const r = await api(`/safety/tasks/${t.id}`, { method: 'DELETE' });
        done(r.deleted ? 'Check deleted' : 'Check turned off (its past records are kept)');
      },
      onSubmit: async (v) => {
        await api(`/safety/tasks/${t.id}`, { method: 'PUT', body: { ...v, location_id: t.location_id, active: t.scope === 'site' ? !!t.active : true } });
        done('Check saved');
      },
    });
  }));
  el.querySelectorAll('[data-customise]').forEach((b) => b.addEventListener('click', () => {
    const t = byId(b.dataset.customise);
    openModal({
      title: `Change “${t.title}” for ${site?.name ?? 'this site'}`,
      wide: true,
      submitLabel: 'Save for this site',
      body: `<p class="small muted">${esc(site?.name ?? 'This site')} gets its own version; other sites keep the shared one. You can go back to the shared version at any time.</p>${form(t)}`,
      onSubmit: async (v) => {
        await api(`/safety/tasks/${t.id}/customise`, { method: 'POST', body: { ...v, location_id: siteId } });
        done(`Changed for ${site?.name ?? 'this site'}`);
      },
    });
  }));
  el.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/safety/tasks/${b.dataset.toggle}/at-site`, { method: 'POST', body: { location_id: siteId, on: b.dataset.on === '1' } });
      done(b.dataset.on === '1' ? 'Turned on at this site' : 'Turned off at this site');
    } catch (err) { showError(err); }
  }));
  el.querySelectorAll('[data-toggle-own]').forEach((b) => b.addEventListener('click', async () => {
    const t = byId(b.dataset.toggleOwn);
    try {
      await api(`/safety/tasks/${t.id}`, { method: 'PUT', body: { ...t, location_id: t.location_id, active: b.dataset.on === '1' } });
      done(b.dataset.on === '1' ? 'Check turned on' : 'Check turned off');
    } catch (err) { showError(err); }
  }));
  el.querySelectorAll('[data-revert]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Go back to the shared version of this check at this site? This site’s own version is removed (past records are kept).', { confirmLabel: 'Use shared version', title: 'Use the shared version' }))) return;
    try {
      await api(`/safety/tasks/${b.dataset.revert}/revert`, { method: 'POST' });
      done('Back to the shared version');
    } catch (err) { showError(err); }
  }));
}
