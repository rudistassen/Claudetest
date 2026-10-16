import { api, esc, fmtDate, money, qs, siteFilter, siteScope, todayISO } from '../lib.js';
import { chosenTimeframe, timeframe, timeframeBar, wireTimeframe } from './dashboard.js';

// Reporting → Timecards: every clock-in from Square, one row each – who, where, their rota shift, clock in and out,
// breaks and paid hours (and pay, for people who can see it). The same timeframe selector as the dashboards, a
// site filter and a search by name; downloads as a spreadsheet (CSV).

const TF_KEY = 'cafe-ops:timecards-timeframe';
const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : `${Math.round(m)}m`);
const hrs = (h) => Number(h).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// 26.98 → "26h 59m"
const hm = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };

export async function render({ el, state, query, stale, navigate }) {
  const today = todayISO();
  const tf = chosenTimeframe(query, TF_KEY, 'week');
  const t = timeframe(tf, query, today);
  const scope = siteScope(state, query.scope);
  const data = await api(`/reports/timecards${qs({ from: t.range.from, to: t.range.to, location_id: scope === 'all' ? undefined : state.locationId })}`);
  if (stale()) return;
  const multi = state.multiSite && scope === 'all';
  const late = (r) => (r.late_minutes === null ? '' : r.late_minutes > 5 ? `<span class="tc-flag tone-bad">${mins(r.late_minutes)} late</span>`
    : r.late_minutes < -15 ? `<span class="tc-flag muted">${mins(-r.late_minutes)} early</span>` : '');
  const row = (r) => `<tr data-name="${esc(r.name.toLowerCase())}">
      <td>${fmtDate(r.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
      <td><strong>${esc(r.name)}</strong></td>
      ${multi ? `<td>${esc(r.location_name ?? '')}</td>` : ''}
      <td>${r.rota ? esc(r.rota) : '<span class="muted">Not on the rota</span>'}</td>
      <td>${esc(r.start)}${late(r)}</td>
      <td>${r.open ? '<span class="badge badge-received">Still in</span>' : esc(r.end)}</td>
      <td>${r.break_minutes ? `${mins(r.break_minutes)}${r.paid_break_minutes ? ` <small class="muted">(${mins(r.paid_break_minutes)} paid)</small>` : ''}` : '–'}${r.break_flag ? ' <span class="tc-flag tone-bad" title="Over 6 hours without a 20-minute break">⚠</span>' : ''}</td>
      <td class="num">${hrs(r.hours)}</td>
      ${data.see_pay ? `<td class="num">${money(r.cost)}</td>` : ''}
    </tr>`;

  el.innerHTML = `
    <div class="page-head"><h1>Timecards</h1>
      <div class="actions">${data.rows.length ? '<button class="btn" id="tc-csv">Download CSV</button>' : ''}</div></div>
    ${timeframeBar(t, `${fmtDate(t.range.from, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmtDate(t.range.to, { day: 'numeric', month: 'short', year: 'numeric' })}`)}
    <form class="filters" id="tc-filters">${siteFilter(state, scope)}
      <input type="search" name="q" value="${esc(query.q ?? '')}" placeholder="Search by name" aria-label="Search by name" autocomplete="off">
    </form>
    ${!data.labour_synced ? '<div class="card empty">No clock-ins yet – they come from Square once it’s connected (Setup → Square).</div>' : `
    <div class="tc-totals" id="tc-totals"></div>
    <div class="tc-people" id="tc-people" hidden></div>
    ${data.rows.length ? `<section class="card"><div class="table-wrap"><table class="tc-table">
      <thead><tr><th>Date</th><th>Name</th>${multi ? '<th>Site</th>' : ''}<th>Rota</th><th>Clock in</th><th>Clock out</th><th>Breaks</th><th class="num">Paid hours</th>${data.see_pay ? '<th class="num">Pay</th>' : ''}</tr></thead>
      <tbody>${data.rows.map(row).join('')}</tbody>
      <tfoot><tr class="tc-total"><th colspan="${multi ? 7 : 6}" id="tc-foot-label">Total</th><td class="num" id="tc-foot-hours"></td>${data.see_pay ? '<td class="num" id="tc-foot-pay"></td>' : ''}</tr></tfoot></table></div>
      <p class="tc-none empty" hidden>Nobody by that name in these dates.</p></section>`
      : '<div class="card empty">No clock-ins in these dates.</div>'}
    <p class="muted small">From Square. Paid hours leave out unpaid breaks. Late is against the nearest rota shift that day (more than 5 minutes after it starts).</p>`}`;

  wireTimeframe(el, { t, tf, today, navigate, page: 'timecards', key: TF_KEY, keep: { scope: query.scope, q: query.q } });
  const form = el.querySelector('#tc-filters');
  form.addEventListener('submit', (e) => e.preventDefault());
  // Choosing a site reloads (keeping the timeframe); the name search filters as you type.
  form.scope?.addEventListener('change', (e) => {
    e.stopPropagation();
    navigate(`timecards${qs({ tf: query.tf, date: query.date, from: query.from, scope: form.scope.value, q: form.q.value.trim() || undefined })}`);
  });
  const shown = () => {
    const q = form.q.value.trim().toLowerCase();
    return data.rows.filter((r) => !q || r.name.toLowerCase().includes(q));
  };
  const apply = () => {
    const q = form.q.value.trim().toLowerCase();
    el.querySelectorAll('.tc-table tbody tr').forEach((tr) => { tr.hidden = !!q && !tr.dataset.name.includes(q); });
    const list = shown();
    const none = el.querySelector('.tc-none');
    if (none) none.hidden = list.length > 0 || !data.rows.length;
    const box = el.querySelector('#tc-totals');
    if (!box) return;
    const people = new Set(list.map((r) => r.user_id ?? r.name)).size;
    const hours = list.reduce((n, r) => n + r.hours, 0);
    const pay = list.reduce((n, r) => n + (r.cost ?? 0), 0);
    // The total row under the table, for what's shown.
    const label = el.querySelector('#tc-foot-label');
    if (label) {
      label.textContent = `Total${q ? ` for “${form.q.value.trim()}”` : ''} · ${list.length} timecard${list.length === 1 ? '' : 's'}`;
      el.querySelector('#tc-foot-hours').innerHTML = `<span class="tc-foot-tag">Total hours </span><strong>${hrs(hours)}</strong><small class="muted"> (${hm(hours)})</small>`;
      const footPay = el.querySelector('#tc-foot-pay');
      if (footPay) footPay.innerHTML = `<strong>${money(pay)}</strong>`;
    }
    // Searching and more than one person matches: each person's total hours.
    const byPerson = new Map();
    for (const r of list) {
      const k = r.user_id ?? r.name;
      const p = byPerson.get(k) ?? { name: r.name, hours: 0, cards: 0, pay: 0 };
      p.hours += r.hours; p.cards += 1; p.pay += r.cost ?? 0;
      byPerson.set(k, p);
    }
    const peopleBox = el.querySelector('#tc-people');
    if (peopleBox) {
      peopleBox.hidden = !q || byPerson.size < 2;
      peopleBox.innerHTML = peopleBox.hidden ? '' : `<ul>${[...byPerson.values()].sort((a, b) => b.hours - a.hours).map((p) => `<li><strong>${esc(p.name)}</strong>
        <span>${hrs(p.hours)} h <small class="muted">(${hm(p.hours)}) · ${p.cards} timecard${p.cards === 1 ? '' : 's'}${data.see_pay ? ` · ${money(p.pay)}` : ''}</small></span></li>`).join('')}</ul>`;
    }
    box.innerHTML = `<div><strong>${list.length}</strong><small>timecard${list.length === 1 ? '' : 's'}</small></div>
      <div><strong>${people}</strong><small>${people === 1 ? 'person' : 'people'}</small></div>
      <div class="tc-hours"><strong>${hrs(hours)}</strong><small>total hours · ${hm(hours)}</small></div>
      ${data.see_pay ? `<div><strong>${money(pay)}</strong><small>pay</small></div>` : ''}
      <div><strong class="${list.some((r) => r.late_minutes > 5) ? 'tone-bad' : ''}">${list.filter((r) => r.late_minutes > 5).length}</strong><small>late</small></div>`;
  };
  form.q.addEventListener('input', apply);
  apply();

  el.querySelector('#tc-csv')?.addEventListener('click', () => {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Date', 'Name', 'Site', 'Rota', 'Clock in', 'Clock out', 'Break minutes', 'Paid break minutes', 'Late (minutes)', 'Paid hours', ...(data.see_pay ? ['Hourly rate', 'Pay'] : [])];
    const lines = shown().map((r) => [r.date, r.name, r.location_name, r.rota ?? '', r.start, r.end ?? 'still in', r.break_minutes, r.paid_break_minutes,
      r.late_minutes ?? '', r.hours, ...(data.see_pay ? [r.rate, r.cost] : [])]);
    const blob = new Blob([[head, ...lines].map((l) => l.map(cell).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `timecards_${t.range.from}_${t.range.to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}
