import { api, confirmDialog, esc, field, fmtDate, input, openModal, qs, showError, textarea, toast, todayISO } from '../lib.js';

// Time off: your holiday requests; for managers, approving them, and adding, changing or taking off people's holiday.

const STATUS = { pending: 'Waiting', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' };
const BADGE = { pending: 'in_progress', approved: 'completed', declined: 'fail', cancelled: 'draft' };
const badge = (s) => `<span class="badge badge-${BADGE[s]}">${STATUS[s]}</span>`;
const range = (r) => (r.start_date === r.end_date ? fmtDate(r.start_date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  : `${fmtDate(r.start_date, { weekday: 'short', day: 'numeric', month: 'short' })} – ${fmtDate(r.end_date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`);
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

function tabs(state, active) {
  const items = [['mine', 'My holiday']];
  if (state.can('leave.manage', 'leave.edit')) items.push(['requests', 'Team holiday']);
  return `<div class="tabs">${items.map(([k, l]) => `<a href="#/timeoff${k === 'mine' ? '' : qs({ tab: k })}" class="${active === k ? 'active' : ''}">${l}</a>`).join('')}</div>`;
}

export async function render(ctx) {
  const tab = ctx.query.tab ?? 'mine';
  // Availability has its own page (Rota → My availability); team availability is on Rota → Requests.
  if (tab === 'availability') return ctx.navigate(`availability${qs({ user: ctx.query.user, month: ctx.query.month })}`);
  if (tab === 'team') return ctx.navigate('rota/requests');
  if (tab === 'requests' && ctx.state.can('leave.manage', 'leave.edit')) return renderRequests(ctx);
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

// --- Holiday requests (managers) ---

async function renderRequests(ctx) {
  const { el, state, query } = ctx;
  const status = query.status ?? 'pending';
  const rows = await api(`/leave${qs({ status })}`);
  if (ctx.stale()) return;
  const views = [['pending', 'Waiting'], ['upcoming', 'Approved, coming up'], ['past', 'Past and declined']];
  // Approving requests (leave.manage) and changing people's holiday (leave.edit) are separate permissions.
  const canDecide = state.can('leave.manage');
  const canEdit = state.can('leave.edit');

  el.innerHTML = `
    <div class="page-head"><h1>Time off</h1><div class="actions">${canEdit ? '<button class="btn btn-primary" id="leave-add">+ Add holiday</button>' : ''}</div></div>
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
          ${r.status === 'pending' && canDecide ? `<button class="btn btn-small" data-decide="${r.id}" data-status="declined">Decline</button>
            <button class="btn btn-small btn-primary" data-decide="${r.id}" data-status="approved">Approve</button>` : badge(r.status)}
          ${r.status === 'approved' && canEdit ? `<button class="btn btn-small" data-edit-leave="${r.id}">Change dates</button>
            <button class="btn btn-small btn-ghost" data-remove-leave="${r.id}">Take off</button>` : ''}
        </span></li>`).join('')}</ul>` : `<p class="muted">${status === 'pending' ? 'No holiday requests waiting.' : 'Nothing here.'}</p>`}
    </section>`;

  // Add holiday for someone (approved straight away), change its dates, or take it off.
  const datesFields = (r) => `<div class="row">${field('First day', input('start_date', r?.start_date ?? todayISO(), 'type="date" required'))}
    ${field('Last day', input('end_date', r?.end_date ?? r?.start_date ?? todayISO(), 'type="date" required'))}</div>`;
  const afterSave = (res, verb) => {
    toast(`${verb}${res?.shifts_then ? ` – they’re on the rota for ${res.shifts_then} shift${res.shifts_then === 1 ? '' : 's'} then, so move ${res.shifts_then === 1 ? 'it' : 'them'}` : ''}`);
    ctx.rerender();
  };
  el.querySelector('#leave-add')?.addEventListener('click', async () => {
    try {
      const people = await api('/leave/people');
      const { form } = openModal({
        title: 'Add holiday',
        body: `${field('Who', `<select name="user_id" required><option value="">Choose who…</option>${people.map((p) => `<option value="${p.id}">${esc(p.name)}${p.location_name ? ` – ${esc(p.location_name)}` : ''}</option>`).join('')}</select>`)}
          ${datesFields(null)}
          ${field('Note (optional, they’ll see it)', textarea('note', '', 'maxlength="500" placeholder="e.g. Booked by phone"'))}
          <p class="muted small">It’s approved straight away and they get a notification. Past dates are fine, to record holiday already taken.</p>`,
        submitLabel: 'Add holiday',
        onSubmit: async (v) => afterSave(await api('/leave/add', { method: 'POST', body: v }), 'Holiday added'),
      });
      const [start, end] = [form.querySelector('[name=start_date]'), form.querySelector('[name=end_date]')];
      start.addEventListener('change', () => { if (!end.value || end.value < start.value) end.value = start.value; });
    } catch (err) { showError(err); }
  });
  el.querySelectorAll('[data-edit-leave]').forEach((b) => b.addEventListener('click', () => {
    const r = rows.find((x) => x.id === Number(b.dataset.editLeave));
    openModal({
      title: `Change ${r.user_name}’s holiday`,
      body: `<p class="muted">Now: ${range(r)} · ${days(r.days)}</p>${datesFields(r)}
        <p class="muted small">Make it shorter or longer, or move it. They’ll get a notification.</p>`,
      submitLabel: 'Save',
      onSubmit: async (v) => afterSave(await api(`/leave/${r.id}`, { method: 'PUT', body: { start_date: v.start_date, end_date: v.end_date } }), 'Holiday changed'),
    });
  }));
  el.querySelectorAll('[data-remove-leave]').forEach((b) => b.addEventListener('click', () => {
    const r = rows.find((x) => x.id === Number(b.dataset.removeLeave));
    openModal({
      title: `Take off ${r.user_name}’s holiday?`,
      body: `<p><strong>${range(r)}</strong> · ${days(r.days)}</p>${field('Note for them (optional)', textarea('note', '', 'maxlength="500"'))}
        <p class="muted small">It comes off their holiday and they can be put on the rota those days.</p>`,
      submitLabel: 'Take off',
      onSubmit: async (v) => { await api(`/leave/${r.id}/remove`, { method: 'POST', body: { note: v.note } }); toast('Holiday taken off'); ctx.rerender(); },
    });
  }));

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
