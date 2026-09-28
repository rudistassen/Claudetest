import { addDays, api, esc, fmtDate, fmtDateTime, money, qs, qty, showError, toast, todayISO } from '../lib.js';

// Labour cost as % of net sales: at or under target is good, up to the warning line is amber.
export const LABOUR_TARGET = 30;
const LABOUR_WARN = 35;

export function labourTone(p) {
  if (p === null || p === undefined) return '';
  return p <= LABOUR_TARGET ? 'good' : p <= LABOUR_WARN ? 'warn' : 'bad';
}

export const fmtPct = (p) => (p === null || p === undefined ? '–' : `${p.toFixed(1)}%`);

export async function render(ctx) {
  const { el, state, query, stale } = ctx;
  const to = query.to || todayISO();
  const from = query.from || addDays(to, -6);
  const scope = state.isAdmin ? (query.scope ?? 'all') : 'site';
  const [data, status] = await Promise.all([
    api(`/sales${qs({ from, to, location_id: scope === 'all' ? undefined : state.locationId })}`),
    api('/square/status'),
  ]);
  if (stale()) return;
  const t = data.totals;
  const maxDay = Math.max(1, ...data.days.map((d) => d.net_sales));

  el.innerHTML = `
    <div class="page-head">
      <h1>Sales</h1>
      <div class="actions">
        <span class="muted small">${data.last_sync ? `Square synced ${fmtDateTime(data.last_sync)}` : 'Not synced yet'}</span>
        ${status.configured ? '<button class="btn" id="sync">Sync now</button>' : ''}
      </div>
    </div>
    ${!status.configured ? `<p class="notice">Square isn’t connected yet. ${state.isAdmin ? 'See <a href="#/admin/square">Setup → Square</a>.' : 'Ask an admin to connect it.'}</p>` : ''}
    ${status.configured && data.unlinked.length ? `<p class="notice">Not linked to Square, so no sales shown: ${esc(data.unlinked.join(', '))}. ${state.isAdmin ? '<a href="#/admin/square">Link sites</a>' : ''}</p>` : ''}
    <form class="filters" id="range">
      ${state.isAdmin ? `<select name="scope"><option value="all" ${scope === 'all' ? 'selected' : ''}>All sites</option><option value="site" ${scope === 'site' ? 'selected' : ''}>${esc(state.location?.name ?? 'This site')}</option></select>` : ''}
      <input type="date" name="from" value="${from}"> <span>to</span> <input type="date" name="to" value="${to}" max="${todayISO()}">
      <button class="btn" type="submit">Update</button>
    </form>
    <div class="kpis">
      <div class="kpi"><span>Net sales (ex VAT)</span><strong>${money(t.net_sales)}</strong></div>
      <div class="kpi"><span>Transactions</span><strong>${t.orders}</strong></div>
      <div class="kpi"><span>Average spend</span><strong>${t.avg_spend === null ? '–' : money(t.avg_spend)}</strong></div>
      <div class="kpi kpi-${labourTone(t.labour_pct)}"><span>Labour (rostered) · ${money(t.labour_cost)}</span><strong>${fmtPct(t.labour_pct)}</strong></div>
      <div class="kpi"><span>Wastage · ${money(t.wastage)}</span><strong>${fmtPct(t.wastage_pct)}</strong></div>
    </div>
    <section class="card">
      <h2>By day</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th class="bar-col">Net sales</th><th class="num">Orders</th><th class="num">Avg spend</th><th class="num">Labour</th><th class="num">Labour %</th><th class="num">Wastage %</th></tr></thead>
        <tbody>${data.days.map((d) => `<tr>
          <td>${fmtDate(d.date)}</td>
          <td class="bar-col"><span class="inline-bar"><span style="width:${(d.net_sales / maxDay) * 100}%"></span></span>${money(d.net_sales)}</td>
          <td class="num">${d.orders}</td><td class="num">${d.avg_spend === null ? '–' : money(d.avg_spend)}</td>
          <td class="num">${money(d.labour_cost)}</td>
          <td class="num"><span class="tone-${labourTone(d.labour_pct)}">${fmtPct(d.labour_pct)}</span></td>
          <td class="num">${fmtPct(d.wastage_pct)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">Labour is rostered hours × hourly rate, counted up to now for today. Labour % only includes days that have both Square sales and a rota. Target: ${LABOUR_TARGET}% of net sales or less.</p>
    </section>
    <div class="two-col">
      ${data.locations.length > 1 ? `
      <section class="card">
        <h2>By site</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Site</th><th class="num">Net sales</th><th class="num">Avg spend</th><th class="num">Labour %</th><th class="num">Wastage %</th></tr></thead>
          <tbody>${[...data.locations].sort((a, b) => b.net_sales - a.net_sales).map((l) => `<tr>
            <td>${esc(l.name)}${l.linked ? '' : ' <small class="muted">not linked</small>'}</td><td class="num">${money(l.net_sales)}</td>
            <td class="num">${l.avg_spend === null ? '–' : money(l.avg_spend)}</td>
            <td class="num"><span class="tone-${labourTone(l.labour_pct)}">${fmtPct(l.labour_pct)}</span></td>
            <td class="num">${fmtPct(l.wastage_pct)}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>` : ''}
      <section class="card">
        <h2>Top items</h2>
        ${data.top_items.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Item</th><th class="num">Sold</th><th class="num">Net sales</th></tr></thead>
          <tbody>${data.top_items.map((i) => `<tr><td>${esc(i.name)}${i.variation_name && i.variation_name !== 'Regular' ? ` <small class="muted">${esc(i.variation_name)}</small>` : ''}</td>
            <td class="num">${qty(i.quantity)}</td><td class="num">${money(i.net_sales)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">No item sales in this period.</p>'}
      </section>
    </div>`;

  el.querySelector('#range').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    ctx.navigate(`sales${qs({ from: f.from.value, to: f.to.value, scope: f.scope?.value })}`);
  });
  el.querySelector('#sync')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Syncing…';
    try {
      const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
      const syncFrom = !state.isAdmin && days > 7 ? addDays(to, -7) : from;
      const r = await api('/square/sync', { method: 'POST', body: { from: syncFrom, to } });
      toast(`Synced ${r.orders} Square order(s)`);
      ctx.rerender();
    } catch (err) {
      showError(err);
      e.target.disabled = false;
      e.target.textContent = 'Sync now';
    }
  });
}
