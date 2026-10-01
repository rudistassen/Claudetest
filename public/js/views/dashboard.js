import { attachTip, pairedBarChart } from '../charts.js';
import { addDays, api, esc, fmtDate, isDemo, money, openModal, siteColour, toast, todayISO } from '../lib.js';
import { breakLine, clockInActions, wireClockInActions } from './breaks.js';
import { fmtPct, LABOUR_TARGET, labourTone } from './sales.js';

function progress(done, due) {
  const pct = due ? Math.round((done / due) * 100) : 100;
  const tone = pct === 100 ? 'good' : pct >= 50 ? 'warn' : 'bad';
  return `<div class="progress progress-${tone}" title="${done} of ${due}"><div style="width:${pct}%"></div></div>
    <div class="progress-label">${done} / ${due} done</div>`;
}

// "4h 05m" from hours.
const duration = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };

// Today so far against the same weekday last week up to the same time. Up is good for sales; labour is neutral.
function versus(now, then, { goodUp = true } = {}) {
  if (now === null || now === undefined) return '<span class="muted">No sales synced today</span>';
  if (!then) return `<span class="muted">${then === null ? 'Nothing to compare' : '£0'} last week</span>`;
  const change = ((now - then) / then) * 100;
  const tone = !goodUp || Math.abs(change) < 0.5 ? '' : (change > 0) === goodUp ? 'tone-good' : 'tone-bad';
  return `<span class="${tone}">${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(1)}%</span><br><span class="muted">${money(then)} last week</span>`;
}

// "Who's in today": a table of everyone on today's rota, site by site, with when they clocked in and out and
// where they are now, then anyone clocked in without a shift.
const ROSTER = {
  in: ['In', 'is-in'], on_break: ['On break', 'is-break'], done: ['Finished', 'is-done'], due: ['Due', 'is-due'],
  late: ['Not in', 'is-late'], missed: ['Didn’t clock in', 'is-late'], elsewhere: ['Elsewhere', 'is-other'],
  extra: ['Not on rota', 'is-other'], rota: ['On the rota', 'is-due'],
};
function rosterRow(p) {
  const [label, tone] = ROSTER[p.status] ?? ['', ''];
  const note = p.status === 'late' ? `${mins(p.late_minutes)} late`
    : p.status === 'elsewhere' ? `at ${esc(p.where)}`
      : [p.rota_site ? 'covering' : '', p.late_minutes ? `${mins(p.late_minutes)} late` : ''].filter(Boolean).join(' · ');
  return `<tr class="roster-row ${tone}">
    <td>${esc(p.name)}</td>
    <td>${p.rota ? `${p.rota}${p.rota_site ? ` <span class="muted">at ${esc(p.rota_site)}</span>` : ''}` : '<span class="muted">–</span>'}</td>
    <td>${p.clock ? p.clock.replace('–now', '–<span class="muted">now</span>') : '<span class="muted">–</span>'}</td>
    <td><span class="roster-status">${label}</span>${note ? ` <span class="muted">${note}</span>` : ''}</td>
  </tr>`;
}
function whosIn(locs, data) {
  const count = (list, ...st) => list.filter((p) => st.includes(p.status)).length;
  // On this site's rota (not covering from another site's rota, and not clocked in without a shift).
  const rotad = (list) => list.filter((p) => p.status !== 'extra' && !p.rota_site).length;
  const rows = locs.filter((l) => l.roster);
  const all = rows.flatMap((l) => l.roster);
  return `<section class="card whos-in">
    <header class="card-head"><h2>Who’s in today</h2>
      <span class="muted small">${rotad(all)} on the rota · ${count(all, 'in', 'on_break', 'extra')} clocked in now · ${count(all, 'late', 'missed')} not in</span></header>
    <div class="whos-in-grid">${rows.map((l) => {
      const r = l.roster;
      const notIn = count(r, 'late', 'missed');
      return `<div class="whos-in-site" style="--site: ${siteColour(l.name, l.id)}">
        <p class="whos-in-site-head"><strong>${esc(l.name)}</strong>
          <span class="muted">${rotad(r)} rota’d · ${count(r, 'in', 'on_break', 'extra')} in${notIn ? ` · <span class="tone-bad">${notIn} not in</span>` : ''}</span></p>
        ${r.length ? `<table class="whos-in-table"><thead><tr><th>Person</th><th>Rota</th><th>Clocked</th><th>Status</th></tr></thead>
          <tbody>${r.map(rosterRow).join('')}</tbody></table>` : '<p class="muted small">Nobody on the rota today</p>'}
      </div>`;
    }).join('')}</div>
    ${data.labour_synced ? '' : '<p class="muted small">Clock-ins come from Square once it’s connected; until then this shows the rota only.</p>'}
  </section>`;
}

