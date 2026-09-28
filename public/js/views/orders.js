import { addDays, api, confirmDialog, esc, field, fmtDate, fmtDateTime, input, money, openModal, qs, qty, select, showError, statusBadge, textarea, toast, todayISO } from '../lib.js';

const STATUSES = [['', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['received', 'Received'], ['cancelled', 'Cancelled']];

export async function renderList(ctx) {
  const { el, state, query, stale } = ctx;
  const status = query.status ?? '';
  const orders = await api(`/orders${qs({ location_id: state.locationId, status })}`);
  if (stale()) return;

  el.innerHTML = `
    <div class="page-head">
      <h1>Supplier orders · ${esc(state.location?.name ?? '')}</h1>
      <div class="actions"><a class="btn btn-primary" href="#/orders/new">+ New order</a></div>
    </div>
    <div class="tabs">${STATUSES.map(([v, l]) => `<a href="#/orders${v ? `?status=${v}` : ''}" class="${status === v ? 'active' : ''}">${l}</a>`).join('')}</div>
    <section class="card">
      ${orders.length ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Supplier</th><th>Status</th><th>Items</th><th class="num">Total</th><th>Delivery</th><th>Created</th></tr></thead>
        <tbody>${orders.map((o) => `<tr class="clickable" data-id="${o.id}">
          <td><a href="#/orders/${o.id}">PO-${o.id}</a></td><td>${esc(o.supplier_name)}</td><td>${statusBadge(o.status)}</td>
          <td>${o.line_count}</td><td class="num">${money(o.total)}</td><td>${fmtDate(o.delivery_date)}</td>
          <td>${fmtDateTime(o.created_at)} · ${esc(o.created_by_name ?? '')}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">No orders yet.</div>'}
    </section>`;
  el.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => ctx.navigate(`orders/${tr.dataset.id}`)));
}

function linesTable(rows, { showSuggest }) {
  return `<div class="table-wrap"><table class="order-lines">
    <thead><tr><th>Product</th><th>Unit</th>${showSuggest ? '<th class="num">Par</th><th class="num">On hand</th><th class="num">Suggested</th>' : ''}
      <th class="num">Unit cost</th><th class="num">Order qty</th><th class="num">Line total</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr data-product="${r.product_id}" data-cost="${r.unit_cost}">
        <td>${esc(r.name)}</td><td>${esc(r.unit)}</td>
        ${showSuggest ? `<td class="num">${qty(r.par_level)}</td><td class="num">${qty(r.on_hand)}</td><td class="num">${qty(r.suggested)}</td>` : ''}
        <td class="num">${money(r.unit_cost)}</td>
        <td class="num"><input class="qty-input" type="number" min="0" step="any" inputmode="decimal" value="${r.quantity || ''}"></td>
        <td class="num line-total">${money((r.quantity || 0) * r.unit_cost)}</td>
      </tr>`).join('')}</tbody>
    <tfoot><tr><th colspan="${showSuggest ? 6 : 3}">Order total</th><td></td><td class="num"><strong class="order-total"></strong></td></tr></tfoot>
  </table></div>`;
}

function bindLines(root, minOrder) {
  const update = () => {
    let total = 0;
    root.querySelectorAll('tr[data-product]').forEach((tr) => {
      const q = Number(tr.querySelector('.qty-input').value) || 0;
      const line = q * Number(tr.dataset.cost);
      total += line;
      tr.querySelector('.line-total').textContent = money(line);
    });
    root.querySelector('.order-total').textContent = money(total);
    const warn = root.querySelector('.min-warning');
    if (warn) warn.hidden = !(minOrder && total > 0 && total < minOrder);
  };
  root.querySelectorAll('.qty-input').forEach((i) => i.addEventListener('input', update));
  update();
  return () => [...root.querySelectorAll('tr[data-product]')]
    .map((tr) => ({ product_id: Number(tr.dataset.product), quantity: Number(tr.querySelector('.qty-input').value) || 0 }))
    .filter((l) => l.quantity > 0);
}

export async function renderNew(ctx) {
  const { el, state, query, stale } = ctx;
  const suppliers = (await api('/suppliers')).filter((s) => s.active);
  if (stale()) return;
  const supplierId = Number(query.supplier) || null;
  const supplier = suppliers.find((s) => s.id === supplierId);
  const suggestion = supplier ? await api(`/orders/suggest${qs({ location_id: state.locationId, supplier_id: supplier.id })}`) : null;
  if (stale()) return;

  el.innerHTML = `
    <div class="page-head">
      <h1>New order · ${esc(state.location?.name ?? '')}</h1>
      <div class="actions"><a class="btn" href="#/orders">‹ Orders</a></div>
    </div>
    <section class="card">
      ${field('Supplier', select('supplier', [['', 'Choose a supplier…'], ...suppliers.map((s) => [s.id, s.name])], supplierId ?? '', 'id="supplier"'))}
      ${supplier ? `<p class="muted">Order days: ${esc(supplier.order_days ?? '–')} · Lead time: ${supplier.lead_time_days} day(s) · Minimum order: ${money(supplier.min_order)}</p>` : ''}
    </section>
    ${suggestion ? `
    <form class="card" id="order-form">
      <p class="muted">${suggestion.last_stock_take
        ? `Suggested quantities = par level − stock counted on ${fmtDateTime(suggestion.last_stock_take.completed_at)}.`
        : 'No completed stock take for this site yet, so there are no suggested quantities. Enter quantities manually.'}</p>
      ${suggestion.products.length
        ? linesTable(suggestion.products.map((p) => ({ ...p, quantity: p.suggested })), { showSuggest: true })
        : '<p class="empty">This supplier has no products yet. Add them under Setup → Products.</p>'}
      <p class="alert-text min-warning" hidden>Below this supplier’s minimum order of ${money(supplier.min_order)}.</p>
      <div class="row">
        ${field('Delivery date', input('delivery_date', addDays(todayISO(), supplier.lead_time_days || 1), 'type="date"'))}
        ${field('Notes for supplier', textarea('notes', ''))}
      </div>
      <div class="actions"><button class="btn btn-primary" type="submit">Save draft order</button></div>
    </form>` : ''}`;

  el.querySelector('#supplier').addEventListener('change', (e) => ctx.navigate(`orders/new${e.target.value ? `?supplier=${e.target.value}` : ''}`));
  const form = el.querySelector('#order-form');
  if (!form || !suggestion.products.length) return;
  const getLines = bindLines(form, supplier.min_order);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const order = await api('/orders', {
        method: 'POST',
        body: { location_id: state.locationId, supplier_id: supplier.id, delivery_date: form.delivery_date.value || null, notes: form.notes.value, lines: getLines() },
      });
      toast('Draft order saved');
      ctx.navigate(`orders/${order.id}`);
    } catch (err) { showError(err); }
  });
}

