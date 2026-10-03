import { api, confirmDialog, esc, field, fmtDate, input, openModal, qs, showError, textarea, toast, todayISO } from '../lib.js';

// Time off: your holiday requests and usual availability; for managers, approving requests and the team's availability.

const STATUS = { pending: 'Waiting', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' };
const BADGE = { pending: 'in_progress', approved: 'completed', declined: 'fail', cancelled: 'draft' };
const badge = (s) => `<span class="badge badge-${BADGE[s]}">${STATUS[s]}</span>`;
const range = (r) => (r.start_date === r.end_date ? fmtDate(r.start_date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  : `${fmtDate(r.start_date, { weekday: 'short', day: 'numeric', month: 'short' })} – ${fmtDate(r.end_date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`);
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

function tabs(state, active) {
  const items = [['mine', 'My holiday'], ['availability', 'My availability']];
  if (state.can('leave.manage')) items.push(['requests', 'Holiday requests'], ['team', 'Team availability']);
  return `<div class="tabs">${items.map(([k, l]) => `<a href="#/timeoff${k === 'mine' ? '' : qs({ tab: k })}" class="${active === k ? 'active' : ''}">${l}</a>`).join('')}</div>`;
}

export async function render(ctx) {
  const tab = ctx.query.tab ?? 'mine';
  if (tab === 'availability') return renderAvailability(ctx);
  if (tab === 'requests' && ctx.state.can('leave.manage')) return renderRequests(ctx);
  if (tab === 'team' && ctx.state.can('leave.manage')) return renderTeam(ctx);
  return renderMine(ctx);
}

// --- My holiday ---

async function renderMine(ctx) {
  const { el, state } = ctx;
  const data = await api('/leave/mine');
  if (ctx.stale()) return;
  const today = todayISO();
  const upcoming = data.requests.filter((r) => r.end_date >= today && ['pending', 'approved'].includes(r.status)).reverse();
  const past = data.requests.filter((r) => !upcoming.includes(r));

  el.innerHTML = `
    <div class="page-head"><h1>Time off</h1>
      <div class="actions"><button class="btn btn-primary" id="request">+ Request holiday</button></div></div>
    ${tabs(state, 'mine')}
    <div class="kpis">
      <div class="kpi"><span>Holiday booked in ${data.year}</span><strong>${days(data.booked_this_year)}</strong></div>
      <div class="kpi"><span>Waiting for approval</span><strong>${data.requests.filter((r) => r.status === 'pending').length}</strong></div>
    </div>
    <section class="card">
      <h2>Coming up</h2>
      ${upcoming.length ? `<ul class="plain-list leave-list">${upcoming.map((r) => `<li>
        <div><strong>${range(r)}</strong> <span class="muted">· ${days(r.days)}</span>${r.note ? `<small>${esc(r.note)}</small>` : ''}
          ${r.decision_note ? `<small>${esc(r.decided_by_name ?? 'Manager')}: ${esc(r.decision_note)}</small>` : ''}</div>
        <span class="leave-actions">${badge(r.status)}
          ${r.status === 'pending' || r.start_date > today ? `<button class="btn btn-small btn-ghost" data-cancel="${r.id}">Cancel</button>` : ''}</span>
      </li>`).join('')}</ul>` : '<p class="muted">No holiday booked. Use “Request holiday” to ask for time off.</p>'}
    </section>
    ${past.length ? `<section class="card">
      <h2>Past and other requests</h2>
      <ul class="plain-list leave-list">${past.map((r) => `<li>
        <div>${range(r)} <span class="muted">· ${days(r.days)}</span>${r.decision_note ? `<small>${esc(r.decided_by_name ?? 'Manager')}: ${esc(r.decision_note)}</small>` : ''}</div>
        ${badge(r.status)}</li>`).join('')}</ul>
    </section>` : ''}`;

  el.querySelector('#request').addEventListener('click', () => openModal({
    title: 'Request holiday',
    submitLabel: 'Send request',
    body: `<div class="row">${field('First day off', input('start_date', today, `type="date" min="${today}" required`))}
      ${field('Last day off', input('end_date', today, `type="date" min="${today}" required`))}</div>
      ${field('Note for your manager (optional)', textarea('note', ''))}
      <p class="small muted">Your manager will approve or decline it. Once approved you won’t be put on the rota on these days.</p>`,
    onSubmit: async (v) => {
      await api('/leave', { method: 'POST', body: v });
      toast('Holiday requested');
      ctx.rerender();
    },
  }));
  el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Cancel this holiday?', { confirmLabel: 'Cancel holiday', title: 'Cancel holiday' }))) return;
    try {
      await api(`/leave/${b.dataset.cancel}/cancel`, { method: 'POST' });
      toast('Holiday cancelled');
      ctx.rerender();
    } catch (err) { showError(err); }
  }));
}

