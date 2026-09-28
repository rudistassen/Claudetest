import { attachTip } from '../charts.js';
import { addDays, api, esc, fmtDate, fmtDateTime, money, todayISO } from '../lib.js';
import { fmtPct, LABOUR_TARGET, labourTone } from './sales.js';

function progress(done, due) {
  const pct = due ? Math.round((done / due) * 100) : 100;
  const tone = pct === 100 ? 'good' : pct >= 50 ? 'warn' : 'bad';
  return `<div class="progress progress-${tone}" title="${done} of ${due}"><div style="width:${pct}%"></div></div>
    <div class="progress-label">${done} / ${due} done</div>`;
}

function card(loc, state) {
  const staff = loc.shifts_today;
  return `
    <section class="card site-card">
      <header class="card-head">
        <h2>${esc(loc.name)}</h2>
        ${state.multiSite ? `<button class="btn btn-small" data-open="${loc.id}">Open site</button>` : ''}
      </header>
      <div class="site-grid">
        <div>
          <h3>Daily safety checks</h3>
          ${progress(loc.daily.done, loc.daily.due)}
          ${loc.daily.fails ? `<p class="alert-text">⚠ ${loc.daily.fails} failed check(s) today</p>` : ''}
        </div>
        <div>
          <h3>Weekly safety checks</h3>
          ${progress(loc.weekly.done, loc.weekly.due)}
          ${loc.weekly.fails ? `<p class="alert-text">⚠ ${loc.weekly.fails} failed this week</p>` : ''}
        </div>
        <div>
          <h3>Wastage (7 days)</h3>
          <p class="stat">${money(loc.wastage_7d)}</p>
        </div>
        <div>
          <h3>Stock take</h3>
          <p>${loc.stock_take_in_progress
            ? `<a href="#/stock/${loc.stock_take_in_progress}" data-site="${loc.id}">Count in progress →</a>`
            : loc.last_stock_take ? `Last: ${fmtDateTime(loc.last_stock_take)}` : '<span class="muted">None yet</span>'}</p>
        </div>
        ${state.can('sales.view') ? `
        <div>
          <h3>Sales today</h3>
          <p class="stat">${loc.sales_today === null ? '<span class="muted">–</span>' : money(loc.sales_today)}</p>
          <p class="small muted">${loc.orders_today} orders · 7 days ${money(loc.sales_7d)}</p>
        </div>
        <div>
          <h3>Labour today</h3>
          <p class="stat tone-${labourTone(loc.labour_pct_today)}">${fmtPct(loc.labour_pct_today)}</p>
          <p class="small muted">${money(loc.labour_cost_today)} worked so far</p>
        </div>` : ''}
        ${state.can('orders.manage') ? `
        <div>
          <h3>Orders</h3>
          <p>${loc.orders_draft} draft · ${loc.orders_sent} awaiting delivery</p>
        </div>` : ''}
        <div class="span-2">
          <h3>On shift today (${staff.length})</h3>
          ${staff.length
            ? `<ul class="shift-list">${staff.map((s) => `<li><strong>${esc(s.name)}</strong> ${s.start_time}–${s.end_time}</li>`).join('')}</ul>`
            : '<p class="muted">Nobody rostered</p>'}
        </div>
      </div>
    </section>`;
}

// Sales and labour % for each site, today or over the last 7 days (the same figures as the Trading page).
const PERIOD_KEY = 'cafe-ops:dashboard-period';
const hrs = (h) => `${Number(h).toLocaleString('en-GB', { maximumFractionDigits: 1 })} h`;