// The change on last week, as a small ▲/▼ percentage (green up, red down).
function change(now, then) {
  if (!then) return '';
  const c = ((now - then) / then) * 100;
  const tone = Math.abs(c) < 0.5 ? 'muted' : c > 0 ? 'tone-good' : 'tone-bad';
  return `<span class="dash-vs ${tone}" title="${money(then)} last week">${Math.abs(c) < 0.05 ? '■ 0.0%' : `${c > 0 ? '▲' : '▼'} ${Math.abs(c).toFixed(1)}%`}</span>`;
}

// For the labour tile: the change in percentage points on last week by this time. Lower labour is good (green).
function labourVersus(now, then) {
  if (now === null || now === undefined) return '<span class="muted">of net sales so far</span>';
  if (then === null || then === undefined) return '<span class="muted">of net sales · nothing to compare last week</span>';
  const d = Math.round((now - then) * 10) / 10;
  const tone = Math.abs(d) < 0.5 ? 'muted' : d > 0 ? 'tone-bad' : 'tone-good';
  return `<span class="${tone}">${d === 0 ? '■ 0.0 pts' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} pts`}</span> <span class="muted">on last week</span><br>
    <span class="muted">${then.toFixed(1)}% by this time last week</span>`;
}

// For a tile: "▲ 4.2% on last week", then what last week had taken by the same time.
function versusLine(now, then) {
  if (now === null) return '<span class="muted">No sales synced yet today</span>';
  if (!then) return '<span class="muted">Nothing to compare last week</span>';
  const change = ((now - then) / then) * 100;
  const tone = Math.abs(change) < 0.5 ? 'muted' : change > 0 ? 'tone-good' : 'tone-bad';
  return `<span class="${tone}">${Math.abs(change) < 0.05 ? '■ 0.0%' : `${change > 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(1)}%`}</span> <span class="muted">on last week</span><br>
    <span class="muted">${money(then)} by this time last week</span>`;
}

const siteInitials = (name) => name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`);

// How a clock-in compares with the person's shift on the rota.
function rotaLine(c) {
  const tags = [];
  if (c.late_minutes) tags.push(`<span class="chip">Late in ${mins(c.late_minutes)}</span>`);
  if (c.over_minutes) tags.push(`<span class="chip">${c.end ? `Out ${mins(c.over_minutes)} after shift` : `${mins(c.over_minutes)} past shift end`}</span>`);
  if (c.not_on_rota) tags.push('<span class="chip chip-muted">Not on the rota</span>');
  // Only worth a line when something's off.
  if (!tags.length) return '';
  return `<span class="clock-rota small">${c.rota ? `<span class="muted">Rota ${c.rota}</span>` : ''} ${tags.join(' ')}</span>`;
}