// --- My availability ---

async function renderAvailability(ctx) {
  const { el, state } = ctx;
  const data = await api('/availability/mine');
  if (ctx.stale()) return;
  const row = (name, i) => {
    const d = data.days[i] ?? { status: 'any' };
    return `<div class="avail-row" data-day="${i}">
      <strong>${name}</strong>
      <select name="status" aria-label="${name}">
        <option value="any" ${d.status === 'any' ? 'selected' : ''}>Any time</option>
        <option value="some" ${d.status === 'some' ? 'selected' : ''}>Only between…</option>
        <option value="none" ${d.status === 'none' ? 'selected' : ''}>Not available</option>
      </select>
      <span class="avail-times" ${d.status === 'some' ? '' : 'hidden'}>
        <input type="time" name="from_time" value="${d.from_time ?? '09:00'}" aria-label="${name} from"> <span>and</span>
        <input type="time" name="to_time" value="${d.to_time ?? '17:00'}" aria-label="${name} until">
      </span>
    </div>`;
  };
  el.innerHTML = `
    <div class="page-head"><h1>Time off</h1></div>
    ${tabs(state, 'availability')}
    <form class="card" id="avail">
      <h2>When can you usually work?</h2>
      <p class="muted small">This helps your manager plan the rota. For one-off days off, request holiday instead.</p>
      ${data.weekdays.map(row).join('')}
      ${field('Anything else your manager should know (optional)', textarea('note', data.note ?? '', 'placeholder="e.g. school run until 9:15 on weekdays"'))}
      <button class="btn btn-primary" type="submit">Save availability</button>
    </form>`;
  const form = el.querySelector('#avail');
  form.querySelectorAll('.avail-row select').forEach((s) => s.addEventListener('change', () => {
    s.closest('.avail-row').querySelector('.avail-times').hidden = s.value !== 'some';
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const days = [...form.querySelectorAll('.avail-row')].map((r) => ({
      weekday: Number(r.dataset.day),
      status: r.querySelector('[name=status]').value,
      from_time: r.querySelector('[name=from_time]').value,
      to_time: r.querySelector('[name=to_time]').value,
    }));
    try {
      await api('/availability/mine', { method: 'PUT', body: { days, note: form.note.value } });
      toast('Availability saved');
    } catch (err) { showError(err); }
  });
}

// --- Holiday requests (managers) ---

async function renderRequests(ctx) {
  const { el, state, query } = ctx;
  const status = query.status ?? 'pending';
  const rows = await api(`/leave${qs({ status })}`);
  if (ctx.stale()) return;
  const views = [['pending', 'Waiting'], ['upcoming', 'Approved, coming up'], ['past', 'Past and declined']];

  el.innerHTML = `
    <div class="page-head"><h1>Time off</h1></div>
    ${tabs(state, 'requests')}
    <div class="filters">${views.map(([k, l]) => `<a class="btn ${status === k ? 'btn-primary' : ''}" href="#/timeoff${qs({ tab: 'requests', status: k })}">${l}</a>`).join('')}</div>
    <section class="card">
      ${rows.length ? `<ul class="plain-list leave-list">${rows.map((r) => `<li>
        <div><strong>${esc(r.user_name)}</strong> <span class="muted">${esc(r.location_name ?? '')}</span>
          <div>${range(r)} <span class="muted">· ${days(r.days)}</span></div>
          ${r.note ? `<small>“${esc(r.note)}”</small>` : ''}
          ${r.shifts.length ? `<small class="tone-warn">On the rota for ${r.shifts.length} shift${r.shifts.length === 1 ? '' : 's'} then: ${r.shifts.slice(0, 3).map((s) => `${fmtDate(s.date)} ${s.start_time}–${s.end_time} (${esc(s.location_name)})`).join(', ')}${r.shifts.length > 3 ? '…' : ''}</small>` : ''}
          ${r.decision_note ? `<small>${esc(r.decided_by_name ?? '')}: ${esc(r.decision_note)}</small>` : ''}</div>
        <span class="leave-actions">
          ${r.status === 'pending' ? `<button class="btn btn-small" data-decide="${r.id}" data-status="declined">Decline</button>
            <button class="btn btn-small btn-primary" data-decide="${r.id}" data-status="approved">Approve</button>` : badge(r.status)}
        </span></li>`).join('')}</ul>` : `<p class="muted">${status === 'pending' ? 'No holiday requests waiting.' : 'Nothing here.'}</p>`}
    </section>`;

  el.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', () => {
    const r = rows.find((x) => x.id === Number(b.dataset.decide));
    const approve = b.dataset.status === 'approved';
    openModal({
      title: `${approve ? 'Approve' : 'Decline'} ${r.user_name}’s holiday`,
      submitLabel: approve ? 'Approve' : 'Decline',
      body: `<p><strong>${range(r)}</strong> · ${days(r.days)}</p>
        ${approve && r.shifts.length ? `<p class="notice">${esc(r.user_name)} is on the rota for ${r.shifts.length} shift${r.shifts.length === 1 ? '' : 's'} during this holiday. Remember to move ${r.shifts.length === 1 ? 'it' : 'them'} on the rota.</p>` : ''}
        ${field('Note (optional, they’ll see it)', textarea('note', ''))}`,
      onSubmit: async (v) => {
        await api(`/leave/${r.id}/decide`, { method: 'POST', body: { status: b.dataset.status, note: v.note } });
        toast(approve ? 'Holiday approved' : 'Holiday declined');
        ctx.rerender();
      },
    });
  }));
}

