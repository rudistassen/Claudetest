import { api, esc, fmtDate, openModal, showError } from '../lib.js';

// "Who else is off?" next to a holiday request's Approve button: everyone else with holiday booked or asked for
// during those dates – the person's own site first.

const day = (d) => fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' });
const span = (r) => (r.start_date === r.end_date ? day(r.start_date) : `${day(r.start_date)} – ${day(r.end_date)}`);

export async function showWhoElseOff(requestId) {
  let data;
  try { data = await api(`/leave/${requestId}/others`); } catch (err) { showError(err); return; }
  const r = data.request;
  const row = (o) => `<li><div><strong>${esc(o.user_name)}</strong> · ${esc(span(o))} <span class="muted">(${o.days} day${o.days === 1 ? '' : 's'})</span>
      ${o.note ? `<small>“${esc(o.note)}”</small>` : ''}</div>
    <span class="badge ${o.status === 'approved' ? 'badge-received' : 'badge-sent'}">${o.status === 'approved' ? 'Booked' : 'Requested'}</span></li>`;
  const group = (title, list, empty) => `<h3 class="group-title">${esc(title)}</h3>
    ${list.length ? `<ul class="drops-list who-off-list">${list.map(row).join('')}</ul>` : `<p class="muted small">${esc(empty)}</p>`}`;
  openModal({
    title: `Who else is off · ${span(r)}`,
    body: `<p class="muted">Holiday booked or asked for by anyone else while ${esc(r.user_name)} would be off.</p>
      ${group(r.location_name ? `At ${r.location_name}` : 'At the same site', data.same_site, 'Nobody else at this site is off then.')}
      ${data.other_sites.length ? group('At other sites', data.other_sites, '') : ''}`,
  });
}
