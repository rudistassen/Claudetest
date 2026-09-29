import { attachTip } from '../charts.js';
import { addDays, api, esc, fmtDate, fmtDateTime, money, toast, todayISO } from '../lib.js';
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

function card(loc, state, data) {
  const staff = loc.shifts_today;
  const lw = loc.last_week;
  const clocked = loc.clock_ins && data.labour_synced;
  return `
    <section class="card site-card">
      <header class="card-head">
        <h2>${esc(loc.name)}</h2>
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
          <h3>Net sales</h3>
          <p class="stat">${loc.sales_today === null ? '<span class="muted">–</span>' : money(loc.sales_today)}</p>
          <p class="small">${versus(loc.sales_today, lw.net)}</p>
        </div>
        <div>
          <h3>Labour cost</h3>
          <p class="stat">${money(loc.labour_cost_today)}</p>
          <p class="small">${versus(loc.labour_cost_today, lw.labour_cost, { goodUp: false })}</p>
          <p class="small tone-${labourTone(loc.labour_pct_today)}">${fmtPct(loc.labour_pct_today)} of sales${loc.labour_basis === 'rostered' ? ' (rota)' : ''}</p>
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
                <span class="clock-hours">${c.end ? '' : '<span class="badge badge-sent">In</span> '}${duration(c.hours)}</span></li>`).join('')}</ul>
              <p class="small muted">${duration(loc.clock_ins.reduce((n, c) => n + c.hours, 0))} in total</p>`
            : '<p class="muted">Nobody has clocked in yet</p>'}
        </div>` : `
        <div class="span-2">
          <h3>On shift today (${staff.length})</h3>
          ${staff.length
            ? `<ul class="shift-list">${staff.map((s) => `<li><strong>${esc(s.name)}</strong> ${s.start_time}–${s.end_time}</li>`).join('')}</ul>`
            : '<p class="muted">Nobody rostered</p>'}
        </div>`}
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
        ${state.can('orders.manage') ? `
        <div class="span-2">
          <h3>Orders</h3>
          <p>${loc.orders_draft} draft · ${loc.orders_sent} awaiting delivery</p>
        </div>` : ''}
        <div class="site-checks">
          <h3>Daily Trail checks</h3>
          ${progress(loc.daily.done, loc.daily.due)}
          ${loc.daily.fails ? `<p class="alert-text">⚠ ${loc.daily.fails} failed check(s) today</p>` : ''}
        </div>
        <div class="site-checks">
          <h3>Weekly Trail checks</h3>
          ${progress(loc.weekly.done, loc.weekly.due)}
          ${loc.weekly.fails ? `<p class="alert-text">⚠ ${loc.weekly.fails} failed this week</p>` : ''}
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
  document.title = `BrewView dashboard - ${state.multiSite ? 'All sites' : state.location?.name ?? ''} - ${date}`;
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
        <h2>Sales &amp; labour by site<span class="print-only"> · ${period === 'week' ? 'last 7 days' : 'today'}</span></h2>
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
      <div class="actions">
        <span class="muted">${fmtDate(data.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
        <button class="btn" id="dash-pdf">Download PDF</button>
      </div>
    </div>
    <p class="print-only print-meta">BrewView dashboard · ${fmtDate(data.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · printed at ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</p>
    ${state.multiSite ? `
    <div class="kpis">
      ${hasSales ? `<div class="kpi kpi-feature" data-icon="£"><span>Sales today (ex VAT)</span><strong>${money(todayTotals.net_sales)}</strong></div>
      <div class="kpi kpi-${labourTone(labourPct)}" data-icon="◷"><span>Labour today</span><strong>${fmtPct(labourPct)}</strong></div>` : ''}
      <div class="kpi" data-icon="✓"><span>Daily checks done</span><strong>${totals.dailyDone} / ${totals.dailyDue}</strong></div>
      <div class="kpi ${totals.fails ? 'kpi-bad' : ''}" data-icon="!"><span>Failed checks</span><strong>${totals.fails}</strong></div>
      <div class="kpi" data-icon="⌫"><span>Wastage, last 7 days</span><strong>${money(totals.wastage)}</strong></div>
      <div class="kpi" data-icon="☺"><span>Staff on shift today</span><strong>${totals.staff}</strong></div>
    </div>` : ''}
    ${trade?.square_connected ? bySite(trade, period) : ''}
    ${leave.count ? `<p class="notice"><strong>${leave.count} holiday request${leave.count === 1 ? '' : 's'}</strong> waiting for approval. <a href="#/timeoff?tab=requests">Review ${leave.count === 1 ? 'it' : 'them'}</a></p>` : ''}
    ${myShifts.length ? `
    <section class="card">
      <h2>Your upcoming shifts</h2>
      <ul class="shift-list">${myShifts.slice(0, 7).map((s) => `<li><strong>${fmtDate(s.date)}</strong> ${s.start_time}–${s.end_time} · ${esc(s.location_name)}</li>`).join('')}</ul>
    </section>` : ''}
    <div class="site-cards">${locs.map((l) => card(l, state, data)).join('')}</div>`;

  el.querySelector('#dash-pdf').addEventListener('click', () => downloadPdf(state, data.date));
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
