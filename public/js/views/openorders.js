import { api, esc, fmtDate, money, openModal, qs, showError, siteColour, siteFilter, siteScope } from '../lib.js';

// Reporting → Open orders: tabs and tickets on the tills that haven't been paid yet, live from Square. Tap one
// for its items.

const PERIODS = [[1, 'Today'], [7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']];

// "2 hours", "3 days": how long an order has been open.
function openFor(iso) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hr`;
  return `${Math.round(mins / 1440)} days`;
}

export async function render(ctx) {
  const { el, state, query, stale, navigate } = ctx;
  const scope = siteScope(state, query.scope);
  const days = PERIODS.some(([d]) => d === Number(query.days)) ? Number(query.days) : 30;
  const data = await api(`/open-orders${qs({ days, location_id: scope === 'all' ? undefined : state.locationId })}`);
  if (stale()) return;
  const list = data.orders;
  const total = list.reduce((n, o) => n + o.amount, 0);
  const oldest = list[list.length - 1];
  const multi = state.multiSite && scope === 'all';

  el.innerHTML = `
    <div class="page-head"><h1>Open orders</h1></div>
    <form class="filters" id="oo-filters">
      ${siteFilter(state, scope)}
      <select name="days" aria-label="Started">
        ${PERIODS.map(([d, label]) => `<option value="${d}" ${d === days ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </form>
    ${data.square_ready ? '' : '<p class="notice">Connect Square first (Setup → Square) to see open orders.</p>'}
    ${list.length ? `<div class="kpis">
      <div class="kpi" data-icon="£"><span>Open orders</span><strong>${money(total)}</strong><small>${list.length} order${list.length === 1 ? '' : 's'}</small></div>
      <div class="kpi" data-icon="◷"><span>Oldest</span><strong>${openFor(oldest.created_at)}</strong><small>${fmtDate(oldest.date)} ${esc(oldest.time)}${multi ? ` · ${esc(oldest.location_name)}` : ''}</small></div>
    </div>` : ''}
    <section class="card">
      ${list.length ? `<div class="table-wrap"><table class="open-orders">
        <thead><tr><th>Opened</th><th>Order</th><th class="num">Amount</th></tr></thead>
        <tbody>${list.map((o) => `<tr class="row-link" data-order="${esc(o.id)}" tabindex="0" role="button" aria-label="Open order ${esc(o.name ?? '')} ${money(o.amount)}">
          <td class="oo-when"><strong>${fmtDate(o.date)}</strong> <span class="muted">${esc(o.time)}</span>
            ${multi ? `<small><span class="site-dot" style="--site: ${siteColour(o.location_name, o.location_id)}"></span>${esc(o.location_name)}</small>` : ''}</td>
          <td class="oo-order"><strong>${esc(o.name ?? 'No name')}</strong><small class="muted">${o.items} item${o.items === 1 ? '' : 's'}${o.summary ? ` · ${esc(o.summary)}` : ''}</small></td>
          <td class="num"><strong>${money(o.amount)}</strong><small class="muted">${o.due < o.amount ? `${money(o.due)} to pay · ` : ''}open ${openFor(o.created_at)}</small></td>
        </tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">${data.square_ready ? 'No open orders – everything’s been paid.' : 'Nothing to show yet.'}</div>`}
      <p class="muted small">Live from Square: orders started on the tills in this time and not paid yet. Once paid (or cancelled) they leave this list. Online orders aren’t included, and payment links are on their own page.</p>
    </section>`;

  const form = el.querySelector('#oo-filters');
  form.addEventListener('submit', (e) => { e.preventDefault(); navigate(`open-orders${qs({ scope: form.scope?.value, days: form.days.value === '30' ? undefined : form.days.value })}`); });
  form.days.addEventListener('change', () => form.requestSubmit());
  el.querySelectorAll('[data-order]').forEach((tr) => {
    const open = () => showOrder(tr.dataset.order);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

async function showOrder(id) {
  let o;
  try { o = await api(`/open-orders/${encodeURIComponent(id)}`); } catch (err) { showError(err); return; }
  const row = (label, value, cls = '') => `<tr class="${cls}"><td colspan="2">${label}</td><td class="num">${value}</td></tr>`;
  const state = o.state === 'OPEN' ? '' : `<p class="notice">This order is now ${o.state === 'COMPLETED' ? 'paid' : o.state.toLowerCase()}.</p>`;
  openModal({
    title: o.name || 'Open order',
    body: `${state}
      <p class="muted small">${esc(o.location_name)} · started ${fmtDate(o.date)} ${esc(o.time)}${o.updated_time && o.updated_time !== `${o.date} ${o.time}` ? ` · last changed ${fmtDate(o.updated_time)} ${esc(o.updated_time.slice(11))}` : ''}${o.source ? ` · ${esc(o.source)}` : ''}</p>
      <div class="table-wrap"><table class="order-detail">
        <thead><tr><th class="num">Qty</th><th>Item</th><th class="num">Price</th></tr></thead>
        <tbody>${o.lines.map((l) => `<tr>
          <td class="num">${l.quantity}</td>
          <td><strong>${esc(l.name)}</strong>${l.variation && l.variation !== 'Regular' ? ` <span class="muted">${esc(l.variation)}</span>` : ''}
            ${l.options.length ? `<small class="muted">${l.options.map(esc).join(', ')}</small>` : ''}
            ${l.note ? `<small><em>${esc(l.note)}</em></small>` : ''}</td>
          <td class="num">${money(l.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No items yet.</td></tr>'}</tbody>
        <tfoot>
          ${o.discounts.map((d) => row(esc(d.name), `−${money(d.amount)}`)).join('')}
          ${o.service_charges.map((s) => row(esc(s.name), money(s.amount))).join('')}
          ${o.tax ? row('incl. VAT', money(o.tax), 'muted') : ''}
          ${row('<strong>Total</strong>', `<strong>${money(o.total)}</strong>`)}
          ${o.paid ? row('Paid so far', money(o.paid)) + row('<strong>Left to pay</strong>', `<strong>${money(o.due)}</strong>`) : ''}
        </tfoot>
      </table></div>
      <p class="muted small">To take payment or change the order, open it on the till.</p>`,
  });
}