function card(loc, state, data) {
  const staff = loc.shifts_today;
  const lw = loc.last_week;
  const clocked = loc.clock_ins && data.labour_synced;
  return `
    <section class="card site-card" style="--site: ${siteColour(loc.name, loc.id)}">
      <header class="card-head">
        <h2 data-initials="${esc(siteInitials(loc.name))}">${esc(loc.name)}</h2>
        ${state.multiSite ? `<button class="btn btn-small" data-open="${loc.id}">Open site</button>` : ''}
      </header>
      ${state.can('sales.view') ? `
      <div class="site-money">
        <div>
          <h3>Gross sales</h3>
          <p class="stat">${loc.gross_today === null ? '<span class="muted">–</span>' : money(loc.gross_today)}</p>
          <p class="small">${versus(loc.gross_today, lw.gross)}</p>
        </div>
        <div>
          <h3>Labour cost</h3>
          <p class="stat">${money(loc.labour_cost_today)}</p>
          <p class="small">${versus(loc.labour_cost_today, lw.labour_cost, { goodUp: false })}</p>
          <p class="small tone-${labourTone(loc.labour_pct_today)}">${fmtPct(loc.labour_pct_today)} of net sales${loc.labour_basis === 'rostered' ? ' (rota)' : ''}</p>
        </div>
      </div>
      <p class="small muted site-compare">Today so far vs ${fmtDate(data.compare_date, { weekday: 'short', day: 'numeric', month: 'short' })} at the same time</p>` : ''}
      <div class="site-grid">
        ${clocked ? `
        <div class="span-2">
          <h3>Clocked in today (${loc.clock_ins.length})</h3>
          ${loc.clock_ins.length
            ? `<ul class="shift-list clock-list">${loc.clock_ins.map((c) => `<li><strong>${esc(c.name)}</strong>
                <span class="muted">${c.start}–${c.end ?? 'now'}</span>
                <span class="clock-hours">${c.end ? '' : c.on_break ? '<span class="badge badge-on-break">On break</span> ' : '<span class="badge badge-sent">In</span> '}${duration(c.hours)}${clockInActions(state, c, loc.id)}</span>
                ${rotaLine(c)}
                ${breakLine(c)}</li>`).join('')}</ul>
              <p class="small muted">${duration(loc.clock_ins.reduce((n, c) => n + c.hours, 0))} in total</p>`
            : '<p class="muted">Nobody has clocked in yet</p>'}
          ${loc.not_clocked_in?.length ? `<ul class="shift-list clock-list clock-missing">${loc.not_clocked_in.map((m) => `<li><strong>${esc(m.name)}</strong>
              <span class="muted">Rota ${m.rota}</span>
              <span class="clock-hours"><span class="chip chip-strong">${m.shift_over ? 'Didn’t clock in' : `Not clocked in · ${mins(m.late_minutes)} late`}</span></span></li>`).join('')}</ul>` : ''}
        </div>` : `
        <div class="span-2">
          <h3>On shift today (${staff.length})</h3>
          ${staff.length
            ? `<ul class="shift-list">${staff.map((s) => `<li><strong>${esc(s.name)}</strong> ${s.start_time}–${s.end_time}</li>`).join('')}</ul>`
            : '<p class="muted">Nobody rostered</p>'}
        </div>`}
        <div class="site-checks span-2">
          <h3>Daily Trail checks</h3>
          ${progress(loc.daily.done, loc.daily.due)}
          ${loc.daily.fails ? `<p class="alert-text">⚠ ${loc.daily.fails} failed check(s) today</p>` : ''}
        </div>
      </div>
    </section>`;
}

