import { addDays, api, confirmDialog, esc, field, fmtDate, input, money, openModal, qs, qty, select, showError, textarea, toast, todayISO, siteScope, siteFilter } from '../lib.js';

function bars(rows, total) {
  if (!rows.length) return '<p class="muted">Nothing recorded.</p>';
  return `<ul class="bars">${rows.map((r) => `
    <li><span class="bar-label">${esc(r.key)}</span>
      <span class="bar"><span style="width:${total ? Math.max(2, (r.total_cost / total) * 100) : 0}%"></span></span>
      <span class="bar-value">${money(r.total_cost)}</span></li>`).join('')}</ul>`;
}

export async function render(ctx) {
  const { el, state, query, stale } = ctx;
  const to = query.to || todayISO();
  const from = query.from || addDays(to, -6);
  const scope = siteScope(state, query.scope, 'site');
  const params = { from, to, location_id: scope === 'all' ? undefined : state.locationId };
  const canRecord = state.can('wastage.record');
  const [report, entries, [products, reasons, recipes]] = await Promise.all([
    state.can('wastage.reports') ? api(`/wastage/report${qs(params)}`) : null,
    api(`/wastage${qs(params)}`),
    Promise.all([api('/products'), api('/wastage/reasons'), state.can('recipes.view', 'recipes.costs', 'recipes.edit') ? api('/recipes') : []]),
  ]);
  if (stale()) return;
  const active = products.filter((p) => p.active);

  el.innerHTML = `
    <div class="page-head">
      <h1>Wastage</h1>
      <div class="actions">
        ${canRecord ? '<button class="btn btn-primary" id="log">+ Log wastage</button>' : ''}
        ${report ? `<a class="btn" href="/api/wastage/export.csv${qs(params)}">Export CSV</a>` : ''}
      </div>
    </div>
    <form class="filters" id="range">
      ${siteFilter(state, scope)}
      <input type="date" name="from" value="${from}"> <span>to</span> <input type="date" name="to" value="${to}" max="${todayISO()}">
      <button class="btn" type="submit">Update</button>
    </form>
    ${report ? `<div class="kpis">
      <div class="kpi"><span>Total wastage</span><strong>${money(report.total_cost)}</strong></div>
      <div class="kpi"><span>Entries</span><strong>${report.entries}</strong></div>
      ${report.sales ? `<div class="kpi"><span>% of net sales (${money(report.sales.net_sales)})</span><strong>${report.sales.wastage_pct === null ? '–' : `${report.sales.wastage_pct.toFixed(1)}%`}</strong></div>` : ''}
      <div class="kpi"><span>Top reason</span><strong>${esc(report.by_reason[0]?.key ?? '–')}</strong></div>
    </div>
    <div class="two-col">
      <section class="card"><h2>By reason</h2>${bars(report.by_reason, report.total_cost)}</section>
      <section class="card"><h2>Top items</h2>${bars(report.by_item, report.total_cost)}</section>
      ${scope === 'all' ? `<section class="card"><h2>By site</h2>${bars(report.by_location, report.total_cost)}</section>` : ''}
    </div>` : ''}
    <section class="card">
      <h2>Entries</h2>
      ${entries.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th>${scope === 'all' ? '<th>Site</th>' : ''}<th>Item</th><th class="num">Qty</th><th class="num">Cost</th><th>Reason</th><th>Recorded by</th><th></th></tr></thead>
        <tbody>${entries.map((w) => `<tr>
          <td>${fmtDate(w.date)}</td>${scope === 'all' ? `<td>${esc(w.location_name)}</td>` : ''}
          <td>${esc(w.item_name)}${w.notes ? `<small class="muted block">${esc(w.notes)}</small>` : ''}</td>
          <td class="num">${qty(w.quantity)} ${esc(w.unit ?? '')}</td><td class="num">${money(w.total_cost)}</td>
          <td>${esc(w.reason)}</td><td>${esc(w.recorded_by_name ?? '')}</td>
          <td>${state.can('wastage.manage') || (canRecord && w.recorded_by === state.user.id && w.date === todayISO()) ? `<button class="btn btn-small btn-ghost" data-del="${w.id}">Delete</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No wastage recorded in this period.</p>'}
    </section>`;

  el.querySelector('#range').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    ctx.navigate(`wastage${qs({ from: f.from.value, to: f.to.value, scope: f.scope?.value })}`);
  });

  el.querySelector('#log')?.addEventListener('click', () => {
    const byCat = new Map();
    for (const p of active) byCat.set(p.category ?? 'Other', [...(byCat.get(p.category ?? 'Other') ?? []), p]);
    const made = recipes.filter((r) => r.active);
    const productSelect = `<select name="item">
      <option value="">— Other item (type below) —</option>
      ${made.length ? `<optgroup label="Made items (costed from recipe)">${made.map((r) => `<option value="r:${r.id}">${esc(r.name)}${r.kind === 'prep' ? ` – per ${esc(r.yield_unit)}` : ''}${r.cost_per_unit !== undefined ? ` (${r.cost_per_unit > 0 && r.cost_per_unit < 0.1 ? `£${r.cost_per_unit.toFixed(4)}` : money(r.cost_per_unit)} ${r.kind === 'prep' ? `per ${esc(r.yield_unit)}` : 'each'})` : ''}</option>`).join('')}</optgroup>` : ''}
      ${[...byCat].map(([cat, list]) => `<optgroup label="${esc(cat)}">${list.map((p) => `<option value="p:${p.id}">${esc(p.name)} (${esc(p.unit)}, ${money(p.unit_cost)})</option>`).join('')}</optgroup>`).join('')}
    </select>`;
    const { form } = openModal({
      title: state.multiSite ? 'Log wastage' : `Log wastage · ${state.location?.name ?? ''}`,
      body: `
        ${state.multiSite ? field('Site', select('location_id', state.locations.filter((l) => l.active).map((l) => [l.id, l.name]), state.locationId, 'required')) : ''}
        ${field('Item', productSelect)}
        <div class="other-item">
          ${field('Item name', input('item_name', '', 'placeholder="e.g. Ham & cheese toastie"'))}
          <div class="row">${field('Unit', input('unit', 'each'))}${field('Cost per unit (£)', input('unit_cost', '', 'type="number" min="0" step="0.01"'))}</div>
        </div>
        <div class="row">
          ${field('Quantity', input('quantity', '', 'type="number" min="0" step="any" required'))}
          ${field('Date', input('date', todayISO(), `type="date" max="${todayISO()}" required`))}
        </div>
        ${field('Reason', select('reason', reasons.map((r) => [r, r]), reasons[0], 'required'))}
        ${field('Notes', textarea('notes', ''))}`,
      submitLabel: 'Save',
      onSubmit: async (v) => {
        const { item, ...rest } = v;
        const body = { ...rest, location_id: Number(rest.location_id) || state.locationId };
        if (item) {
          body[item.startsWith('r:') ? 'recipe_id' : 'product_id'] = Number(item.slice(2));
          delete body.item_name; delete body.unit_cost; delete body.unit;
        }
        await api('/wastage', { method: 'POST', body });
        toast('Wastage logged');
        ctx.rerender();
      },
    });
    const other = form.querySelector('.other-item');
    const sync = () => { other.hidden = !!form.item.value; };
    form.item.addEventListener('change', sync);
    sync();
  });

  el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete this wastage entry?', { confirmLabel: 'Delete' }))) return;
    try {
      await api(`/wastage/${b.dataset.del}`, { method: 'DELETE' });
      toast('Entry deleted');
      ctx.rerender();
    } catch (err) { showError(err); }
  }));
}
