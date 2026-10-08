import { addDays, api, esc, fmtDate, qs, siteFilter, siteScope, todayISO } from '../lib.js';
import { downloadFile, toCsv } from './product-import.js';

// Rota → Rota changes: an audit log of who added, changed, removed or published shifts, and when.

export const ACTIONS = {
  add: ['Added', 'log-add'],
  change: ['Changed', 'log-change'],
  remove: ['Removed', 'log-remove'],
  restore: ['Put back', 'log-add'],
  publish_shift: ['Published shift', 'log-publish'],
  publish: ['Published rota', 'log-publish'],
  discard: ['Discarded changes', 'log-remove'],
  copy: ['Copied week', 'log-change'],
  timecard_site: ['Clock-in moved', 'log-change'],
  timecard_breaks: ['Breaks changed', 'log-change'],
  drop: ['Shift dropped', 'log-remove'],
  drop_decline: ['Drop declined', 'log-change'],
  holiday: ['Holiday', 'log-publish'],
  undo: ['Undone', 'log-change'],
  sick: ['Sickness', 'log-change'],
  open: ['Open shift added', 'log-add'],
  claim: ['Open shift picked up', 'log-add'],
  withdraw: ['Open shift withdrawn', 'log-remove'],
};
const FILTERS = [['', 'All changes'], ['add', 'Added'], ['change', 'Changed'], ['remove', 'Removed'], ['restore', 'Put back'], ['publish', 'Published'], ['discard', 'Discarded'], ['copy', 'Copied week'], ['drop', 'Drop requests'], ['open', 'Open shifts added'], ['claim', 'Picked up'], ['holiday', 'Holiday'], ['sick', 'Sickness'], ['timecard_site', 'Clock-ins moved'], ['timecard_breaks', 'Breaks changed']];

const when = (at) => new Date(`${at.replace(' ', 'T')}Z`);
const dateFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'Europe/London' });
export const whenText = (at) => `${dateFmt.format(when(at))}, ${timeFmt.format(when(at))}`;
export const actionBadge = (a) => `<span class="log-badge ${ACTIONS[a]?.[1] ?? ''}">${ACTIONS[a]?.[0] ?? esc(a)}</span>`;

// A spreadsheet of the entries shown, for keeping or sending on.
const csv = (entries) => toCsv([['When', 'Changed by', 'Change', 'Site', 'Staff member', 'Shift date', 'Details']]
  .concat(entries.map((e) => [whenText(e.at), e.actor_name, ACTIONS[e.action]?.[0] ?? e.action, e.location_name ?? '', e.staff_name ?? '', e.shift_date ?? '', e.details])));

export async function render(ctx) {
  const { el, state, query, stale, navigate } = ctx;
  const to = query.to ?? todayISO();
  const from = query.from ?? addDays(to, -13);
  const scope = siteScope(state, query.scope);
  const data = await api(`/rota/log${qs({ from, to, location_id: scope === 'all' ? undefined : state.locationId, staff_id: query.staff, action: query.action })}`);
  if (stale()) return;
  const showSite = scope === 'all' && state.multiSite;

  el.innerHTML = `
    <div class="page-head">
      <h1>Rota changes</h1>
      <div class="actions">
        ${data.entries.length ? '<button class="btn" id="csv">Download spreadsheet</button>' : ''}
        <a class="btn" href="#/rota">‹ Rota</a>
      </div>
    </div>
    <form class="filters" id="log-filters">
      <input type="date" name="from" value="${from}" max="${todayISO()}" aria-label="Changes from">
      <input type="date" name="to" value="${to}" max="${todayISO()}" aria-label="Changes to">
      ${siteFilter(state, scope)}
      <select name="staff" aria-label="Staff member"><option value="">Everyone</option>
        ${data.people.map((p) => `<option value="${p.id}" ${String(p.id) === query.staff ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <select name="action" aria-label="Kind of change">${FILTERS.map(([v, l]) => `<option value="${v}" ${v === (query.action ?? '') ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn">Show</button>
    </form>
    <section class="card">
      ${data.entries.length ? `<div class="table-wrap"><table class="rota-log">
        <thead><tr><th>When</th><th>Changed by</th><th>Change</th>${showSite ? '<th>Site</th>' : ''}<th>Staff member</th><th>Details</th></tr></thead>
        <tbody>${data.entries.map((e) => `<tr>
          <td class="log-when">${whenText(e.at)}</td>
          <td><strong>${esc(e.actor_name)}</strong></td>
          <td>${actionBadge(e.action)}</td>
          ${showSite ? `<td>${esc(e.location_name ?? '')}</td>` : ''}
          <td>${esc(e.staff_name ?? '')}${e.shift_date ? `<small class="muted">${fmtDate(e.shift_date)}</small>` : ''}</td>
          <td>${esc(e.details)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      ${data.more ? '<p class="muted small">Showing the latest 1,000 changes – narrow the dates to see earlier ones.</p>' : ''}`
      : '<p class="muted">No rota changes in these dates.</p>'}
      <p class="muted small">Every shift added, changed, removed, put back or published, every week copied or discarded, and every holiday and shift-drop decision, with who did it and when (UK time). Changes made before this log started aren’t included.</p>
    </section>`;

  const form = el.querySelector('#log-filters');
  const go = () => navigate(`rota/log${qs({ from: form.from.value, to: form.to.value, scope: form.scope?.value, staff: form.staff.value || undefined, action: form.action.value || undefined })}`);
  form.addEventListener('submit', (e) => { e.preventDefault(); go(); });
  form.staff.addEventListener('change', go);
  form.action.addEventListener('change', go);
  el.querySelector('#csv')?.addEventListener('click', () => downloadFile(`rota-changes-${from}-to-${to}.csv`, csv(data.entries)));
}

/** A shift's own history, for the shift window on the rota. */
export async function shiftHistory(shiftId) {
  const { entries } = await api(`/rota/log${qs({ shift_id: shiftId })}`);
  if (!entries.length) return '<p class="muted small">No changes recorded (changes made before the log started aren’t included).</p>';
  return `<ul class="log-list">${entries.map((e) => `<li>${actionBadge(e.action)} <strong>${esc(e.actor_name)}</strong>
    <span class="muted small">${whenText(e.at)}</span><br><span class="small">${esc(e.details)}</span></li>`).join('')}</ul>`;
}
