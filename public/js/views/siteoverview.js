import { pairedBarChart } from '../charts.js';
import { addDays, api, esc, fmtDate, money, qs, siteColour, todayISO } from '../lib.js';
import { categoryCard, chosenTimeframe, timeframe, timeframeBar, wireCategories, wireTimeframe } from './dashboard.js';
import { fmtPct, LABOUR_TARGET, labourTone } from './sales.js';

// Reporting → Site overview: everything about one site over a timeframe – sales and labour against the span before,
// sales by day (or hour), sales by category, each person's rota against their clock-ins, and the daily checks and
// wastage. Opened from the HQ Dashboard's "Open site" button too (?site=).

const TF_KEY = 'atlas:site-overview-timeframe';
const hrs = (h) => `${Number(h ?? 0).toLocaleString('en-GB', { maximumFractionDigits: 1 })} h`;
const whole = (v) => (v >= 1000 ? `£${(v / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}k` : `£${Math.round(v)}`);

function change(now, then, { goodUp = true, pts = false } = {}) {
  if (now === null || now === undefined || !then) return '<span class="muted">–</span>';
  const d = pts ? now - then : ((now - then) / then) * 100;
  if (Math.abs(d) < 0.05) return '<span class="muted">■ no change</span>';
  const tone = Math.abs(d) < 0.5 ? 'muted' : (d > 0) === goodUp ? 'tone-good' : 'tone-bad';
  return `<span class="${tone}">${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}${pts ? ' pts' : '%'}</span>`;
}

