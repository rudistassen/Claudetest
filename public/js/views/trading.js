import { attachTip, barChart, legend, lineChart } from '../charts.js';
import { addDays, api, esc, fmtDate, fmtDateTime, money, qs, showError, toast, todayISO } from '../lib.js';
import { fmtPct, LABOUR_TARGET, labourTone } from './sales.js';

const hrs = (h) => (h === null || h === undefined ? '–' : `${Number(h).toLocaleString('en-GB', { maximumFractionDigits: 1 })} h`);
const signed = (h) => (h > 0 ? `+${hrs(h)}` : h < 0 ? `−${hrs(-h)}` : hrs(0));
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
const moneyShort = (v) => (v >= 1000 ? `£${(v / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}k` : `£${Math.round(v)}`);
const PRESETS = [[7, 'Last 7 days'], [14, 'Last 14 days'], [28, 'Last 28 days'], [90, 'Last 90 days']];

const tabs = (active, scope) => `<div class="tabs">${[['trading', 'Overview'], ['trading/heatmap', 'Labour heatmap']]
  .map(([p, l]) => `<a href="#/${p}${scope ? qs({ scope }) : ''}" class="${active === p ? 'active' : ''}">${l}</a>`).join('')}</div>`;

// Clocked minus rostered hours: small differences are normal, big ones are worth a look.
function varianceTone(v, rostered) {
  const limit = Math.max(1, rostered * 0.1);
  return Math.abs(v) <= limit ? '' : v > 0 ? 'bad' : 'warn';
}

