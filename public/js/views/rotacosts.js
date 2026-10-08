import { addDays, api, esc, fmtDate, money, qs, siteFilter, siteScope, todayISO, weekStart } from '../lib.js';
import { fmtPct, labourTone } from './sales.js';

// Reporting → Rota costs: each site's rota cost for a week against a labour budget of 30% of forecast sales.

const whole = (n) => (n === null ? '–' : money(Math.round(n)).replace(/\.00$/, ''));
// Over budget is shown in red, under in green.
const diff = (d) => (d === null ? '<span class="muted">–</span>'
  : `<span class="${d > 0 ? 'tone-bad' : 'tone-good'}">${d > 0 ? '+' : '−'}${money(Math.abs(d))}</span> <small class="muted">${d > 0 ? 'over' : 'under'}</small>`);
const pctCell = (p) => `<span class="tone-${labourTone(p)}">${fmtPct(p)}</span>`;

export async function render(ctx) {
  const { el, state, query, stale, navigate } = ctx;
  const week = weekStart(query.week ?? todayISO());
  const scope = siteScope(state, query.scope);
  const published = query.rota === 'published';
  const data = await api(`/reports/rota-costs${qs({ week, location_id: scope === 'all' ? undefined : state.locationId, published: published ? '1' : undefined })}`);
  if (stale()) return;
  const t = data.totals;
  const showActual = t.actual_sales !== null;
  const go = (extra) => navigate(`rota-costs${qs({ week, scope: query.scope, rota: query.rota, ...extra })}`);

  const row = (label, x, { strong = false, sub = '' } = {}) => `<tr${strong ? ' class="total-row"' : ''}>
    <th scope="row">${strong ? `<strong>${label}</strong>` : label}${sub}</th>
    <td class="num">${x.hours}</td>
    <td class="num"><strong>${money(x.cost)}</strong></td>
    <td class="num">${whole(x.forecast)}</td>
    <td class="num">${x.sales_budget === null ? '–' : x.budgeted ? `<strong class="is-budget">${whole(x.sales_budget)}</strong>` : `<span class="muted" title="No budget set – the forecast is used">${whole(x.sales_budget)}</span>`}</td>
    <td class="num">${x.budget === null ? '–' : money(x.budget)}</td>
    <td class="num">${diff(x.difference)}</td>
    <td class="num">${pctCell(x.labour_pct)}</td>
    ${showActual ? `<td class="num">${x.actual_sales === null ? '–' : money(x.actual_sales)}</td>` : ''}
  </tr>`;
  const head = (first) => `<thead><tr><th>${first}</th><th class="num">Hours</th><th class="num">Rota cost</th><th class="num">Forecast net sales</th><th class="num">Sales budget (net)</th>
    <th class="num">${data.target_pct}% labour budget</th><th class="num">Difference</th><th class="num">Rota labour %</th>${showActual ? '<th class="num">Actual net sales</th>' : ''}</tr></thead>`;

  el.innerHTML = `
    <div class="page-head">
      <h1>Rota costs</h1>
      <div class="actions">
        <button class="btn" data-week="-7" aria-label="Previous week">‹</button>
        <input type="date" id="rc-week" value="${week}" aria-label="Week">
        <button class="btn" data-week="7" aria-label="Next week">›</button>
        ${week !== weekStart(todayISO()) ? '<button class="btn" data-week="0">This week</button>' : ''}
      </div>
    </div>
    <form class="filters" id="rc-filters">
      ${siteFilter(state, scope)}
      <select name="rota" aria-label="Which rota">
        <option value="">Rota as planned (including unpublished changes)</option>
        <option value="published" ${published ? 'selected' : ''}>Published rota only</option>
      </select>
    </form>
    <h2 class="day-title">Week commencing ${fmtDate(week, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h2>
    <div class="kpis">
      <div class="kpi" data-icon="£"><span>Rota cost</span><strong>${money(t.cost)}</strong><small>${t.hours} hours</small></div>
      <div class="kpi"><span>${t.budgeted ? 'Sales budget (net)' : 'Forecast net sales'}</span><strong>${whole(t.sales_budget)}</strong>${t.budgeted ? `<small>forecast ${whole(t.forecast)} net</small>` : ''}</div>
      <div class="kpi"><span>Labour budget at ${data.target_pct}%</span><strong>${t.budget === null ? '–' : money(t.budget)}</strong></div>
      <div class="kpi ${t.difference > 0 ? 'kpi-bad' : ''}"><span>${t.difference === null ? 'Difference' : t.difference > 0 ? 'Over budget by' : 'Under budget by'}</span>
        <strong>${t.difference === null ? '–' : money(Math.abs(t.difference))}</strong><small>Rota labour ${fmtPct(t.labour_pct)}</small></div>
    </div>
    ${!published && data.unpublished ? `<p class="notice">${data.unpublished} rota change${data.unpublished === 1 ? ' isn’t' : 's aren’t'} published yet – included here. Choose “Published rota only” to leave ${data.unpublished === 1 ? 'it' : 'them'} out.</p>` : ''}
    <section class="card">
      <h2>By site</h2>
      <div class="table-wrap"><table class="rota-costs">
        ${head('Site')}
        <tbody>${data.sites.map((s) => row(esc(s.name), s)).join('')}</tbody>
        ${data.sites.length > 1 ? `<tfoot>${row('All sites', t, { strong: true })}</tfoot>` : ''}
      </table></div>
    </section>
    <section class="card">
      <h2>By day${data.sites.length > 1 ? ' <span class="muted small">all sites shown together</span>' : ''}</h2>
      <div class="table-wrap"><table class="rota-costs">
        ${head('Day')}
        <tbody>${data.days.map((d) => row(fmtDate(d.date), d, { sub: d.bank_holiday ? `<small class="bank-hol">${esc(d.bank_holiday)}</small>` : '' })).join('')}</tbody>
      </table></div>
      <p class="muted small">Rota cost = each shift’s hours (less unpaid breaks) × the person’s hourly rate.
        Forecast net sales = that weekday’s average net sales over the ${data.forecast_weeks} weeks to ${fmtDate(data.forecast_to)}, leaving out bank holidays and days with no sales.
        Sales budget = the budget set under <a href="#/rota/budget?week=${week}">Rota → Sales budget</a>, or the forecast for days without one (shown faded).
        Labour budget = ${data.target_pct}% of the sales budget; “over” means the rota costs more than that.${showActual ? ' Actual net sales are from Square, so far.' : ''} All sales here are net: after discounts, excluding VAT.</p>
    </section>`;

  el.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.week);
    go({ week: n === 0 ? weekStart(todayISO()) : addDays(week, n) });
  }));
  el.querySelector('#rc-week').addEventListener('change', (e) => e.target.value && go({ week: weekStart(e.target.value) }));
  const form = el.querySelector('#rc-filters');
  form.addEventListener('submit', (e) => { e.preventDefault(); go({ scope: form.scope?.value, rota: form.rota.value || undefined }); });
  form.rota.addEventListener('change', () => form.requestSubmit());
}