export async function render({ el, state, query, stale, navigate }) {
  const today = todayISO();
  const sites = state.locations.filter((l) => l.active);
  const picked = Number(query.site);
  const site = sites.some((l) => l.id === picked) ? picked : sites.some((l) => l.id === state.locationId) ? state.locationId : sites[0]?.id;
  if (!site) { el.innerHTML = '<div class="page-head"><h1>Site overview</h1></div><div class="card empty">You don’t have access to any sites.</div>'; return; }
  const siteName = sites.find((l) => l.id === site)?.name ?? '';
  const tf = chosenTimeframe(query, TF_KEY);
  const t = timeframe(tf, query, today);
  const d0 = t.to;
  const ranged = t.period !== 'today';
  const range = t.range;
  const isToday = d0 === today;
  // What it's compared with: the same weekday last week (up to now, today), last week to the same point, or the span before.
  const untilNow = isToday ? Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date())) + 1 : undefined;
  const prevSpan = t.period === 'today' ? { from: addDays(d0, -7), to: addDays(d0, -7), until: untilNow }
    : t.period === 'wtd' ? { from: range.prevFrom, to: addDays(d0, -7), until: untilNow }
      : range.prevTo ? { from: range.prevFrom, to: range.prevTo } : null;
  // until: the last day only up to that hour (from the hourly figures), so today is compared fairly.
  const trading = (from, to, until) => api(`/trading${qs({ from, to, location_id: site, until })}`);
  const [cur, prev, day] = await Promise.all([
    trading(ranged ? range.from : d0, d0),
    prevSpan ? trading(prevSpan.from, prevSpan.to, prevSpan.until) : null,
    api(`/dashboard${qs({ location_id: site, date: isToday ? undefined : d0, from: ranged ? range.from : d0 })}`),
  ]);
  if (stale()) return;
  const T = cur.totals;
  const P = prev?.totals ?? null;
  const synced = cur.labour_synced;
  const labourOf = (x) => (x ? (synced && x.labour_pct !== null ? x.labour_pct : x.rostered_labour_pct) : null);
  const costOf = (x) => (x ? (synced ? x.clocked_cost : x.rostered_cost) : null);
  const loc = day.locations[0] ?? {};
  const checks = loc.period?.daily ?? loc.daily ?? { done: 0, due: 0, fails: 0 };
  const wastage = loc.period?.wastage ?? null;
  const staff = [...(cur.staff ?? [])].sort((a, b) => (b.clocked_hours + b.rostered_hours) - (a.clocked_hours + a.rostered_hours));
  const cmp = prevSpan ? (t.period === 'today' ? `vs ${fmtDate(prevSpan.from, { weekday: 'short', day: 'numeric', month: 'short' })}${isToday ? ' at this time' : ''}` : `vs ${t.compare}`) : '';
  const tile = (label, value, sub = '', tone = '') => `<div class="kpi ${tone}"><span>${label}</span><strong>${value}</strong>${sub ? `<small class="kpi-vs">${sub}</small>` : ''}</div>`;

  el.innerHTML = `<div class="site-overview" style="--site: ${siteColour(siteName, site)}">
    <div class="page-head"><h1>Site overview</h1>
      ${sites.length > 1 ? `<form class="filters" id="so-site"><select name="site" aria-label="Site">${sites.map((l) => `<option value="${l.id}" ${l.id === site ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></form>` : ''}</div>
    <p class="so-site"><i class="bs-dot" aria-hidden="true"></i><strong>${esc(siteName)}</strong></p>
    ${timeframeBar(t)}
    ${!cur.square_connected ? '<p class="notice">Square isn’t connected, so there are no sales figures – labour below is from the rota.</p>' : ''}
    <section class="kpis so-kpis">
      ${tile('Gross sales', money(T.gross_sales), `${change(T.gross_sales, P?.gross_sales)} <span class="muted">${esc(cmp)}</span>`)}
      ${tile('Net sales', money(T.net_sales), change(T.net_sales, P?.net_sales))}
      ${tile('Orders', T.orders, `${T.avg_spend !== null ? `${money(T.avg_spend)} average` : ''} ${change(T.orders, P?.orders)}`)}
      ${tile(`Labour % <small class="muted">(${synced ? 'clocked' : 'rota'})</small>`, fmtPct(labourOf(T)), `${change(labourOf(T), labourOf(P), { goodUp: false, pts: true })} <span class="muted">target ${LABOUR_TARGET}%</span>`, `kpi-${labourTone(labourOf(T))}`)}
      ${tile('Labour cost', money(costOf(T)), `${hrs(synced ? T.clocked_hours : T.rostered_hours)} · ${change(costOf(T), costOf(P), { goodUp: false })}`)}
      ${tile('Sales per labour hour', T.sales_per_labour_hour === null ? '–' : money(T.sales_per_labour_hour), change(T.sales_per_labour_hour, P?.sales_per_labour_hour))}
    </section>
    <section class="card"><h2>Gross sales by ${ranged ? 'day' : 'hour'}</h2>
      <div class="chart-legend"><span><i class="chart-legend-bar" style="background:var(--series-1)"></i>${esc(t.name ?? t.title)}</span>${prevSpan ? `<span><i class="chart-legend-bar" style="background:var(--prev-bar)"></i>${esc(cmp.replace(/^vs /, ''))}</span>` : ''}</div>
      <div id="so-chart" class="chart-box"><div class="loading">Loading…</div></div></section>
    <div class="so-grid">
      ${categoryCard()}
      <section class="card so-checks"><h2>Checks &amp; wastage</h2>
        <dl class="so-facts">
          <div><dt>Daily checks done</dt><dd>${checks.done} / ${checks.due}${checks.due ? ` <span class="muted">· ${Math.round((checks.done / checks.due) * 100)}%</span>` : ''}</dd></div>
          <div><dt>Failed checks</dt><dd class="${checks.fails ? 'tone-bad' : ''}">${checks.fails}</dd></div>
          ${wastage === null || wastage === undefined ? '' : `<div><dt>Wastage</dt><dd>${money(wastage)}</dd></div>`}
          <div><dt>Rostered hours</dt><dd>${hrs(T.rostered_hours)} <span class="muted">· ${money(T.rostered_cost)}</span></dd></div>
          ${synced ? `<div><dt>Clocked hours</dt><dd>${hrs(T.clocked_hours)} <span class="muted">· ${money(T.clocked_cost)}</span></dd></div>
          <div><dt>Clocked vs rota</dt><dd class="${T.hours_variance > 0.5 ? 'tone-bad' : ''}">${T.hours_variance > 0 ? '+' : ''}${hrs(T.hours_variance)}</dd></div>` : ''}
        </dl>
        <p class="small"><a href="#/safety">Checks →</a>${state.can('reports.trading') ? ' · <a href="#/trading">Trading →</a>' : ''}</p></section>
    </div>
    <section class="card"><h2>Staff: rota and clock-ins</h2>
      ${staff.length ? `<div class="table-wrap"><table class="so-staff">
        <thead><tr><th>Name</th><th class="num">Rota</th>${synced ? '<th class="num">Clocked</th>' : ''}<th class="num">Shifts</th><th class="num">Late</th><th class="num">Missed</th>${synced ? '<th class="num">Not on rota</th>' : ''}</tr></thead>
        <tbody>${staff.map((p) => `<tr><td><strong>${esc(p.name)}</strong></td><td class="num">${hrs(p.rostered_hours)}</td>${synced ? `<td class="num">${hrs(p.clocked_hours)}</td>` : ''}
          <td class="num">${p.shifts}</td><td class="num ${p.late ? 'tone-warn' : ''}">${p.late || ''}</td><td class="num ${p.missed ? 'tone-bad' : ''}">${p.missed || ''}</td>${synced ? `<td class="num">${p.unrostered || ''}</td>` : ''}</tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">Nobody on the rota or clocked in.</p>'}</section>
  </div>`;

  wireTimeframe(el, { t, tf, today, navigate, page: 'site-overview', key: TF_KEY, keep: { site } });
  el.querySelector('#so-site')?.addEventListener('change', (e) => navigate(`site-overview${qs({ site: e.target.value, tf: query.tf, date: query.date, from: query.from })}`));
  wireCategories(el, { from: ranged ? range.from : d0, to: d0, site, stale, empty: ranged ? 'for this period' : isToday ? 'yet today' : 'for this day' });

  const box = el.querySelector('#so-chart');
  const chart = (rows, label) => pairedBarChart(box, {
    data: rows, label: (r) => r.label, title: (r) => r.title,
    series: [{ name: esc(t.name ?? t.title), value: (r) => r.now, color: 'var(--series-1)' }, { name: esc(cmp.replace(/^vs /, '') || 'before'), value: (r) => r.then, color: 'var(--prev-bar)' }],
    fmt: money, fmtAxis: whole, height: 200, ariaLabel: label,
  });
  if (ranged) {
    if (!T.gross_sales) { box.innerHTML = '<p class="muted small">No sales synced for this period.</p>'; return; }
    const byMonth = cur.days.length > 62;
    if (byMonth) {
      const monthly = (list) => list.reduce((m, d) => m.set(d.date.slice(0, 7), (m.get(d.date.slice(0, 7)) ?? 0) + d.gross_sales), new Map());
      const now = monthly(cur.days);
      const then = [...monthly(prev?.days ?? []).values()];
      chart([...now.entries()].map(([k, v], i) => ({ label: fmtDate(`${k}-01`, { month: 'short' }), title: fmtDate(`${k}-01`, { month: 'long', year: 'numeric' }), now: v, then: then[i] ?? null })), `Gross sales by month at ${siteName}`);
    } else {
      chart(cur.days.map((d, i) => ({ label: cur.days.length > 7 ? String(Number(d.date.slice(8))) : fmtDate(d.date, { weekday: 'short' }), title: fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'long' }),
        now: d.gross_sales, then: prev?.days?.[i]?.gross_sales ?? null })), `Gross sales by day at ${siteName}`);
    }
    return;
  }
  api(`/trading/hourly-compare${qs({ date: d0, location_id: site })}`).then((h) => {
    if (stale() || !box.isConnected) return;
    if (!h.hours.length) { box.innerHTML = `<p class="muted small">No sales synced ${isToday ? 'yet today' : 'for this day'}.</p>`; return; }
    const hh = (n) => String(n).padStart(2, '0');
    chart(h.hours.map((x) => ({ label: hh(x.hour), title: `${hh(x.hour)}:00–${hh(x.hour + 1)}:00`, now: x.today, then: x.last_week })), `Gross sales by hour at ${siteName}`);
  }).catch(() => { if (box.isConnected) box.innerHTML = '<p class="muted small">Couldn’t load the hourly chart.</p>'; });
}