// "Download PDF": the browser's print window, set up for a landscape A4 page, with the file named after the
// dashboard and date. Choosing "Save as PDF" as the printer saves it.
function downloadPdf(state, date) {
  const title = document.title;
  const page = document.createElement('style');
  page.textContent = '@page { size: A4 landscape; margin: 10mm; }';
  document.head.append(page);
  document.title = `Brewly dashboard - ${state.multiSite ? 'All sites' : state.location?.name ?? ''} - ${date}`;
  const restore = () => {
    document.title = title;
    page.remove();
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  toast('Choose “Save as PDF” as the printer, then Save');
  setTimeout(() => window.print(), 50);
}

// Sales and labour % for each site, today or over the last 7 days (the same figures as the Trading page).
const PERIOD_KEY = 'cafe-ops:dashboard-period';
const hrs = (h) => `${Number(h).toLocaleString('en-GB', { maximumFractionDigits: 1 })} h`;

function bySite(t, period, prev) {
  const labour = (r) => (t.labour_synced && r.labour_pct !== null ? r.labour_pct : r.rostered_labour_pct);
  const rows = [...t.locations].sort((a, b) => b.gross_sales - a.gross_sales);
  const maxSales = Math.max(1, ...rows.map((r) => Math.max(r.gross_sales, prev.get(r.id) ?? 0)));
  const prevTotal = rows.some((r) => prev.get(r.id) !== null && prev.get(r.id) !== undefined) ? rows.reduce((n, r) => n + (prev.get(r.id) ?? 0), 0) : null;
  // Gross sales (blue) over the same period last week (grey), with the change.
  const salesCell = (now, then, { bars = true } = {}) => `<td class="dash-sales">
    ${bars ? `<span class="dash-bars"><span class="dash-bar"><span class="fill" style="width:${(now / maxSales) * 100}%"></span></span>
      ${then !== null && then !== undefined ? `<span class="dash-bar dash-bar-prev" title="Last week ${money(then)}"><span class="fill" style="width:${(then / maxSales) * 100}%"></span></span>` : ''}</span>` : ''}
    <strong>${money(now)}</strong> ${change(now, then)}</td>`;
  // Labour bars run to at least twice the target, so the target line sits in a sensible place.
  const scale = Math.max(LABOUR_TARGET * 2, ...rows.map((r) => Math.min(labour(r) ?? 0, 150)));
  const icon = (p) => (p === null || p === undefined ? '' : labourTone(p) === 'good' ? '✓ ' : '⚠ ');
  const labourCell = (p) => `<td class="dash-labour">
    <span class="dash-bar dash-bar-labour"><span class="fill tone-bg-${labourTone(p) || 'none'}" style="width:${p === null ? 0 : Math.min(100, (p / scale) * 100)}%"></span>
      <i class="dash-target" style="left:${(LABOUR_TARGET / scale) * 100}%" title="Target ${LABOUR_TARGET}%"></i></span>
    <strong class="tone-${labourTone(p)}">${icon(p)}${fmtPct(p)}</strong></td>`;
  const total = t.totals;
  return `
    <section class="card dash-sites">
      <header class="card-head">
        <h2>Sales &amp; labour by site<span class="print-only"> · ${period === 'week' ? 'last 7 days' : 'today'}</span></h2>
        <div class="seg" role="group" aria-label="Period">
          <button class="${period === 'today' ? 'is-on' : ''}" data-period="today">Today</button>
          <button class="${period === 'week' ? 'is-on' : ''}" data-period="week">Last 7 days</button>
        </div>
      </header>
      <div class="table-wrap"><table class="dash-table">
        <thead><tr><th>Site</th><th>Gross sales</th><th class="num">Orders</th><th>Labour % of net sales <small class="inline">(${t.labour_synced ? 'clocked' : 'rostered'} · target ${LABOUR_TARGET}%)</small></th></tr></thead>
        <tbody>${rows.map((r) => `<tr data-site-row="${r.id}" tabindex="0" style="--site: ${siteColour(r.name, r.id)}">
          <th>${esc(r.name)}${r.linked ? '' : ' <small class="inline muted">not on Square</small>'}</th>
          ${salesCell(r.gross_sales, prev.get(r.id))}
          <td class="num">${r.orders}</td>
          ${labourCell(labour(r))}
        </tr>`).join('')}</tbody>
        ${rows.length > 1 ? `<tfoot><tr><th>All sites</th>${salesCell(total.gross_sales, prevTotal, { bars: false })}<td class="num">${total.orders}</td>
          <td><strong class="tone-${labourTone(labour(total))}">${icon(labour(total))}${fmtPct(labour(total))}</strong></td></tr></tfoot>` : ''}
      </table></div>
      <p class="muted small">${period === 'today' ? 'So far today' : `${fmtDate(t.from, { day: 'numeric', month: 'short' })} – ${fmtDate(t.to, { day: 'numeric', month: 'short' })}`}.
        Grey bars are the same time last week. Labour % is labour cost ÷ net sales (ex VAT), and only counts days with both sales and labour. <a href="#/trading">More on the Trading page →</a></p>
    </section>`;
}

export async function render({ el, state, navigate, stale, rerender }) {
  const seeSales = state.can('sales.view');
  let period = 'today';
  try { period = localStorage.getItem(PERIOD_KEY) === 'week' ? 'week' : 'today'; } catch { /* storage unavailable */ }
  const d0 = todayISO();
  const [data, myShifts, leave, security, tradeToday, tradeWeek, tradePrevWeek] = await Promise.all([
    api('/dashboard'),
    api('/my-shifts'),
    state.can('leave.manage') ? api('/leave/pending-count') : { count: 0 },
    state.isAdmin && !isDemo ? api('/admin/security').catch(() => null) : null,
    seeSales ? api(`/trading?from=${d0}&to=${d0}`) : null,
    seeSales && period === 'week' ? api(`/trading?from=${addDays(d0, -6)}&to=${d0}`) : null,
    // The week before, up to yesterday a week ago (last week's matching day to this time comes from /dashboard).
    seeSales && period === 'week' ? api(`/trading?from=${addDays(d0, -13)}&to=${addDays(d0, -8)}`) : null,
  ]);
  if (stale()) return;
  const trade = period === 'week' ? tradeWeek : tradeToday;

  const locs = data.locations;
  const totals = locs.reduce((t, l) => ({
    dailyDone: t.dailyDone + l.daily.done,
    dailyDue: t.dailyDue + l.daily.due,
    fails: t.fails + l.daily.fails,
    staff: t.staff + l.shifts_today.length,
    sales: t.sales + (l.sales_today ?? 0),
    labour: t.labour + (l.labour_cost_today ?? 0),
  }), { dailyDone: 0, dailyDue: 0, fails: 0, staff: 0, sales: 0, labour: 0 });
  // Today's sales and labour % for the whole group, matching the by-site panel and the Trading page.
  const hasSales = !!tradeToday && tradeToday.square_connected;
  const todayTotals = tradeToday?.totals;
  // Everyone clocked in right now across the sites (from Square), or null when clock-ins aren't available.
  const clockedInNow = data.labour_synced && locs.some((l) => l.clock_ins)
    ? locs.reduce((n, l) => n + (l.clock_ins ?? []).filter((c) => !c.end).length, 0) : null;
  // Gross sales so far today against the same weekday last week up to the same time.
  const withGross = locs.filter((l) => l.gross_today !== null);
  const gross = {
    now: withGross.length ? withGross.reduce((n, l) => n + l.gross_today, 0) : null,
    then: locs.some((l) => (l.last_week?.gross ?? null) !== null) ? locs.reduce((n, l) => n + (l.last_week?.gross ?? 0), 0) : null,
  };
  // Each site's gross sales over the same period last week, up to the same time of day.
  const prevSales = new Map(locs.map((l) => {
    const sameTime = l.last_week?.gross ?? null;
    if (period === 'today') return [l.id, sameTime];
    const before = tradePrevWeek?.locations.find((x) => x.id === l.id)?.gross_sales ?? 0;
    return [l.id, sameTime === null && !before ? null : before + (sameTime ?? 0)];
  }));
  // Labour % by this time on the same day last week, worked out the same way (labour cost ÷ net sales, only
  // counting sites that had both).
  const lwSites = locs.filter((l) => l.last_week?.net > 0 && l.last_week?.labour_cost > 0);
  const lwNet = lwSites.reduce((n, l) => n + l.last_week.net, 0);
  const labourLastWeek = lwNet ? Math.round((lwSites.reduce((n, l) => n + l.last_week.labour_cost, 0) / lwNet) * 1000) / 10 : null;
  const labourPct = todayTotals ? (tradeToday.labour_synced && todayTotals.labour_pct !== null ? todayTotals.labour_pct : todayTotals.rostered_labour_pct) : null;

  el.innerHTML = `
    <div class="page-head">
      <h1>${state.multiSite ? 'All sites' : esc(state.location?.name ?? 'Dashboard')}</h1>
      <div class="actions">
        <span class="muted">${fmtDate(data.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
        <button class="btn dash-pdf" id="dash-pdf">Download PDF</button>
      </div>
    </div>
    <p class="print-only print-meta">Brewly dashboard · ${fmtDate(data.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · printed at ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</p>
    ${state.multiSite ? `
    ${hasSales ? `<div class="dash-hero">
      <div class="kpi kpi-feature" data-icon="£"><span>Gross sales today</span><strong>${gross.now === null ? '–' : money(gross.now)}</strong>
        <small class="kpi-vs">${versusLine(gross.now, gross.then)}</small></div>
      <div class="kpi kpi-${labourTone(labourPct)} dash-hero-labour" data-icon="◷"><span>Labour today</span><strong>${fmtPct(labourPct)}</strong>
        <small class="kpi-vs">${labourVersus(labourPct, labourLastWeek)}</small></div>
      <section class="card dash-hourly">
        <header class="dash-hourly-head"><h2>Gross sales by hour</h2>
          <div class="chart-legend"><span><i class="chart-legend-bar" style="background:var(--series-1)"></i>Today</span><span><i class="chart-legend-bar" style="background:var(--prev-bar)"></i>vs ${fmtDate(addDays(d0, -7), { weekday: 'long' })} last week</span></div></header>
        <div id="hourly-chart" class="chart-box"><div class="loading">Loading…</div></div>
      </section>
    </div>` : ''}
    <div class="kpis">
      <div class="kpi" data-icon="✓"><span>Daily checks done</span><strong>${totals.dailyDone} / ${totals.dailyDue}</strong></div>
      <div class="kpi ${totals.fails ? 'kpi-bad' : ''}" data-icon="!"><span>Failed checks today</span><strong>${totals.fails}</strong></div>
      ${clockedInNow === null ? '' : `<button type="button" class="kpi kpi-button" id="clocked-in-now" data-icon="☺" aria-haspopup="dialog"><span>Clocked in now</span><strong>${clockedInNow}</strong><small>of ${totals.staff} on today’s rota · <u>see who</u></small></button>`}
    </div>` : ''}
    ${trade?.square_connected ? bySite(trade, period, prevSales) : ''}
    ${locs.some((l) => l.roster) ? whosIn(locs, data) : ''}
    ${security?.demo_password_accounts?.length ? `<p class="notice security-warning"><strong>⚠ Security: ${security.demo_password_accounts.length} account${security.demo_password_accounts.length === 1 ? '' : 's'} can still sign in with the demo password</strong> (${esc(security.demo_password_accounts.slice(0, 4).map((u) => u.email).join(', '))}${security.demo_password_accounts.length > 4 ? ', …' : ''}). Anyone who knows it could get in. Add <code>SEED_DEMO</code> = <code>false</code> in Railway → Variables to switch them all off, or give each a new password under Setup → Staff.</p>` : ''}
    ${leave.count ? `<p class="notice"><strong>${leave.count} holiday request${leave.count === 1 ? '' : 's'}</strong> waiting for approval. <a href="#/timeoff?tab=requests">Review ${leave.count === 1 ? 'it' : 'them'}</a></p>` : ''}
    ${myShifts.length ? `
    <section class="card">
      <h2>Your upcoming shifts</h2>
      <ul class="shift-list">${myShifts.slice(0, 7).map((s) => `<li><strong>${fmtDate(s.date)}</strong> ${s.start_time}–${s.end_time} · ${esc(s.location_name)}</li>`).join('')}</ul>
    </section>` : ''}
    <div class="site-cards">${locs.map((l) => card(l, state, data)).join('')}</div>`;

  el.querySelector('#dash-pdf').addEventListener('click', () => downloadPdf(state, data.date));
  // "Clocked in now": who's clocked in, site by site.
  el.querySelector('#clocked-in-now')?.addEventListener('click', () => {
    const sites = locs.map((l) => ({ l, people: (l.clock_ins ?? []).filter((c) => !c.end) })).filter((x) => x.people.length);
    openModal({
      title: `Clocked in now (${clockedInNow})`,
      body: sites.length ? sites.map(({ l, people }) => `<div class="clocked-site" style="--site: ${siteColour(l.name, l.id)}">
          <h3>${esc(l.name)} <span class="muted">${people.length} in</span></h3>
          <ul class="clocked-list">${people.sort((a, b) => a.start.localeCompare(b.start)).map((c) => `<li>
            <strong>${esc(c.name)}</strong>
            <span class="muted">since ${c.start}${c.rota ? ` · rota ${c.rota}` : c.not_on_rota ? ' · not on the rota' : ''}</span>
            <span>${c.on_break ? '<span class="badge badge-on-break">On break</span>' : '<span class="badge badge-received">In</span>'} ${duration(c.hours)}</span>
          </li>`).join('')}</ul></div>`).join('')
        : '<p class="muted">Nobody is clocked in right now.</p>',
    });
  });
  // Gross sales by hour: today next to the same weekday last week.
  const chartBox = el.querySelector('#hourly-chart');
  if (chartBox) {
    api(`/trading/hourly-compare?date=${d0}`).then((h) => {
      if (stale() || !chartBox.isConnected) return;
      if (!h.hours.length) { chartBox.innerHTML = '<p class="muted small">No sales synced yet today.</p>'; return; }
      const hh = (n) => String(n).padStart(2, '0');
      const whole = (v) => (v >= 1000 ? `£${(v / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}k` : `£${Math.round(v)}`);
      pairedBarChart(chartBox, {
        data: h.hours,
        label: (x) => hh(x.hour),
        title: (x) => `${hh(x.hour)}:00–${hh(x.hour + 1)}:00`,
        series: [
          { name: 'today', value: (x) => x.today, color: 'var(--series-1)' },
          { name: `${fmtDate(h.compare_date, { weekday: 'short', day: 'numeric', month: 'short' })}`, value: (x) => x.last_week, color: 'var(--prev-bar)' },
        ],
        fmt: money,
        fmtAxis: whole,
        height: 190,
        ariaLabel: 'Gross sales by hour, today and the same day last week',
      });
    }).catch(() => { if (chartBox.isConnected) chartBox.innerHTML = '<p class="muted small">Couldn’t load the hourly chart.</p>'; });
  }
  wireClockInActions(el, { state, rerender });
  el.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem(PERIOD_KEY, b.dataset.period); } catch { /* storage unavailable */ }
    rerender();
  }));
  // Hover or focus a site for its labour cost, hours and sales per labour hour.
  el.querySelectorAll('[data-site-row]').forEach((tr) => {
    const r = trade.locations.find((l) => l.id === Number(tr.dataset.siteRow));
    const clocked = trade.labour_synced && r.clocked_hours > 0;
    attachTip(tr, () => r.name, () => [
      { value: money(r.gross_sales), label: `gross sales · ${r.orders} orders` },
      ...(prevSales.get(r.id) ? [{ value: money(prevSales.get(r.id)), label: 'gross sales same time last week' }] : []),
      { value: money(r.net_sales), label: 'net sales (ex VAT)' },
      { value: money(clocked ? r.clocked_cost : r.rostered_cost), label: `labour (${clocked ? 'clocked' : 'rostered'}) · ${hrs(clocked ? r.clocked_hours : r.rostered_hours)}` },
      ...(r.sales_per_labour_hour !== null ? [{ value: money(r.sales_per_labour_hour), label: 'sales per labour hour' }] : []),
      ...(r.avg_spend !== null ? [{ value: money(r.avg_spend), label: 'average spend' }] : []),
    ]);
  });

  el.querySelectorAll('[data-open], [data-site]').forEach((b) => b.addEventListener('click', (e) => {
    const id = Number(b.dataset.open ?? b.dataset.site);
    if (state.multiSite) {
      state.locationId = id;
      try { localStorage.setItem('cafe-ops:location', String(id)); } catch { /* storage unavailable */ }
    }
    if (b.dataset.open) {
      e.preventDefault();
      navigate('safety');
    }
  }));
}
