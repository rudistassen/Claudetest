import { api, esc, fmtDate, fmtDateTime, money } from '../lib.js';
import { fmtPct, labourTone } from './sales.js';

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

export async function render({ el, state, navigate, stale }) {
  const [data, myShifts] = await Promise.all([api('/dashboard'), api('/my-shifts')]);
  if (stale()) return;

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
  const hasSales = locs.some((l) => l.sales_today !== null && l.sales_today !== undefined);
  const labourPct = totals.sales > 0 ? (totals.labour / totals.sales) * 100 : null;

  el.innerHTML = `
    <div class="page-head">
      <h1>${state.multiSite ? 'All sites' : esc(state.location?.name ?? 'Dashboard')}</h1>
      <span class="muted">${fmtDate(data.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
    </div>
    ${state.multiSite ? `
    <div class="kpis">
      ${hasSales ? `<div class="kpi"><span>Sales today (ex VAT)</span><strong>${money(totals.sales)}</strong></div>
      <div class="kpi kpi-${labourTone(labourPct)}"><span>Labour today</span><strong>${fmtPct(labourPct)}</strong></div>` : ''}
      <div class="kpi"><span>Daily checks done</span><strong>${totals.dailyDone} / ${totals.dailyDue}</strong></div>
      <div class="kpi ${totals.fails ? 'kpi-bad' : ''}"><span>Failed checks</span><strong>${totals.fails}</strong></div>
      <div class="kpi"><span>Wastage, last 7 days</span><strong>${money(totals.wastage)}</strong></div>
      <div class="kpi"><span>Staff on shift today</span><strong>${totals.staff}</strong></div>
    </div>` : ''}
    ${myShifts.length ? `
    <section class="card">
      <h2>Your upcoming shifts</h2>
      <ul class="shift-list">${myShifts.slice(0, 7).map((s) => `<li><strong>${fmtDate(s.date)}</strong> ${s.start_time}–${s.end_time} · ${esc(s.location_name)}</li>`).join('')}</ul>
    </section>` : ''}
    <div class="site-cards">${locs.map((l) => card(l, state)).join('')}</div>`;

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
