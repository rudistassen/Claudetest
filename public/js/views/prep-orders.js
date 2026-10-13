import { addDays, api, confirmDialog, esc, fmtDate, qs, qty, showError, toast, todayISO } from '../lib.js';

// Stock and Ordering → Prep kitchen ordering: each site orders prepped recipes (sauces, fillings, bakes) from the
// prep kitchen for a day, and the prep kitchen sees the prep list – every site's orders added up.

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
    // Every day with orders, one after another: today and the next 7 days (or the week picked).
    const from = /^\d{4}-\d{2}-\d{2}$/.test(query.date ?? '') ? query.date : todayISO();
    const data = await api(`/prep-orders/lists${qs({ from, days: 8 })}`);
    if (stale()) return;
    const dayCard = (d) => `<section class="card prep-day">
        <div class="prep-day-head"><h2>${fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}${d.date === todayISO() ? ' <span class="badge badge-sent">Today</span>' : ''}</h2>
          <span class="muted small">${d.orders.length} order${d.orders.length === 1 ? '' : 's'} · ${d.orders.filter((o) => o.status === 'sent').length} sent</span></div>
        <ul class="prep-make">${d.items.map((i) => `<li><span class="prep-name"><strong>${esc(i.name)}</strong>
            <small>${i.sites.map((x) => `${esc(x.location_name)} ${qty(x.quantity)}`).join(' · ')}</small></span>
            <span class="prep-total"><strong>${qty(i.total)} ${esc(i.unit)}</strong>${i.batches_to_make ? `<small>${i.batches_to_make} batch${i.batches_to_make === 1 ? '' : 'es'}</small>` : ''}</span></li>`).join('')}</ul>
        <details class="prep-orders-day"><summary class="small">The orders (${d.orders.length})</summary>
          <ul class="po-list">${d.orders.map((o) => `<li class="po-row">
            <span class="po-main"><strong class="po-supplier">${esc(o.location_name)}</strong><small class="prep-summary">${summary(o)}</small>${o.notes ? `<small>“${esc(o.notes)}”</small>` : ''}</span>
            <span class="po-side">${badge(o.status)}<button class="btn btn-small ${o.status === 'sent' ? 'btn-ghost' : 'btn-primary'}" data-sent="${o.id}" data-to="${o.status === 'sent' ? '' : '1'}">${o.status === 'sent' ? 'Undo sent' : '✓ Mark sent'}</button></span></li>`).join('')}</ul>
        </details>
      </section>`;
    el.innerHTML = `${head}
      <p class="muted">Everything the sites have ordered from the prep kitchen, day by day, added up for each prepped recipe.</p>
      <div class="filters">
        <button class="btn" data-week="-7" aria-label="The week before">‹ Earlier</button>
        <span class="small"><strong>${fmtDate(data.from, { day: 'numeric', month: 'short' })} – ${fmtDate(data.to, { day: 'numeric', month: 'short' })}</strong></span>
        <button class="btn" data-week="7" aria-label="The week after">Later ›</button>
        ${from !== todayISO() ? '<button class="btn btn-ghost" data-week="0">From today</button>' : ''}
        <button class="btn" id="pl-print">Print</button>
      </div>
      ${data.days.length ? data.days.map(dayCard).join('') : `<div class="card empty">Nothing ordered for ${fmtDate(data.from, { day: 'numeric', month: 'short' })} – ${fmtDate(data.to, { day: 'numeric', month: 'short' })} yet.</div>`}`;
    wireTabs();
    el.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => {
      const n = Number(b.dataset.week);
      navigate(`prep-orders${qs({ tab: 'list', site, date: n ? addDays(from, n) : undefined })}`);
    }));
    el.querySelector('#pl-print').addEventListener('click', () => { el.querySelectorAll('details.prep-orders-day').forEach((d) => { d.open = true; }); window.print(); });
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
      ${data.recipes.length ? `<div class="line-filter">
          <input type="search" class="line-search" placeholder="Search prepped recipes – name or category" aria-label="Search prepped recipes" autocomplete="off">
          <label class="line-only"><input type="checkbox" class="line-only-box" ${existing ? 'checked' : ''}> Only what I’m ordering</label>
          <span class="muted small line-count"></span>
        </div>
        ${[...groups].map(([cat, list]) => `<section class="prep-group"><h3 class="group-title">${esc(cat)}</h3>
          <ul class="prep-lines">${list.map((r) => `<li data-line="${r.id}" data-search="${esc(`${r.name} ${r.category ?? ''}`.toLowerCase())}" class="${had.get(r.id) ? 'is-ordering' : ''}">
            <span class="prep-name"><strong>${esc(r.name)}</strong><small>${esc(r.yield_unit)}${r.shelf_life ? ` · ${esc(r.shelf_life)}` : ''}</small></span>
            <span class="qty-step"><button type="button" data-step="-1" aria-label="One less ${esc(r.name)}">−</button><input class="qty-input po-qty" type="number" min="0" step="any" inputmode="decimal" data-recipe="${r.id}" value="${had.get(r.id) ?? ''}" aria-label="Amount of ${esc(r.name)} in ${esc(r.yield_unit)}"><button type="button" data-step="1" aria-label="One more ${esc(r.name)}">+</button></span>
          </li>`).join('')}</ul></section>`).join('')}`
        : `<div class="empty">No prepped recipes yet. Add them under <a href="#/recipes/prep">Menu → Prepped recipes</a>.</div>`}
      <label class="field"><span>Notes for the prep kitchen</span><textarea name="notes" rows="2" maxlength="1000" placeholder="e.g. please send before 10am">${esc(existing?.notes ?? '')}</textarea></label>
      <p class="form-error" hidden></p>
      <div class="actions">
        ${data.recipes.length ? `<button class="btn btn-primary" type="submit">${existing ? 'Update order' : 'Send order'}</button>` : ''}
        ${existing ? '<button type="button" class="btn btn-ghost" id="po-delete">Delete order</button>' : ''}
      </div>
    </form>
    <section class="card po-list-card">
      <h2>Orders</h2>
      ${upcoming.length || past.length ? `<ul class="po-list">${[...upcoming, ...past.slice(0, 20)].map((o) => `<li class="po-row ${o.needed_on < todayISO() ? 'is-past' : ''}">
          <span class="po-main"><strong class="po-supplier">${esc(o.location_name)}</strong>
            <small>Needed ${fmtDate(o.needed_on)} · ${o.lines.length} item${o.lines.length === 1 ? '' : 's'}</small>
            <small class="prep-summary">${summary(o)}</small></span>
          <span class="po-side">${badge(o.status)}${o.status === 'ordered' && o.needed_on >= todayISO() ? `<button class="btn btn-small" data-edit-site="${o.location_id}" data-edit-day="${o.needed_on}">Change</button>` : ''}</span>
        </li>`).join('')}</ul>` : '<p class="muted">No orders yet.</p>'}
    </section>`;
  wireTabs();

  const form = el.querySelector('#po-form');
  // − / +, searching and “only what I’m ordering” – as on supplier orders. Searching only hides rows.
  const lines = [...form.querySelectorAll('[data-line]')];
  const search = form.querySelector('.line-search');
  const only = form.querySelector('.line-only-box');
  const count = form.querySelector('.line-count');
  const amount = (li) => Number(li.querySelector('.qty-input').value) || 0;
  const filter = () => {
    if (!search) return;
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    let hiddenOrdering = 0;
    for (const li of lines) {
      const hit = words.every((w) => li.dataset.search.includes(w)) && (words.length > 0 || !only.checked || amount(li) > 0);
      li.hidden = !hit;
      if (hit) shown++;
      else if (amount(li) > 0) hiddenOrdering++;
    }
    form.querySelectorAll('.prep-group').forEach((g) => { g.hidden = ![...g.querySelectorAll('[data-line]')].some((li) => !li.hidden); });
    count.textContent = words.length || only.checked ? `${shown} of ${lines.length}${hiddenOrdering ? ` · ${hiddenOrdering} more in the order, hidden by the search` : ''}` : '';
  };
  form.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const box = b.parentElement.querySelector('.qty-input');
    const next = Math.max(0, (Number(box.value) || 0) + Number(b.dataset.step));
    box.value = next ? String(Math.round(next * 100) / 100) : '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }));
  form.addEventListener('input', (e) => {
    if (e.target.matches('.po-qty')) { e.target.closest('[data-line]').classList.toggle('is-ordering', amount(e.target.closest('[data-line]')) > 0); if (search?.value) filter(); }
  });
  search?.addEventListener('input', filter);
  search?.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  only?.addEventListener('change', filter);
  filter();
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
