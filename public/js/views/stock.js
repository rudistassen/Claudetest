import { api, confirmDialog, esc, fmtDateTime, money, qs, qty, showError, statusBadge, toast, sitePicker } from '../lib.js';

export async function renderList(ctx) {
  const { el, state, stale } = ctx;
  const takes = await api(`/stocktakes${qs({ location_id: state.locationId })}`);
  if (stale()) return;
  const open = takes.find((t) => t.status === 'in_progress');

  el.innerHTML = `
    <div class="page-head">
      <h1>Stock takes${state.multiSite ? '' : ` · ${esc(state.location?.name ?? '')}`}</h1>
      <div class="actions">
        ${sitePicker(state)}
        ${open
          ? `<a class="btn btn-primary" href="#/stock/${open.id}">Continue count (${open.counted_count}/${open.line_count})</a>`
          : state.can('stock.count') ? '<button class="btn btn-primary" id="start">Start stock take</button>' : ''}
      </div>
    </div>
    <section class="card">
      ${takes.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Started</th><th>Status</th><th>Counted</th><th class="num">Stock value</th><th>Started by</th><th>Completed</th></tr></thead>
        <tbody>${takes.map((t) => `<tr class="clickable" data-id="${t.id}">
          <td><a href="#/stock/${t.id}">${fmtDateTime(t.started_at)}</a></td><td>${statusBadge(t.status)}</td>
          <td>${t.counted_count} / ${t.line_count}</td><td class="num">${money(t.total_value)}</td>
          <td>${esc(t.started_by_name ?? '')}</td><td>${t.completed_at ? `${fmtDateTime(t.completed_at)} · ${esc(t.completed_by_name ?? '')}` : '–'}</td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No stock takes yet. Start one to record what’s on the shelves – it also powers suggested order quantities.</div>'}
    </section>`;

  el.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => ctx.navigate(`stock/${tr.dataset.id}`)));
  el.querySelector('#start')?.addEventListener('click', async () => {
    try {
      const t = await api('/stocktakes', { method: 'POST', body: { location_id: state.locationId } });
      ctx.navigate(`stock/${t.id}`);
    } catch (err) { showError(err); }
  });
}

export async function renderTake(ctx) {
  const { el, state, params, stale } = ctx;
  const take = await api(`/stocktakes/${params[0]}`);
  if (stale()) return;
  const editable = take.status === 'in_progress';
  // Each line is a product ("p:12") or a prepped recipe ("r:5").
  const lines = new Map(take.lines.map((l) => [l.key, l]));
  const dirty = new Set();

  const groups = new Map();
  for (const l of take.lines) groups.set(l.category ?? 'Other', [...(groups.get(l.category ?? 'Other') ?? []), l]);

  const value = () => take.lines.reduce((s, l) => s + (l.counted_quantity ?? 0) * l.unit_cost, 0);
  const counted = () => take.lines.filter((l) => l.counted_quantity !== null).length;

  el.innerHTML = `
    <div class="page-head">
      <h1>Stock take · ${esc(take.location_name)}</h1>
      <div class="actions">
        <a class="btn" href="#/stock">‹ All stock takes</a>
        ${editable ? `<button class="btn" id="save">Save progress</button>` : ''}
        ${editable && state.can('stock.complete') ? `<button class="btn btn-primary" id="complete">Complete stock take</button>` : ''}
        ${editable && state.can('stock.complete') ? `<button class="btn btn-ghost" id="discard">Discard</button>` : ''}
        ${!editable ? '<button class="btn" id="print">Print</button>' : ''}
      </div>
    </div>
    <div class="kpis">
      <div class="kpi"><span>Status</span><strong>${statusBadge(take.status)}</strong></div>
      <div class="kpi"><span>Items counted</span><strong id="counted">${counted()} / ${take.lines.length}</strong></div>
      <div class="kpi"><span>Stock value</span><strong id="value">${money(value())}</strong></div>
      <div class="kpi"><span>Previous count</span><strong>${take.previous ? fmtDateTime(take.previous.completed_at) : '–'}</strong></div>
    </div>
    ${editable ? `<div class="filters"><input type="search" id="search" placeholder="Search products and prepped recipes…"><label class="check"><input type="checkbox" id="uncounted"> Only show uncounted</label><span class="muted" id="save-state"></span></div>` : ''}
    ${[...groups].map(([cat, list]) => `
      <section class="card stock-group">
        <h2>${esc(cat)}</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Product</th><th>Unit</th><th class="num">Previous</th><th class="num">Count</th><th class="num">Value</th></tr></thead>
          <tbody>${list.map((l) => `
            <tr data-product="${esc(l.key)}" data-name="${esc(l.name.toLowerCase())}">
              <td>${esc(l.name)}${l.prepped ? ' <span class="badge badge-sent">Prepped</span>' : ''}</td><td>${esc(l.unit)}</td><td class="num">${qty(l.previous_quantity)}</td>
              <td class="num">${editable
                ? `<input class="count-input" type="number" min="0" step="any" inputmode="decimal" value="${l.counted_quantity ?? ''}" aria-label="Count for ${esc(l.name)}">`
                : qty(l.counted_quantity)}</td>
              <td class="num line-value">${money((l.counted_quantity ?? 0) * l.unit_cost)}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </section>`).join('')}`;

  el.querySelector('#print')?.addEventListener('click', () => window.print());
  if (!editable) return;

  const saveState = el.querySelector('#save-state');
  let timer = null;
  async function save() {
    clearTimeout(timer);
    if (!dirty.size) return;
    const batch = [...dirty].map((key) => {
      const l = lines.get(key);
      return { key, ...(l.prepped ? { recipe_id: l.recipe_id } : { product_id: l.product_id }), counted_quantity: l.counted_quantity };
    });
    dirty.clear();
    saveState.textContent = 'Saving…';
    try {
      await api(`/stocktakes/${take.id}/lines`, { method: 'PUT', body: { lines: batch } });
      saveState.textContent = 'All changes saved';
    } catch (err) {
      batch.forEach((b) => dirty.add(b.key));
      saveState.textContent = 'Not saved';
      showError(err);
      throw err;
    }
  }

  // Flush pending counts if the user navigates away before the autosave fires.
  window.addEventListener('hashchange', () => save().catch(() => {}), { once: true });

  el.querySelectorAll('.count-input').forEach((inp) => {
    inp.addEventListener('input', () => {
      const tr = inp.closest('tr');
      const line = lines.get(tr.dataset.product);
      line.counted_quantity = inp.value === '' ? null : Number(inp.value);
      tr.querySelector('.line-value').textContent = money((line.counted_quantity ?? 0) * line.unit_cost);
      el.querySelector('#value').textContent = money(value());
      el.querySelector('#counted').textContent = `${counted()} / ${take.lines.length}`;
      dirty.add(line.key);
      saveState.textContent = 'Unsaved changes';
      clearTimeout(timer);
      timer = setTimeout(() => save().catch(() => {}), 800);
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const all = [...el.querySelectorAll('.count-input')].filter((i) => i.closest('tr').offsetParent);
      all[all.indexOf(inp) + 1]?.focus();
    });
  });

  const applyFilter = () => {
    const term = el.querySelector('#search').value.trim().toLowerCase();
    const onlyUncounted = el.querySelector('#uncounted').checked;
    el.querySelectorAll('tr[data-product]').forEach((tr) => {
      const line = lines.get(tr.dataset.product);
      tr.hidden = (term && !tr.dataset.name.includes(term)) || (onlyUncounted && line.counted_quantity !== null);
    });
    el.querySelectorAll('.stock-group').forEach((g) => { g.hidden = !g.querySelector('tr[data-product]:not([hidden])'); });
  };
  el.querySelector('#search').addEventListener('input', applyFilter);
  el.querySelector('#uncounted').addEventListener('change', applyFilter);

  el.querySelector('#save').addEventListener('click', () => save().then(() => toast('Progress saved')).catch(() => {}));
  el.querySelector('#complete')?.addEventListener('click', async () => {
    try { await save(); } catch { return; }
    const missing = take.lines.length - counted();
    const ok = await confirmDialog(
      missing
        ? `${missing} item(s) have not been counted and will be recorded as zero. Complete the stock take?`
        : `Complete this stock take? Total value ${money(value())}.`,
      { confirmLabel: 'Complete', title: 'Complete stock take' },
    );
    if (!ok) return;
    try {
      await api(`/stocktakes/${take.id}/complete`, { method: 'POST', body: { zero_uncounted: true } });
      toast('Stock take completed');
      ctx.rerender();
    } catch (err) { showError(err); }
  });
  el.querySelector('#discard')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Discard this stock take and all counts entered so far?', { confirmLabel: 'Discard' }))) return;
    try {
      clearTimeout(timer);
      await api(`/stocktakes/${take.id}`, { method: 'DELETE' });
      ctx.navigate('stock');
    } catch (err) { showError(err); }
  });
}
