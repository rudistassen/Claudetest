import { api, esc, field, fmtDate, openModal, qs, siteColour, siteFilter, siteScope, textarea, toast } from '../lib.js';

// Sickness: a shift can be marked as the person being off sick, from the rota or the dashboard. It stays on the
// rota but doesn't count as hours, labour cost or a missed clock-in. Reporting → Sickness lists it all.

/**
 * Mark a shift as sickness, or take the mark off.
 * s: { shift_id, name, date?, rota ('07:00–15:00'), sick, note }
 */
export function sickDialog(s, done) {
  const when = `${s.date ? `${fmtDate(s.date)} · ` : ''}${s.rota}`;
  openModal({
    title: s.sick ? `${s.name} – off sick` : `Mark ${s.name} as sick?`,
    body: `<p><strong>${esc(when)}</strong></p>
      <p class="muted small">${s.sick ? 'This shift is marked as sickness: it stays on the rota but doesn’t count as hours, labour cost or a missed clock-in.'
        : 'The shift stays on the rota, marked as sickness. It won’t count as hours, labour cost or a missed clock-in, and it’s recorded in Reporting → Sickness.'}</p>
      ${field('Note (optional)', textarea('note', s.note ?? '', 'maxlength="500" placeholder="e.g. Called in at 7am – stomach bug"'))}`,
    submitLabel: s.sick ? 'Save note' : 'Mark as sick',
    onSubmit: async (v) => {
      await api(`/shifts/${s.shift_id}/sickness`, { method: 'POST', body: { sick: true, note: v.note } });
      toast(s.sick ? 'Note saved' : `${s.name} marked as sick`);
      done();
    },
    danger: s.sick ? 'Not sick after all' : null,
    onDanger: async () => {
      await api(`/shifts/${s.shift_id}/sickness`, { method: 'POST', body: { sick: false } });
      toast('Sickness taken off – the shift counts again');
      done();
    },
  });
}

/** Wires every [data-sick-shift] element in el to open sickDialog (data-name, data-date, data-rota, data-sick, data-note). */
export function wireSickButtons(el, done) {
  el.querySelectorAll('[data-sick-shift]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const d = b.dataset;
    sickDialog({ shift_id: Number(d.sickShift), name: d.name, date: d.date || null, rota: d.rota, sick: d.sick === '1', note: d.note || '' }, done);
  }));
}

/** The data-* attributes for wireSickButtons. */
export const sickAttrs = (s) => `data-sick-shift="${s.shift_id}" data-name="${esc(s.name)}" data-rota="${esc(s.rota)}"${s.date ? ` data-date="${esc(s.date)}"` : ''}${s.sick ? ' data-sick="1"' : ''}${s.note ? ` data-note="${esc(s.note)}"` : ''}`;

const PERIODS = [[30, 'Last 30 days'], [90, 'Last 90 days'], [182, 'Last 6 months'], [365, 'Last 12 months']];
const hrs = (h) => `${Number(h).toLocaleString('en-GB', { maximumFractionDigits: 2 })} h`;
const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n + 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
};

// Reporting → Sickness
export async function renderReport(ctx) {
  const { el, state, query, stale, navigate } = ctx;
  const scope = siteScope(state, query.scope);
  const days = PERIODS.some(([d]) => d === Number(query.days)) ? Number(query.days) : 90;
  const data = await api(`/reports/sickness${qs({ from: isoDaysAgo(days), location_id: scope === 'all' ? undefined : state.locationId })}`);
  if (stale()) return;
  const totalDays = data.people.reduce((n, p) => n + p.days, 0);
  const totalHours = data.shifts.reduce((n, s) => n + s.hours, 0);
  const multi = state.multiSite && scope === 'all';

  el.innerHTML = `
    <div class="page-head"><h1>Sickness</h1></div>
    <form class="filters" id="sk-filters">
      ${siteFilter(state, scope)}
      <select name="days" aria-label="Period">${PERIODS.map(([d, l]) => `<option value="${d}" ${d === days ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </form>
    <div class="kpis">
      <div class="kpi" data-icon="✚"><span>Days off sick</span><strong>${totalDays}</strong><small>${data.people.length} ${data.people.length === 1 ? 'person' : 'people'}</small></div>
      <div class="kpi" data-icon="◷"><span>Hours off sick</span><strong>${hrs(totalHours)}</strong><small>${data.shifts.length} shift${data.shifts.length === 1 ? '' : 's'}</small></div>
    </div>
    <section class="card">
      <h2>By person</h2>
      ${data.people.length ? `<div class="table-wrap"><table class="sick-people">
        <thead><tr><th>Person</th><th class="num">Days</th><th class="num">Hours</th><th>Last off sick</th></tr></thead>
        <tbody>${data.people.map((p) => `<tr><td><strong>${esc(p.name)}</strong></td><td class="num">${p.days}</td><td class="num">${hrs(p.hours)}</td><td>${fmtDate(p.last)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">Nobody has been off sick in this time.</div>'}
    </section>
    ${data.shifts.length ? `<section class="card">
      <h2>Every sick shift</h2>
      <div class="table-wrap"><table class="sick-shifts">
        <thead><tr><th>Date</th><th>Person</th>${multi ? '<th>Site</th>' : ''}<th>Shift</th><th>Note</th></tr></thead>
        <tbody>${data.shifts.map((s) => `<tr>
          <td>${fmtDate(s.date)}</td>
          <td><strong>${esc(s.user_name)}</strong></td>
          ${multi ? `<td><span class="site-dot" style="--site: ${siteColour(s.location_name, s.location_id)}"></span>${esc(s.location_name)}</td>` : ''}
          <td>${s.start_time}–${s.end_time} <span class="muted">${hrs(s.hours)}</span></td>
          <td>${s.sick_note ? esc(s.sick_note) : '<span class="muted">–</span>'}${s.marked_by ? `<small class="muted">marked by ${esc(s.marked_by)}</small>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>` : ''}
    <p class="muted small">Mark someone as sick by tapping their shift on the rota, or their name on the dashboard. Sick shifts stay on the rota but don’t count as hours or labour cost.</p>`;

  const form = el.querySelector('#sk-filters');
  form.addEventListener('submit', (e) => { e.preventDefault(); navigate(`sickness${qs({ scope: form.scope?.value, days: form.days.value === '90' ? undefined : form.days.value })}`); });
  form.days.addEventListener('change', () => form.requestSubmit());
}

