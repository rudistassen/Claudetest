import { addDays, api, confirmDialog, esc, fmtDate, qs, qty, showError, toast, todayISO } from '../lib.js';

// Stock and Ordering → Prep kitchen ordering: each site orders prepped recipes (sauces, fillings, bakes) from the
// prep kitchen for a day, and the prep kitchen sees the prep list – every site's orders added up, in batches.

const STATUS = { ordered: ['Ordered', 'badge-sent'], sent: ['Sent', 'badge-received'] };
const badge = (s) => `<span class="badge ${STATUS[s]?.[1] ?? ''}">${STATUS[s]?.[0] ?? esc(s)}</span>`;
const summary = (o) => o.lines.map((l) => `${esc(l.name)} ${qty(l.quantity)} ${esc(l.unit)}`).join(', ');

export async function render(ctx) {
  const { el, state, query, stale, navigate, rerender } = ctx;
  const tab = query.tab === 'list' ? 'list' : 'order';
  const sites = state.locations.filter((l) => l.active);
  const site = Number(query.site) || state.locationId || sites[0]?.id;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(query.date ?? '') ? query.date : tab === 'list' ? todayISO() : addDays(todayISO(), 1);
  const go = (extra) => navigate(`prep-orders${qs({ tab: tab === 'list' ? 'list' : undefined, site, date: day, ...extra })}`);

  const head = `<div class="page-head"><h1>Prep kitchen ordering</h1>
      <div class="seg" role="group" aria-label="Order or prep list">
        <button data-tab="order" class="${tab === 'order' ? 'is-on' : ''}">Order</button><button data-tab="list" class="${tab === 'list' ? 'is-on' : ''}">Prep list</button></div></div>`;
  const wireTabs = () => el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => navigate(`prep-orders${qs({ tab: b.dataset.tab === 'list' ? 'list' : undefined, site })}`)));

  if (tab === 'list') {
    const data = await api(`/prep-orders/list${qs({ date: day })}`);
    if (stale()) return;
    el.innerHTML = `${head}
      <p class="muted">Everything the sites have ordered from the prep kitchen for a day, added up – with how many batches to make.</p>
      <div class="filters">
        <button class="btn" data-day="-1" aria-label="Previous day">‹</button>
        <input type="date" id="pl-day" value="${day}" aria-label="Day">
        <button class="btn" data-day="1" aria-label="Next day">›</button>
        <button class="btn" id="pl-print">Print</button>
      </div>
      <section class="card">
        <h2>Prep list · ${fmtDate(day, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
        ${data.items.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Prepped recipe</th><th class="num">Total ordered</th><th class="num">Batches to make</th><th>By site</th></tr></thead>
          <tbody>${data.items.map((i) => `<tr>
            <td><strong>${esc(i.name)}</strong>${i.yield_quantity ? `<small class="muted">A batch makes ${qty(i.yield_quantity)} ${esc(i.unit)}</small>` : ''}</td>
            <td class="num"><strong>${qty(i.total)} ${esc(i.unit)}</strong></td>
            <td class="num">${i.batches_to_make === null ? '–' : `<strong>${i.batches_to_make}</strong>${i.batches !== i.batches_to_make ? ` <small class="muted">(${qty(i.batches)} needed)</small>` : ''}`}</td>
            <td class="small">${i.sites.map((x) => `${esc(x.location_name)} ${qty(x.quantity)}`).join(' · ')}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">Nothing ordered for this day yet.</p>'}
      </section>
      ${data.orders.length ? `<section class="card">
        <h2>Orders for this day</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Site</th><th>Items</th><th>Status</th><th></th></tr></thead>
          <tbody>${data.orders.map((o) => `<tr>
            <td><strong>${esc(o.location_name)}</strong>${o.notes ? `<small class="muted">${esc(o.notes)}</small>` : ''}</td>
            <td class="small">${summary(o)}</td><td>${badge(o.status)}</td>
            <td class="num"><button class="btn btn-small ${o.status === 'sent' ? 'btn-ghost' : 'btn-primary'}" data-sent="${o.id}" data-to="${o.status === 'sent' ? '' : '1'}">${o.status === 'sent' ? 'Undo sent' : '✓ Mark sent'}</button></td></tr>`).join('')}</tbody>
        </table></div></section>` : ''}`;
    wireTabs();
    el.querySelector('#pl-day').addEventListener('change', (e) => e.target.value && go({ date: e.target.value }));
    el.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => go({ date: addDays(day, Number(b.dataset.day)) })));
    el.querySelector('#pl-print').addEventListener('click', () => window.print());
    el.querySelectorAll('[data-sent]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api(`/prep-orders/${b.dataset.sent}/sent`, { method: 'POST', body: { sent: !!b.dataset.to } }); toast(b.dataset.to ? 'Marked as sent' : 'Back to ordered'); rerender(); } catch (err) { showError(err); b.disabled = false; }
    }));
    return;
  }

  // --- Order: the prepped recipes, with an amount for each, for one site and day ---
  const data = await api('/prep-orders');
  if (stale()) return;
  // An order already placed for this site and day (and not sent yet) is changed rather than placed again.
  const existing = data.orders.find((o) => o.location_id === site && o.needed_on === day && o.status === 'ordered');
  const sentAlready = data.orders.filter((o) => o.location_id === site && o.needed_on === day && o.status === 'sent');
  const had = new Map((existing?.lines ?? []).map((l) => [l.recipe_id, l.quantity]));
  const groups = new Map();
  for (const r of data.recipes) groups.set(r.category || 'Other', [...(groups.get(r.category || 'Other') ?? []), r]);
  const upcoming = data.orders.filter((o) => o.needed_on >= todayISO()).sort((a, b) => a.needed_on.localeCompare(b.needed_on));
  const past = data.orders.filter((o) => o.needed_on < todayISO());

  el.innerHTML = `${head}
    <p class="muted">Order prepped recipes from the prep kitchen for a day. Amounts are in each recipe’s unit (set on the recipe under Menu → Prepped recipes).</p>
    <form id="po-form" class="card">
      <div class="row">
        ${sites.length > 1 ? `<label class="field"><span>Site</span><select name="location_id" id="po-site">${sites.map((l) => `<option value="${l.id}" ${l.id === site ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>` : `<input type="hidden" name="location_id" value="${site}">`}
        <label class="field"><span>Needed on</span><input type="date" name="needed_on" id="po-day" value="${day}" min="${todayISO()}" required></label>
      </div>
      ${existing ? `<p class="notice">You’ve already ordered for ${fmtDate(day)} – change the amounts below and save to update that order.</p>` : ''}
      ${sentAlready.length ? `<p class="notice">The prep kitchen has already sent an order for ${fmtDate(day)}. Anything you order now is a separate order.</p>` : ''}
      ${data.recipes.length ? [...groups].map(([cat, list]) => `<h3 class="group-title">${esc(cat)}</h3>
        <div class="table-wrap"><table class="po-table">
          <thead><tr><th>Prepped recipe</th><th>A batch makes</th><th class="num">Amount</th></tr></thead>
          <tbody>${list.map((r) => `<tr>
            <td><strong>${esc(r.name)}</strong>${r.shelf_life ? `<small class="muted">${esc(r.shelf_life)}</small>` : ''}</td>
            <td class="muted">${qty(r.yield_quantity)} ${esc(r.yield_unit)}</td>
            <td class="num"><input class="qty-input po-qty" type="number" min="0" step="any" inputmode="decimal" data-recipe="${r.id}" value="${had.get(r.id) ?? ''}" aria-label="Amount of ${esc(r.name)}"> <span class="muted">${esc(r.yield_unit)}</span></td>
          </tr>`).join('')}</tbody></table></div>`).join('')
        : `<div class="empty">No prepped recipes yet. Add them under <a href="#/recipes/prep">Menu → Prepped recipes</a>.</div>`}
      <label class="field"><span>Notes for the prep kitchen</span><textarea name="notes" rows="2" maxlength="1000" placeholder="e.g. please send before 10am">${esc(existing?.notes ?? '')}</textarea></label>
      <p class="form-error" hidden></p>
      <div class="actions">
        ${data.recipes.length ? `<button class="btn btn-primary" type="submit">${existing ? 'Update order' : 'Send order'}</button>` : ''}
        ${existing ? '<button type="button" class="btn btn-ghost" id="po-delete">Delete order</button>' : ''}
      </div>
    </form>
    <section class="card">
      <h2>Orders</h2>
      ${upcoming.length || past.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Needed on</th><th>Site</th><th>Items</th><th>Status</th><th></th></tr></thead>
        <tbody>${[...upcoming, ...past.slice(0, 20)].map((o) => `<tr class="${o.needed_on < todayISO() ? 'inactive' : ''}">
          <td>${fmtDate(o.needed_on)}</td><td>${esc(o.location_name)}</td><td class="small">${summary(o)}</td><td>${badge(o.status)}</td>
          <td class="num">${o.status === 'ordered' && o.needed_on >= todayISO() ? `<button class="btn btn-small" data-edit-site="${o.location_id}" data-edit-day="${o.needed_on}">Change</button>` : ''}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No orders yet.</p>'}
    </section>`;
  wireTabs();

  const form = el.querySelector('#po-form');
  el.querySelector('#po-site')?.addEventListener('change', (e) => go({ site: e.target.value }));
  el.querySelector('#po-day').addEventListener('change', (e) => e.target.value && go({ date: e.target.value }));
  el.querySelectorAll('[data-edit-site]').forEach((b) => b.addEventListener('click', () => go({ site: b.dataset.editSite, date: b.dataset.editDay })));
  el.querySelector('#po-delete')?.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete ${sites.find((l) => l.id === site)?.name ?? 'this site'}’s prep order for ${fmtDate(day)}?`, { confirmLabel: 'Delete' })) return;
    try { await api(`/prep-orders/${existing.id}`, { method: 'DELETE' }); toast('Order deleted'); rerender(); } catch (err) { showError(err); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.form-error');
    err.hidden = true;
    const lines = [...form.querySelectorAll('.po-qty')].map((i) => ({ recipe_id: Number(i.dataset.recipe), quantity: Number(i.value) || 0 })).filter((l) => l.quantity > 0);
    const body = { location_id: Number(form.location_id.value), needed_on: form.needed_on.value, notes: form.notes.value || null, lines };
    try {
      await api(existing ? `/prep-orders/${existing.id}` : '/prep-orders', { method: existing ? 'PUT' : 'POST', body });
      toast(existing ? 'Order updated' : `Order sent to the prep kitchen for ${fmtDate(body.needed_on)}`);
      rerender();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}