// --- Team availability (managers) ---

async function renderTeam(ctx) {
  const { el, state } = ctx;
  const data = await api('/availability');
  if (ctx.stale()) return;
  const cell = (d) => (!d ? '<td class="avail-any">Any time</td>'
    : d.status === 'none' ? '<td class="avail-none">Not available</td>'
      : `<td class="avail-some">${d.from_time}–${d.to_time}</td>`);
  let site = null;
  el.innerHTML = `
    <div class="page-head"><h1>Time off</h1></div>
    ${tabs(state, 'team')}
    <section class="card">
      <h2>Usual availability</h2>
      <div class="table-wrap"><table class="avail-table">
        <thead><tr><th>Person</th>${data.weekdays.map((w) => `<th>${w.slice(0, 3)}</th>`).join('')}<th>Holiday (next 4 weeks)</th></tr></thead>
        <tbody>${data.people.map((p) => {
          const group = p.location_name !== site ? `<tr class="avail-group"><th colspan="${data.weekdays.length + 2}">${esc(p.location_name ?? 'No home site')}</th></tr>` : '';
          site = p.location_name;
          return `${group}<tr><th>${esc(p.name)}${p.note ? `<small>${esc(p.note)}</small>` : ''}</th>
            ${data.weekdays.map((_, i) => cell(p.days[i])).join('')}
            <td class="small">${p.holiday.map((h) => (h.start_date === h.end_date ? fmtDate(h.start_date) : `${fmtDate(h.start_date)} – ${fmtDate(h.end_date)}`)).join('<br>') || '<span class="muted">–</span>'}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      <p class="muted small">Everyone sets this themselves under Time off → My availability. It’s shown on the rota too.</p>
    </section>`;
}
