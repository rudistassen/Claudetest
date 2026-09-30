import { api, esc, fmtDate, money, qs, siteFilter, siteScope, todayISO, addDays } from '../lib.js';

// Breaks taken during Square clock-ins: shown on the dashboard, and as a report under Reporting → Breaks.

const FLAG = { none: 'No break', short: 'Short break' };
const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : `${Math.round(m)}m`);

/** "12:30–13:00 · 30m", with "paid" for a paid break and "now" for one still running. */
export const breakText = (b) => `${b.start}–${b.end ?? 'now'} · ${mins(b.minutes)}${b.paid ? ' paid' : ''}`;

/** The warning tag for a long shift without a proper break, or ''. */
export const breakFlag = (c) => (c.break_flag
  ? `<span class="chip chip-strong" title="Worked over 6 hours without a 20-minute break">⚠ ${FLAG[c.break_flag]}</span>` : '');

/** The breaks line under a person on the dashboard's clocked-in list. */
export function breakLine(c) {
  if (!c.breaks_known) return c.break_minutes ? `<span class="clock-breaks muted small">Breaks ${mins(c.break_minutes)}</span>` : '';
  if (!c.breaks.length && !c.break_flag) return '';
  return `<span class="clock-breaks small">${c.breaks.length ? `<span class="muted">Break ${c.breaks.map(breakText).join(', ')}</span>` : ''} ${breakFlag(c)}</span>`;
}

export async function render(ctx) {
  const { el, state, query, stale, navigate } = ctx;
  const to = query.to ?? todayISO();
  const from = query.from ?? addDays(to, -6);
  const scope = siteScope(state, query.scope);
  const onlyFlags = query.flags === '1';
  const data = await api(`/breaks${qs({ from, to, location_id: scope === 'all' ? undefined : state.locationId })}`);
  if (stale()) return;
  const t = data.totals;
  const rows = onlyFlags ? data.rows.filter((r) => r.break_flag) : data.rows;
  const allSites = scope === 'all' && state.multiSite;

  el.innerHTML = `
    <div class="page-head"><h1>Breaks</h1></div>
    <form class="filters" id="range">
      <input type="date" name="from" value="${from}" max="${todayISO()}" aria-label="From">
      <input type="date" name="to" value="${to}" max="${todayISO()}" aria-label="To">
      ${siteFilter(state, scope)}
      <label class="check-row"><input type="checkbox" name="flags" value="1" ${onlyFlags ? 'checked' : ''}><span>Only missed or short breaks</span></label>
      <button class="btn">Show</button>
    </form>
    ${data.labour_synced ? '' : '<p class="notice">Breaks come from Square: they appear once Square is connected and staff clock in and out on it.</p>'}
    <div class="kpis">
      <div class="kpi" data-icon="◷"><span>Clock-ins</span><strong>${t.shifts}</strong></div>
      <div class="kpi" data-icon="☕"><span>Breaks taken</span><strong>${t.breaks}</strong></div>
      <div class="kpi"><span>Total break time</span><strong>${mins(t.break_minutes)}</strong></div>
      <div class="kpi"><span>Paid break time</span><strong>${mins(t.paid_break_minutes)}</strong>${t.paid_break_cost ? `<small>${money(t.paid_break_cost)} paid</small>` : ''}</div>
      <div class="kpi ${t.flagged ? 'kpi-bad' : ''}" data-icon="!"><span>Over 6 hours without a proper break</span><strong>${t.flagged}</strong></div>
    </div>
    ${t.unknown ? `<p class="muted small">${t.unknown} clock-in${t.unknown === 1 ? ' was' : 's were'} synced before Brewly kept break details, so ${t.unknown === 1 ? 'its' : 'their'} breaks can’t be checked. Re-sync those days under Setup → Square to fill them in.</p>` : ''}
    <section class="card">
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Person</th>${allSites ? '<th>Site</th>' : ''}<th>Clocked</th><th class="num">Worked</th><th>Breaks</th><th class="num">Break time</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${fmtDate(r.date)}</td>
          <td><strong>${esc(r.name)}</strong></td>
          ${allSites ? `<td>${esc(r.location_name)}</td>` : ''}
          <td>${r.start}–${r.end ?? 'now'}</td>
          <td class="num">${mins(r.worked_minutes)}</td>
          <td>${r.breaks_known ? (r.breaks.length ? r.breaks.map((b) => `<span class="break-pill ${b.paid ? 'is-paid' : ''}">${breakText(b)}</span>`).join(' ') : '<span class="muted">None</span>') : '<span class="muted">Not known</span>'}${r.on_break ? ' <span class="badge badge-sent">On break</span>' : ''}</td>
          <td class="num">${mins(r.break_minutes)}</td>
          <td>${breakFlag(r)}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : `<p class="muted">${onlyFlags ? 'No missed or short breaks in these dates.' : 'Nobody clocked in on these dates.'}</p>`}
      <p class="muted small">From Square clock-ins: staff start and end a break on the Square till or app. Adults working more than 6 hours should get one unbroken break of at least 20 minutes.</p>
    </section>`;

  el.querySelector('#range').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    navigate(`breaks${qs({ from: f.from.value, to: f.to.value, scope: f.scope?.value, flags: f.flags.checked ? '1' : undefined })}`);
  });
  el.querySelector('input[name=flags]').addEventListener('change', (e) => e.target.form.requestSubmit());
}