export async function render(ctx) {
  const { el, state, query, stale } = ctx;
  const to = query.to || todayISO();
  const from = query.from || addDays(to, -6);
  const scope = state.isAdmin ? (query.scope ?? 'all') : 'site';
  const data = await api(`/trading${qs({ from, to, location_id: scope === 'all' ? undefined : state.locationId })}`);
  if (stale()) return;
  const t = data.totals;
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const hasLabour = data.labour_synced;
  const css = getComputedStyle(document.documentElement);
  const c1 = css.getPropertyValue('--series-1').trim() || '#2a78d6';
  const c2 = css.getPropertyValue('--series-2').trim() || '#eb6834';

  el.innerHTML = `
    <div class="page-head">
      <h1>Trading</h1>
      <div class="actions">
        <span class="muted small">${data.last_sync ? `Square synced ${fmtDateTime(data.last_sync.finished_at)}` : 'Not synced yet'}</span>
        ${data.square_connected && state.can('sales.sync') ? '<button class="btn" id="sync">Sync now</button>' : ''}
      </div>
    </div>
    ${tabs('trading', state.isAdmin ? scope : undefined)}
    ${!data.square_connected ? `<p class="notice">Square isn’t connected yet. ${state.isAdmin ? 'See <a href="#/admin/square">Setup → Square</a>.' : 'Ask an admin to connect it.'}</p>` : ''}
    ${data.square_connected && data.unlinked.length ? `<p class="notice">Not linked to Square: ${esc(data.unlinked.join(', '))}.</p>` : ''}
    ${data.square_connected && !hasLabour ? `<p class="notice">No clock-ins from Square yet, so labour below is from the rota only. Clock-ins come from Square Team (Timecards); the access token needs the <code>TIMECARDS_READ</code> and <code>EMPLOYEES_READ</code> permissions.${data.last_sync?.message ? ` Last sync: ${esc(data.last_sync.message)}` : ''}</p>` : ''}
    <form class="filters" id="range">
      <select name="preset" aria-label="Date range">
        ${PRESETS.map(([n, label]) => `<option value="${n}" ${to === todayISO() && span === n ? 'selected' : ''}>${label}</option>`).join('')}
        <option value="" ${PRESETS.some(([n]) => to === todayISO() && span === n) ? '' : 'selected'}>Custom</option>
      </select>
      <input type="date" name="from" value="${from}" aria-label="From"> <span>to</span> <input type="date" name="to" value="${to}" max="${todayISO()}" aria-label="To">
      ${state.isAdmin ? `<select name="scope" aria-label="Sites"><option value="all" ${scope === 'all' ? 'selected' : ''}>All sites</option><option value="site" ${scope === 'site' ? 'selected' : ''}>${esc(state.location?.name ?? 'This site')}</option></select>` : ''}
      <button class="btn" type="submit">Update</button>
    </form>

    <div class="kpis">
      <div class="kpi"><span>Net sales (ex VAT)</span><strong>${money(t.net_sales)}</strong><small>${t.orders} transactions · avg ${t.avg_spend === null ? '–' : money(t.avg_spend)}</small></div>
      <div class="kpi kpi-${labourTone(hasLabour ? t.labour_pct : t.rostered_labour_pct)}"><span>Labour % (${hasLabour ? 'clocked' : 'rostered'})</span>
        <strong>${fmtPct(hasLabour ? t.labour_pct : t.rostered_labour_pct)}</strong><small>${hasLabour ? `Rostered ${fmtPct(t.rostered_labour_pct)} · target ${LABOUR_TARGET}%` : `Target ${LABOUR_TARGET}%`}</small></div>
      ${hasLabour ? `
      <div class="kpi"><span>Labour cost (clocked)</span><strong>${money(t.clocked_cost)}</strong><small>Rostered ${money(t.rostered_cost)}</small></div>
      <div class="kpi"><span>Hours clocked</span><strong>${hrs(t.clocked_hours)}</strong><small class="tone-${varianceTone(t.hours_variance, t.rostered_hours)}">${signed(t.hours_variance)} vs ${hrs(t.rostered_hours)} rostered</small></div>
      <div class="kpi"><span>Sales per labour hour</span><strong>${t.sales_per_labour_hour === null ? '–' : money(t.sales_per_labour_hour)}</strong><small>Net sales ÷ hours clocked</small></div>`
      : `<div class="kpi"><span>Labour cost (rostered)</span><strong>${money(t.rostered_cost)}</strong><small>${hrs(t.rostered_hours)} rostered</small></div>`}
    </div>

    <div class="two-col">
      <section class="card">
        <h2>Net sales by day</h2>
        <div class="chart" id="chart-sales"></div>
      </section>
      <section class="card">
        <h2>Labour as % of sales</h2>
        ${legend([
          ...(hasLabour ? [{ label: 'Clocked (actual)', color: c1 }] : []),
          { label: 'Rostered', color: hasLabour ? c2 : c1 },
          { label: `Target ${LABOUR_TARGET}%`, color: 'var(--muted)', kind: 'dash' },
        ])}
        <div class="chart" id="chart-labour"></div>
      </section>
    </div>

    <section class="card">
      <h2>By hour of the day <span class="muted small">average over ${data.trading_days} trading day${data.trading_days === 1 ? '' : 's'}${scope === 'all' && data.locations.length > 1 ? ', all sites together' : ''}</span></h2>
      ${data.hours.length ? `
      <div class="two-col">
        <div><h3>Net sales per hour</h3><div class="chart" id="chart-hour-sales"></div></div>
        <div><h3>${hasLabour ? 'Staff on the clock' : 'Staff on the clock (no clock-ins yet)'}</h3><div class="chart" id="chart-hour-staff"></div></div>
      </div>
      <p class="muted small">Line the two up to spot quiet hours with too many people on, or rushes with too few. Hover a bar for sales per labour hour.</p>`
      : '<p class="muted">No sales in this period.</p>'}
    </section>

    ${data.clocked_in.length ? `
    <section class="card">
      <h2>Clocked in now (${data.clocked_in.length})</h2>
      <ul class="shift-list">${data.clocked_in.map((c) => `<li><strong>${esc(c.name)}</strong> since ${esc(c.since)} · ${hrs(c.hours)}${scope === 'all' ? ` · ${esc(c.location)}` : ''}</li>`).join('')}</ul>
    </section>` : ''}

    <section class="card">
      <h2>By day</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th class="num">Net sales</th><th class="num">Orders</th>
          ${hasLabour ? '<th class="num">Hours clocked</th><th class="num">Rostered</th><th class="num">Labour (clocked)</th><th class="num">Labour %</th><th class="num">Sales / labour hr</th>' : ''}
          <th class="num">Rostered labour %</th></tr></thead>
        <tbody>${data.days.map((d) => `<tr>
          <td>${fmtDate(d.date)}</td><td class="num">${money(d.net_sales)}</td><td class="num">${d.orders}</td>
          ${hasLabour ? `<td class="num">${hrs(d.clocked_hours)}</td><td class="num">${hrs(d.rostered_hours)}</td><td class="num">${money(d.clocked_cost)}</td>
          <td class="num"><span class="tone-${labourTone(d.labour_pct)}">${fmtPct(d.labour_pct)}</span></td>
          <td class="num">${d.sales_per_labour_hour === null ? '–' : money(d.sales_per_labour_hour)}</td>` : ''}
          <td class="num"><span class="tone-${labourTone(d.rostered_labour_pct)}">${fmtPct(d.rostered_labour_pct)}</span></td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">Labour % only includes days that have both Square sales and labour. Clocked labour uses the wage set on the job in Square, or the person’s hourly rate here. Today counts up to now.</p>
    </section>

    ${data.locations.length > 1 ? `
    <section class="card">
      <h2>By site</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Site</th><th class="num">Net sales</th><th class="num">Avg spend</th>
          ${hasLabour ? '<th class="num">Hours clocked</th><th class="num">vs rota</th><th class="num">Labour %</th><th class="num">Sales / labour hr</th>' : ''}
          <th class="num">Rostered labour %</th></tr></thead>
        <tbody>${[...data.locations].sort((a, b) => b.net_sales - a.net_sales).map((l) => `<tr>
          <td>${esc(l.name)}${l.linked ? '' : ' <small class="muted">not linked</small>'}</td><td class="num">${money(l.net_sales)}</td>
          <td class="num">${l.avg_spend === null ? '–' : money(l.avg_spend)}</td>
          ${hasLabour ? `<td class="num">${hrs(l.clocked_hours)}</td><td class="num"><span class="tone-${varianceTone(l.hours_variance, l.rostered_hours)}">${signed(l.hours_variance)}</span></td>
          <td class="num"><span class="tone-${labourTone(l.labour_pct)}">${fmtPct(l.labour_pct)}</span></td>
          <td class="num">${l.sales_per_labour_hour === null ? '–' : money(l.sales_per_labour_hour)}</td>` : ''}
          <td class="num"><span class="tone-${labourTone(l.rostered_labour_pct)}">${fmtPct(l.rostered_labour_pct)}</span></td></tr>`).join('')}</tbody>
      </table></div>
    </section>` : ''}

    ${hasLabour && data.staff.length ? `
    <section class="card">
      <h2>Rota vs clock-ins</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Person</th>${scope === 'all' ? '<th>Site</th>' : ''}<th class="num">Rostered</th><th class="num">Clocked</th><th class="num">Difference</th>
          <th class="num">Late starts</th><th class="num">Missed shifts</th><th class="num">Not on rota</th></tr></thead>
        <tbody>${data.staff.map((p) => `<tr>
          <td>${esc(p.name)}</td>${scope === 'all' ? `<td>${esc(p.location)}</td>` : ''}
          <td class="num">${hrs(p.rostered_hours)}</td><td class="num">${hrs(p.clocked_hours)}</td>
          <td class="num"><span class="tone-${varianceTone(p.variance, p.rostered_hours)}">${signed(p.variance)}</span></td>
          <td class="num">${p.late ? `<span class="tone-warn">${p.late}</span> <small class="muted inline">${Math.round(p.late_minutes / p.late)} min avg</small>` : '0'}</td>
          <td class="num">${p.missed ? `<span class="tone-bad">${p.missed}</span>` : '0'}</td>
          <td class="num">${p.unrostered ? `<span class="tone-warn">${p.unrostered}</span>` : '0'}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">Late = clocked in more than 5 minutes after the rostered start. Missed = rostered but no clock-in that day. Not on rota = clocked in on a day with no shift. People are matched to Square team members by email address, then by name.</p>
    </section>` : ''}`;

  const days = data.days;
  barChart(el.querySelector('#chart-sales'), {
    data: days,
    label: (d) => fmtDate(d.date, { day: 'numeric', month: 'short' }),
    title: (d) => fmtDate(d.date),
    value: (d) => d.net_sales,
    fmt: money,
    fmtAxis: moneyShort,
    tipRows: (d) => [{ value: money(d.net_sales), label: 'net sales' }, { value: String(d.orders), label: 'orders' }],
    color: c1,
    ariaLabel: 'Net sales by day',
  });
  lineChart(el.querySelector('#chart-labour'), {
    data: days,
    label: (d) => fmtDate(d.date, { day: 'numeric', month: 'short' }),
    title: (d) => fmtDate(d.date),
    series: [
      ...(hasLabour ? [{ name: 'clocked', value: (d) => d.labour_pct, color: c1 }] : []),
      { name: 'rostered', value: (d) => d.rostered_labour_pct, color: hasLabour ? c2 : c1 },
    ],
    fmt: fmtPct,
    fmtAxis: (v) => `${Math.round(v)}%`,
    reference: { value: LABOUR_TARGET },
    ariaLabel: 'Labour as a percentage of net sales by day',
  });
  if (data.hours.length) {
    const hourTip = (h) => [
      { value: money(h.avg_net_sales), label: 'net sales' },
      { value: String(h.avg_orders), label: 'orders' },
      { value: String(h.avg_staff), label: 'staff on the clock' },
      { value: h.sales_per_labour_hour === null ? '–' : money(h.sales_per_labour_hour), label: 'sales per labour hour' },
    ];
    const common = { data: data.hours, label: (h) => hourLabel(h.hour), title: (h) => `${hourLabel(h.hour)}–${hourLabel((h.hour + 1) % 24)}`, tipRows: hourTip, color: c1, height: 180 };
    barChart(el.querySelector('#chart-hour-sales'), { ...common, value: (h) => h.avg_net_sales, fmt: money, fmtAxis: moneyShort, ariaLabel: 'Average net sales by hour of the day' });
    barChart(el.querySelector('#chart-hour-staff'), { ...common, value: (h) => h.avg_staff, fmt: (v) => String(Math.round(v * 10) / 10), ariaLabel: 'Average staff on the clock by hour of the day' });
  }

  const form = el.querySelector('#range');
  form.preset.addEventListener('change', () => {
    const n = Number(form.preset.value);
    if (!n) return;
    form.to.value = todayISO();
    form.from.value = addDays(todayISO(), -(n - 1));
    form.requestSubmit();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    ctx.navigate(`trading${qs({ from: form.from.value, to: form.to.value, scope: form.scope?.value })}`);
  });
  el.querySelector('#sync')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Syncing…';
    try {
      const syncFrom = !state.isAdmin && span > 8 ? addDays(to, -7) : from;
      const r = await api('/square/sync', { method: 'POST', body: { from: syncFrom, to } });
      toast(`Synced ${r.orders} order(s)${r.timecards === null ? '' : ` and ${r.timecards} clock-in(s)`}`);
      if (r.warning) showError(new Error(r.warning));
      ctx.rerender();
    } catch (err) {
      showError(err);
      e.target.disabled = false;
      e.target.textContent = 'Sync now';
    }
  });
}