function bySite(t, period) {
  const labour = (r) => (t.labour_synced && r.labour_pct !== null ? r.labour_pct : r.rostered_labour_pct);
  const rows = [...t.locations].sort((a, b) => b.net_sales - a.net_sales);
  const maxSales = Math.max(1, ...rows.map((r) => r.net_sales));
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
        <h2>Sales &amp; labour by site</h2>
        <div class="seg" role="group" aria-label="Period">
          <button class="${period === 'today' ? 'is-on' : ''}" data-period="today">Today</button>
          <button class="${period === 'week' ? 'is-on' : ''}" data-period="week">Last 7 days</button>
        </div>
      </header>
      <div class="table-wrap"><table class="dash-table">
        <thead><tr><th>Site</th><th>Net sales (ex VAT)</th><th class="num">Orders</th><th>Labour % of sales <small class="inline">(${t.labour_synced ? 'clocked' : 'rostered'} · target ${LABOUR_TARGET}%)</small></th></tr></thead>
        <tbody>${rows.map((r) => `<tr data-site-row="${r.id}" tabindex="0">
          <th>${esc(r.name)}${r.linked ? '' : ' <small class="inline muted">not on Square</small>'}</th>
          <td class="dash-sales"><span class="dash-bar"><span class="fill" style="width:${(r.net_sales / maxSales) * 100}%"></span></span><strong>${money(r.net_sales)}</strong></td>
          <td class="num">${r.orders}</td>
          ${labourCell(labour(r))}
        </tr>`).join('')}</tbody>
        ${rows.length > 1 ? `<tfoot><tr><th>All sites</th><td><strong>${money(total.net_sales)}</strong></td><td class="num">${total.orders}</td>
          <td><strong class="tone-${labourTone(labour(total))}">${icon(labour(total))}${fmtPct(labour(total))}</strong></td></tr></tfoot>` : ''}
      </table></div>
      <p class="muted small">${period === 'today' ? 'So far today' : `${fmtDate(t.from, { day: 'numeric', month: 'short' })} – ${fmtDate(t.to, { day: 'numeric', month: 'short' })}`}.
        Labour % only counts days with both sales and labour. <a href="#/trading">More on the Trading page →</a></p>
    </section>`;
}

export async function render({ el, state, navigate, stale, rerender }) {
  const seeSales = state.can('sales.view');
  let period = 'today';
  try { period = localStorage.getItem(PERIOD_KEY) === 'week' ? 'week' : 'today'; } catch { /* storage unavailable */ }
  const d0 = todayISO();
  const [data, myShifts, leave, tradeToday, tradeWeek] = await Promise.all([
    api('/dashboard'),
    api('/my-shifts'),
    state.can('leave.manage') ? api('/leave/pending-count') : { count: 0 },
    seeSales ? api(`/trading?from=${d0}&to=${d0}`) : null,
    seeSales && period === 'week' ? api(`/trading?from=${addDays(d0, -6)}&to=${d0}`) : null,
  ]);
  if (stale()) return;
  const trade = period === 'week' ? tradeWeek : tradeToday;

  const locs = data.locations;
  const totals = locs.reduce((t, l) => ({
    dailyDone: t.dailyDone + l.daily.done,
    dailyDue: t.dailyDue + l.daily.due,
    fails: t.fails + l.daily.fails + l.weekly.fails,
    wastage: t.wastage + l.wastage_7d,
    staff: t.staff + l.shifts_today.length,
    sales: t.sales + (l.sales_today ?? 0),
    labour: t.labour + (l.labour_cost_today ?? 0),
  }), { dailyDone: 0, dailyDue: 0, fails: 0, wastage: 0, staff: 0, sales: 0, labour: 0 });
  // Today's sales and labour % for the whole group, matching the by-site panel and the Trading page.
  const hasSales = !!tradeToday && tradeToday.square_connected;
  const todayTotals = tradeToday?.totals;
  const labourPct = todayTotals ? (tradeToday.labour_synced && todayTotals.labour_pct !== null ? todayTotals.labour_pct : todayTotals.rostered_labour_pct) : null;

  el.innerHTML = `
    <div class="page-head">
      <h1>${state.multiSite ? 'All sites' : esc(state.location?.name ?? 'Dashboard')}</h1>
      <span class="muted">${fmtDate(data.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
    </div>
    ${state.multiSite ? `
    <div class="kpis">
      ${hasSales ? `<div class="kpi"><span>Sales today (ex VAT)</span><strong>${money(todayTotals.net_sales)}</strong></div>
      <div class="kpi kpi-${labourTone(labourPct)}"><span>Labour today</span><strong>${fmtPct(labourPct)}</strong></div>` : ''}
      <div class="kpi"><span>Daily checks done</span><strong>${totals.dailyDone} / ${totals.dailyDue}</strong></div>
      <div class="kpi ${totals.fails ? 'kpi-bad' : ''}"><span>Failed checks</span><strong>${totals.fails}</strong></div>
      <div class="kpi"><span>Wastage, last 7 days</span><strong>${money(totals.wastage)}</strong></div>
      <div class="kpi"><span>Staff on shift today</span><strong>${totals.staff}</strong></div>
    </div>` : ''}
    ${trade?.square_connected ? bySite(trade, period) : ''}
    ${leave.count ? `<p class="notice"><strong>${leave.count} holiday request${leave.count === 1 ? '' : 's'}</strong> waiting for approval. <a href="#/timeoff?tab=requests">Review ${leave.count === 1 ? 'it' : 'them'}</a></p>` : ''}
    ${myShifts.length ? `
    <section class="card">
      <h2>Your upcoming shifts</h2>
      <ul class="shift-list">${myShifts.slice(0, 7).map((s) => `<li><strong>${fmtDate(s.date)}</strong> ${s.start_time}–${s.end_time} · ${esc(s.location_name)}</li>`).join('')}</ul>
    </section>` : ''}
    <div class="site-cards">${locs.map((l) => card(l, state)).join('')}</div>`;

  el.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem(PERIOD_KEY, b.dataset.period); } catch { /* storage unavailable */ }
    rerender();
  }));
  // Hover or focus a site for its labour cost, hours and sales per labour hour.
  el.querySelectorAll('[data-site-row]').forEach((tr) => {
    const r = trade.locations.find((l) => l.id === Number(tr.dataset.siteRow));
    const clocked = trade.labour_synced && r.clocked_hours > 0;
    attachTip(tr, () => r.name, () => [
      { value: money(r.net_sales), label: `net sales · ${r.orders} orders` },
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
