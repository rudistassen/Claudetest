import { addDays, api, confirmDialog, esc, field, fmtDate, fmtDateTime, openModal, qs, showError, statusBadge, textarea, toast, todayISO } from '../lib.js';

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
      <h1>Food safety</h1>
      <div class="actions">
        <button class="btn" data-day="-1">‹</button>
        <input type="date" id="check-date" value="${date}" max="${todayISO()}">
        <button class="btn" data-day="1" ${isToday ? 'disabled' : ''}>›</button>
        ${state.can('safety.report') ? '<a class="btn" href="#/safety/report">Compliance report</a>' : ''}
      </div>
    </div>
    ${!isToday ? `<p class="notice">You are recording checks for ${fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}. Late entries are time-stamped.</p>` : ''}
    ${section(`Daily checks · ${fmtDate(date)}`, daily, state)}
    ${section(`Weekly checks · week of ${fmtDate(data.week_start)}`, weekly, state)}
    ${!data.tasks.length ? '<div class="empty">No food safety checks are set up for this location.</div>' : ''}`;

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
  const scope = state.isAdmin ? (query.scope ?? 'all') : 'site';
  const data = await api(`/safety/report${qs({ from, to, location_id: scope === 'all' ? undefined : state.locationId })}`);
  if (stale()) return;

  const cell = (r) => {
    if (!r.due) return '<td class="cell-na">–</td>';
    const tone = r.done === r.due ? (r.fails ? 'warn' : 'good') : r.done ? 'warn' : 'bad';
    return `<td class="cell-${tone}" title="${r.done}/${r.due} done${r.fails ? `, ${r.fails} failed` : ''}">${r.done}/${r.due}${r.fails ? ' ⚠' : ''}</td>`;
  };

  el.innerHTML = `
    <div class="page-head">
      <h1>Food safety compliance</h1>
      <form class="actions" id="range">
        ${state.isAdmin ? `<select name="scope"><option value="all" ${scope === 'all' ? 'selected' : ''}>All sites</option><option value="site" ${scope === 'site' ? 'selected' : ''}>${esc(state.location?.name ?? 'This site')}</option></select>` : ''}
        <input type="date" name="from" value="${from}"> <span>to</span> <input type="date" name="to" value="${to}" max="${todayISO()}">
        <button class="btn" type="submit">Update</button>
        <button class="btn" type="button" id="print">Print</button>
      </form>
    </div>
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