function orderText(o) {
  const lines = o.lines.map((l) => `- ${qty(l.quantity)} x ${l.product_name} (${l.unit})${l.sku ? ` [${l.sku}]` : ''}`).join('\n');
  return `Hello ${o.supplier_name},

Please could we order the following for delivery to ${o.location_name}${o.delivery_date ? ` on ${fmtDate(o.delivery_date, { weekday: 'long', day: 'numeric', month: 'long' })}` : ''}:

${lines}
${o.notes ? `\nNotes: ${o.notes}\n` : ''}
Order reference: PO-${o.id}

Thank you`;
}

export async function renderOrder(ctx) {
  const { el, params, stale } = ctx;
  const o = await api(`/orders/${params[0]}`);
  if (stale()) return;
  const draft = o.status === 'draft';
  const receivedTotal = o.lines.reduce((s, l) => s + (l.received_quantity ?? 0) * l.unit_cost, 0);

  el.innerHTML = `
    <div class="page-head">
      <h1>PO-${o.id} · ${esc(o.supplier_name)}</h1>
      <div class="actions">
        <a class="btn" href="#/orders">‹ Orders</a>
        ${draft ? '<button class="btn btn-primary" id="send">Send to supplier</button><button class="btn btn-ghost" id="delete">Delete</button>' : ''}
        ${o.status === 'sent' ? '<button class="btn btn-primary" id="receive">Receive delivery</button><button class="btn" id="resend">Email again</button><button class="btn btn-ghost" id="cancel">Cancel order</button>' : ''}
        <button class="btn" id="copy">Copy order text</button>
        <button class="btn" id="print">Print</button>
      </div>
    </div>
    <div class="kpis">
      <div class="kpi"><span>Status</span><strong>${statusBadge(o.status)}</strong></div>
      <div class="kpi"><span>Site</span><strong>${esc(o.location_name)}</strong></div>
      <div class="kpi"><span>Delivery</span><strong>${fmtDate(o.delivery_date)}</strong></div>
      <div class="kpi"><span>Order total</span><strong>${money(o.total)}</strong></div>
    </div>
    <p class="muted">Created ${fmtDateTime(o.created_at)} by ${esc(o.created_by_name ?? '–')}
      ${o.sent_at ? ` · sent ${fmtDateTime(o.sent_at)}` : ''}${o.received_at ? ` · received ${fmtDateTime(o.received_at)}` : ''}</p>
    ${draft ? `
    <form class="card" id="edit-form">
      ${linesTable(o.lines.map((l) => ({ ...l, name: l.product_name })), { showSuggest: false })}
      <div class="row">
        ${field('Delivery date', input('delivery_date', o.delivery_date, 'type="date"'))}
        ${field('Notes for supplier', textarea('notes', o.notes))}
      </div>
      <div class="actions"><button class="btn" type="submit">Save changes</button></div>
    </form>` : `
    <section class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Product</th><th>Unit</th><th class="num">Ordered</th>${o.status === 'received' ? '<th class="num">Received</th>' : ''}<th class="num">Unit cost</th><th class="num">Total</th></tr></thead>
        <tbody>${o.lines.map((l) => `<tr class="${l.received_quantity !== null && l.received_quantity !== l.quantity ? 'row-warn' : ''}">
          <td>${esc(l.product_name)}</td><td>${esc(l.unit)}</td><td class="num">${qty(l.quantity)}</td>
          ${o.status === 'received' ? `<td class="num">${qty(l.received_quantity)}</td>` : ''}
          <td class="num">${money(l.unit_cost)}</td><td class="num">${money(l.quantity * l.unit_cost)}</td></tr>`).join('')}</tbody>
      </table></div>
      ${o.status === 'received' ? `<p><strong>Value received:</strong> ${money(receivedTotal)}${Math.abs(receivedTotal - o.total) > 0.005 ? ` <span class="alert-text">(${money(receivedTotal - o.total)} vs ordered)</span>` : ''}</p>` : ''}
      ${o.notes ? `<p><strong>Notes:</strong> ${esc(o.notes)}</p>` : ''}
    </section>`}`;

  const mailto = () => {
    const url = `mailto:${encodeURIComponent(o.supplier_email ?? '')}?subject=${encodeURIComponent(`Order PO-${o.id} – ${o.location_name}`)}&body=${encodeURIComponent(orderText(o))}`;
    window.location.href = url;
  };

  el.querySelector('#print').addEventListener('click', () => window.print());
  el.querySelector('#copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(orderText(o));
      toast('Order copied – paste it into an email or the supplier’s portal');
    } catch {
      openModal({ title: 'Order text', body: `<textarea rows="14" readonly>${esc(orderText(o))}</textarea>` });
    }
  });

  const form = el.querySelector('#edit-form');
  if (form) {
    const getLines = bindLines(form, 0);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/orders/${o.id}`, { method: 'PUT', body: { delivery_date: form.delivery_date.value || null, notes: form.notes.value, lines: getLines() } });
        toast('Order updated');
        ctx.rerender();
      } catch (err) { showError(err); }
    });
    el.querySelector('#send').addEventListener('click', async () => {
      if (!(await confirmDialog(`Mark PO-${o.id} as sent and open an email to ${o.supplier_name}? Save any changes first.`, { confirmLabel: 'Send', title: 'Send order' }))) return;
      try {
        await api(`/orders/${o.id}/send`, { method: 'POST' });
        mailto();
        ctx.rerender();
      } catch (err) { showError(err); }
    });
    el.querySelector('#delete').addEventListener('click', async () => {
      if (!(await confirmDialog('Delete this draft order?', { confirmLabel: 'Delete' }))) return;
      try {
        await api(`/orders/${o.id}`, { method: 'DELETE' });
        ctx.navigate('orders');
      } catch (err) { showError(err); }
    });
  }

  el.querySelector('#resend')?.addEventListener('click', mailto);
  el.querySelector('#cancel')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Cancel this order?', { confirmLabel: 'Cancel order' }))) return;
    try {
      await api(`/orders/${o.id}/cancel`, { method: 'POST' });
      ctx.rerender();
    } catch (err) { showError(err); }
  });
  el.querySelector('#receive')?.addEventListener('click', () => openModal({
    title: `Receive PO-${o.id}`,
    wide: true,
    body: `<p class="muted">Adjust any quantities that were short, damaged or substituted.</p>
      <table><thead><tr><th>Product</th><th class="num">Ordered</th><th class="num">Received</th></tr></thead>
      <tbody>${o.lines.map((l) => `<tr><td>${esc(l.product_name)}</td><td class="num">${qty(l.quantity)} ${esc(l.unit)}</td>
        <td class="num"><input type="number" min="0" step="any" name="line_${l.id}" value="${l.quantity}" class="qty-input"></td></tr>`).join('')}</tbody></table>`,
    submitLabel: 'Confirm delivery',
    onSubmit: async (v) => {
      const lines = o.lines.map((l) => ({ id: l.id, received_quantity: v[`line_${l.id}`] ?? 0 }));
      await api(`/orders/${o.id}/receive`, { method: 'POST', body: { lines } });
      toast('Delivery received');
      ctx.rerender();
    },
  }));
}