// --- Labour heatmap: labour % by day of the week and hour of the day ---

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const HEAT_PRESETS = [[28, 'Last 4 weeks'], [56, 'Last 8 weeks'], [91, 'Last 13 weeks']];
// The colour scale runs from fully blue at FLOOR% (well under target), through grey at the target, to fully red at CEIL%.
const FLOOR = 10;
const CEIL = 60;

// Diverging scale around the target: -1 (far under) … 0 (on target) … 1 (far over).
function heat(p) {
  if (p === null || p === undefined) return null;
  return p <= LABOUR_TARGET ? -Math.min(1, (LABOUR_TARGET - p) / (LABOUR_TARGET - FLOOR)) : Math.min(1, (p - LABOUR_TARGET) / (CEIL - LABOUR_TARGET));
}

function heatStyle(p) {
  const t = heat(p);
  if (t === null) return '';
  const pole = t < 0 ? 'var(--div-neg)' : 'var(--div-pos)';
  const strong = Math.abs(t) > 0.62;
  return `background: color-mix(in oklab, ${pole} ${Math.round(Math.abs(t) * 100)}%, var(--div-mid)); color: ${strong ? 'var(--div-ink-strong)' : 'var(--text)'}`;
}

const pctShort = (p) => (p === null || p === undefined ? '' : `${Math.round(p)}%`);

