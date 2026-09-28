import { barChart, legend, lineChart } from '../charts.js';
import { addDays, api, esc, fmtDate, fmtDateTime, money, qs, showError, toast, todayISO } from '../lib.js';
import { fmtPct, LABOUR_TARGET, labourTone } from './sales.js';

const hrs = (h) => (h === null || h === undefined ? '–' : `${Number(h).toLocaleString('en-GB', { maximumFractionDigits: 1 })} h`);
const signed = (h) => (h > 0 ? `+${hrs(h)}` : h < 0 ? `−${hrs(-h)}` : hrs(0));
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
const moneyShort = (v) => (v >= 1000 ? `£${(v / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}k` : `£${Math.round(v)}`);
const PRESETS = [[7, 'Last 7 days'], [14, 'Last 14 days'], [28, 'Last 28 days'], [90, 'Last 90 days']];

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
        ${data.square_connected ? '<button class="btn" id="sync">Sync now</button>' : ''}
      </div>
    </div>
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