function heatCell(c, attrs = '') {
  if (!c) return `<td class="hm-empty"></td>`;
  if (!c.net_sales) return `<td class="hm-cell hm-nosales" tabindex="0" ${attrs}>${c.labour_hours ? '–' : ''}</td>`;
  return `<td class="hm-cell" tabindex="0" style="${heatStyle(c.labour_pct)}" ${attrs}>${pctShort(c.labour_pct)}</td>`;
}

export async function renderHeatmap(ctx) {
  const { el, state, query, stale } = ctx;
  const to = query.to || todayISO();
  const from = query.from || addDays(to, -27);
  const scope = state.isAdmin ? (query.scope ?? 'all') : 'site';
  const data = await api(`/trading/heatmap${qs({ from, to, basis: query.basis, location_id: scope === 'all' ? undefined : state.locationId })}`);
  if (stale()) return;
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const byKey = new Map(data.cells.map((c) => [`${c.dow}|${c.hour}`, c]));
  const hourTotal = new Map(data.hour_totals.map((c) => [c.hour, c]));
  const basisLabel = data.basis === 'clocked' ? 'clocked (actual)' : 'rostered';
  // Slots with the most labour for their sales – where a change to the rota would save the most.
  const worst = data.cells.filter((c) => c.net_sales > 0 && c.labour_pct > LABOUR_TARGET)
    .map((c) => ({ ...c, excess: c.labour_cost - (c.net_sales * LABOUR_TARGET) / 100 }))
    .sort((a, b) => b.excess - a.excess).slice(0, 6);
  const noSales = data.cells.filter((c) => !c.net_sales && c.labour_cost > 0).reduce((t, c) => t + c.labour_cost, 0);

  el.innerHTML = `
    <div class="page-head">
      <h1>Trading</h1>
      <div class="actions"><button class="btn" id="print">Print</button></div>
    </div>
    ${tabs('trading/heatmap', state.isAdmin ? scope : undefined)}
    ${!data.square_connected ? `<p class="notice">Square isn’t connected yet, so there are no sales to compare labour with.</p>` : ''}
    ${data.square_connected && data.unlinked.length ? `<p class="notice">Not linked to Square: ${esc(data.unlinked.join(', '))}.</p>` : ''}
    <form class="filters" id="range">
      <select name="preset" aria-label="Date range">
        ${HEAT_PRESETS.map(([n, label]) => `<option value="${n}" ${to === todayISO() && span === n ? 'selected' : ''}>${label}</option>`).join('')}
        <option value="" ${HEAT_PRESETS.some(([n]) => to === todayISO() && span === n) ? '' : 'selected'}>Custom</option>
      </select>
      <input type="date" name="from" value="${from}" aria-label="From"> <span>to</span> <input type="date" name="to" value="${to}" max="${todayISO()}" aria-label="To">
      ${state.isAdmin ? `<select name="scope" aria-label="Sites"><option value="all" ${scope === 'all' ? 'selected' : ''}>All sites</option><option value="site" ${scope === 'site' ? 'selected' : ''}>${esc(state.location?.name ?? 'This site')}</option></select>` : ''}
      <select name="basis" aria-label="Labour">
        <option value="clocked" ${data.basis === 'clocked' ? 'selected' : ''} ${data.labour_synced ? '' : 'disabled'}>Clocked labour</option>
        <option value="rostered" ${data.basis === 'rostered' ? 'selected' : ''}>Rostered labour</option>
      </select>
      <button class="btn" type="submit">Update</button>
    </form>

    <section class="card">
      <h2>Labour % by day and hour</h2>
      <p class="muted small">${basisLabel[0].toUpperCase() + basisLabel.slice(1)} labour cost as a % of net sales in each hour, added up over ${fmtDate(from, { day: 'numeric', month: 'short' })} – ${fmtDate(to, { day: 'numeric', month: 'short', year: 'numeric' })}. Overall: <strong class="tone-${labourTone(data.totals.labour_pct)}">${fmtPct(data.totals.labour_pct)}</strong> of ${money(data.totals.net_sales)}.</p>
      <div class="hm-legend" aria-hidden="true">
        <span>≤${FLOOR}%</span>
        <div class="hm-legend-bar"><i style="left:${((LABOUR_TARGET - FLOOR) / (CEIL - FLOOR)) * 100}%"></i></div>
        <span>≥${CEIL}%</span>
        <span class="hm-legend-note">Blue is under your ${LABOUR_TARGET}% target, grey is on target, red is over. <span class="hm-swatch hm-nosales"></span> labour but no sales.</span>
      </div>
      ${data.cells.length ? `
      <div class="table-wrap hm-wrap"><table class="hm">
        <thead><tr><th></th>${data.hours.map((h) => `<th>${String(h).padStart(2, '0')}</th>`).join('')}<th class="hm-total-col">Day</th></tr></thead>
        <tbody>
          ${WEEKDAYS.map((name, dow) => `<tr>
            <th scope="row">${name.slice(0, 3)}<small>${data.days_per_weekday[dow]} day${data.days_per_weekday[dow] === 1 ? '' : 's'}</small></th>
            ${data.hours.map((h) => heatCell(byKey.get(`${dow}|${h}`), `data-k="${dow}|${h}"`)).join('')}
            ${heatCell(data.weekdays[dow].net_sales || data.weekdays[dow].labour_hours ? data.weekdays[dow] : null, `data-day="${dow}"`).replace('hm-cell', 'hm-cell hm-total-col')}
          </tr>`).join('')}
          <tr class="hm-total-row"><th scope="row">All week</th>
            ${data.hours.map((h) => heatCell(hourTotal.get(h), `data-hour="${h}"`)).join('')}
            ${heatCell(data.totals, 'data-all').replace('hm-cell', 'hm-cell hm-total-col')}
          </tr>
        </tbody>
      </table></div>
      <p class="muted small">Hours are when the sale was taken and when people were on the clock. Only days with Square sales are counted, so closed days don’t show as 0% or 100%+. Hover or tap a square for the figures.</p>`
      : '<p class="muted">No sales or labour in this period.</p>'}
    </section>

    ${worst.length || noSales ? `
    <section class="card">
      <h2>Where labour runs highest</h2>
      ${worst.length ? `<div class="table-wrap"><table>
        <thead><tr><th>When</th><th class="num">Labour %</th><th class="num">Labour</th><th class="num">Net sales</th><th class="num">Over target by</th></tr></thead>
        <tbody>${worst.map((c) => `<tr><td>${WEEKDAYS[c.dow]}s ${hourLabel(c.hour)}–${hourLabel((c.hour + 1) % 24)}</td>
          <td class="num"><span class="tone-${labourTone(c.labour_pct)}">${fmtPct(c.labour_pct)}</span></td>
          <td class="num">${money(c.labour_cost)} <small class="muted inline">${hrs(c.labour_hours)}</small></td><td class="num">${money(c.net_sales)}</td>
          <td class="num">${money(c.excess)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">“Over target by” is how much less labour would have brought that hour to ${LABOUR_TARGET}% over the whole period, the biggest savings first.</p>` : ''}
      ${noSales ? `<p>${money(noSales)} of labour was in hours with no sales at all, such as opening and closing. That’s often setting up and cleaning down, but worth a look.</p>` : ''}
    </section>` : ''}`;

  const tipRows = (c) => [
    { value: c.net_sales ? fmtPct(c.labour_pct) : 'no sales', label: 'labour %' },
    { value: money(c.labour_cost), label: `${basisLabel} labour · ${hrs(c.labour_hours)}` },
    { value: money(c.net_sales), label: `net sales · ${c.orders} orders` },
  ];
  el.querySelectorAll('[data-k]').forEach((td) => {
    const c = byKey.get(td.dataset.k);
    if (!c) return;
    attachTip(td, () => `${WEEKDAYS[c.dow]}s ${hourLabel(c.hour)}–${hourLabel((c.hour + 1) % 24)} · ${data.days_per_weekday[c.dow]} day(s)`, () => tipRows(c));
  });
  el.querySelectorAll('[data-day]').forEach((td) => {
    const c = data.weekdays[Number(td.dataset.day)];
    attachTip(td, () => `${WEEKDAYS[c.dow]}s, all day`, () => tipRows(c));
  });
  el.querySelectorAll('[data-hour]').forEach((td) => {
    const c = hourTotal.get(Number(td.dataset.hour));
    attachTip(td, () => `${hourLabel(c.hour)}–${hourLabel((c.hour + 1) % 24)}, every day`, () => tipRows(c));
  });
  const all = el.querySelector('[data-all]');
  if (all) attachTip(all, () => 'Whole period', () => tipRows(data.totals));

  const form = el.querySelector('#range');
  const go = () => ctx.navigate(`trading/heatmap${qs({ from: form.from.value, to: form.to.value, scope: form.scope?.value, basis: form.basis.value })}`);
  form.preset.addEventListener('change', () => {
    const n = Number(form.preset.value);
    if (!n) return;
    form.to.value = todayISO();
    form.from.value = addDays(todayISO(), -(n - 1));
    go();
  });
  form.basis.addEventListener('change', go);
  form.addEventListener('submit', (e) => { e.preventDefault(); go(); });
  el.querySelector('#print').addEventListener('click', () => window.print());
}
