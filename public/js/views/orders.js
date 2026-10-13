import { addDays, api, isDemo, confirmDialog, esc, field, fmtDate, fmtDateTime, input, money, openModal, packUnit, qs, qty, select, showError, statusBadge, textarea, toast, todayISO, sitePicker } from '../lib.js';
import { nextDelivery, scheduleSummary } from '../delivery.js';

const STATUSES = [['', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['received', 'Received'], ['cancelled', 'Cancelled']];

export async function renderList(ctx) {
  const { el, state, query, stale } = ctx;
  const status = query.status ?? '';
  const orders = await api(`/orders${qs({ location_id: state.locationId, status })}`);
  if (stale()) return;

  el.innerHTML = `
    <div class="page-head">
      <h1>Order history${state.multiSite ? '' : ` · ${esc(state.location?.name ?? '')}`}</h1>
      <div class="actions">${sitePicker(state)}<a class="btn btn-primary" href="#/orders/new">+ New order</a></div>
    </div>
    <div class="tabs">${STATUSES.map(([v, l]) => `<a href="#/orders${v ? `?status=${v}` : ''}" class="${status === v ? 'active' : ''}">${l}</a>`).join('')}</div>
    <section class="card">
      ${orders.length ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Supplier</th><th>Status</th><th>Items</th><th class="num">Total</th><th>Delivery</th><th>Created</th></tr></thead>
        <tbody>${orders.map((o) => `<tr class="clickable" data-id="${o.id}">
          <td><a href="#/orders/${o.id}">PO-${o.id}</a></td><td>${esc(o.supplier_name)}</td><td>${statusBadge(o.status)}${o.reply_unread ? ' <span class="badge badge-sent" title="The supplier has replied">💬 New reply</span>' : o.emailed_to ? ' <span class="muted small" title="Emailed from the orders mailbox">✉</span>' : ''}</td>
          <td>${o.line_count}</td><td class="num">${money(o.total)}</td><td>${fmtDate(o.delivery_date)}</td>
          <td>${fmtDateTime(o.created_at)} · ${esc(o.created_by_name ?? '')}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">No orders yet.</div>'}
    </section>`;
  el.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => ctx.navigate(`orders/${tr.dataset.id}`)));
}

// Stock & Ordering → Receive order: orders sent and waiting for delivery, soonest first.
export async function renderReceive(ctx) {
  const { el, state, stale, navigate } = ctx;
  const list = await api(`/orders${qs({ location_id: state.locationId, status: 'sent' })}`);
  if (stale()) return;
  const today = todayISO();
  list.sort((a, b) => (a.delivery_date ?? '9999').localeCompare(b.delivery_date ?? '9999') || a.id - b.id);
  el.innerHTML = `
    <div class="page-head">
      <h1>Receive order${state.multiSite ? '' : ` · ${esc(state.location?.name ?? '')}`}</h1>
      <div class="actions">${sitePicker(state)}<a class="btn" href="#/orders">All orders</a></div>
    </div>
    <p class="muted">Orders sent and waiting for delivery. Tap <strong>Receive</strong> when it arrives to check it in against what was ordered.</p>
    <section class="card">
      ${list.length ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Supplier</th><th>Delivery</th><th>Items</th><th class="num">Total</th><th></th></tr></thead>
        <tbody>${list.map((o) => `<tr>
          <td><a href="#/orders/${o.id}">PO-${o.id}</a></td><td>${esc(o.supplier_name)}${o.reply_unread ? ' <span class="badge badge-sent">💬 New reply</span>' : ''}</td>
          <td>${o.delivery_date ? `${fmtDate(o.delivery_date)}${o.delivery_date < today ? ' <span class="alert-text small">late</span>' : o.delivery_date === today ? ' <strong class="small">today</strong>' : ''}` : '<span class="muted">Not set</span>'}</td>
          <td>${o.line_count}</td><td class="num">${money(o.total)}</td>
          <td class="num"><button class="btn btn-small btn-primary" data-receive="${o.id}">Receive</button></td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">Nothing waiting to be delivered. <a href="#/orders/new">Start a new order</a>.</div>'}
    </section>`;
  el.querySelectorAll('[data-receive]').forEach((b) => b.addEventListener('click', () => navigate(`orders/${b.dataset.receive}?receive=1`)));
}

function linesTable(rows, { showSuggest }) {
  return `<div class="table-wrap"><table class="order-lines">
    <thead><tr><th>Product</th><th>Unit</th>${showSuggest ? '<th class="num">Par</th><th class="num">On hand</th><th class="num">Suggested</th>' : ''}
      <th class="num">Unit cost</th><th class="num">Order qty</th><th class="num">Line total</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr data-product="${r.product_id}" data-cost="${r.unit_cost}">
        <td>${esc(r.name)}</td><td>${esc(packUnit(r.unit, r.pack_quantity))}</td>
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
  const suppliers = (await api('/suppliers')).filter((s) => s.active && s.orders_enabled);
  if (stale()) return;
  const supplierId = Number(query.supplier) || null;
  const supplier = suppliers.find((s) => s.id === supplierId);
  // The next delivery that can still be ordered for, from the supplier's delivery days and cut-offs.
  const next = supplier ? nextDelivery(supplier.delivery_schedule) : null;
  const suggestion = supplier ? await api(`/orders/suggest${qs({ location_id: state.locationId, supplier_id: supplier.id })}`) : null;
  if (stale()) return;

  el.innerHTML = `
    <div class="page-head">
      <h1>New order${state.multiSite ? '' : ` · ${esc(state.location?.name ?? '')}`}</h1>
      <div class="actions">${sitePicker(state)}<a class="btn" href="#/orders">‹ Orders</a></div>
    </div>
    <section class="card">
      ${field('Supplier', select('supplier', [['', 'Choose a supplier…'], ...suppliers.map((s) => [s.id, s.name])], supplierId ?? '', 'id="supplier"'))}
      ${supplier ? `<p class="muted">Deliveries: ${esc(scheduleSummary(supplier.delivery_schedule))}${next ? ` · next: <strong>${fmtDate(next.date)}</strong> if ordered by ${esc(next.cutoff.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}` : ''} · Minimum order: ${money(supplier.min_order)}</p>` : ''}
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
        ${field('Delivery date', input('delivery_date', next?.date ?? addDays(todayISO(), supplier.lead_time_days || 1), 'type="date"'))}
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
  const lines = o.lines.map((l) => `- ${qty(l.quantity)} x ${l.product_name} (${packUnit(l.unit, l.pack_quantity)})${l.sku ? ` [${l.sku}]` : ''}`).join('\n');
  return `Hello ${o.supplier_name},

Please could we order the following for delivery to ${o.location_name}${o.delivery_date ? ` on ${fmtDate(o.delivery_date, { weekday: 'long', day: 'numeric', month: 'long' })}` : ''}:

${lines}
${o.notes ? `\nNotes: ${o.notes}\n` : ''}
Order reference: PO-${o.id}

Thank you`;
}

// ---- Emailing orders from the orders mailbox, and the supplier's replies ----

function conversation(o, mail) {
  if (!mail) return '';
  const msgs = mail.messages ?? [];
  if (!mail.connected && !msgs.length) return '';
  const lastIn = [...msgs].reverse().find((m) => m.direction === 'in');
  return `<section class="card po-mail" id="po-mail">
    <div class="po-mail-head"><div><h2>Emails with ${esc(o.supplier_name)}</h2>
      <p class="muted small">${mail.connected ? `From ${esc(mail.address)} – the supplier’s replies appear here (checked every few minutes)${mail.last_check ? `, last checked ${fmtDateTime(mail.last_check)}` : ''}.` : 'The orders mailbox isn’t connected at the moment.'}</p>
      ${mail.last_error ? `<p class="notice small">Couldn’t check for replies: ${esc(mail.last_error)}</p>` : ''}</div>
      ${mail.connected && msgs.length ? '<button class="btn btn-small" id="po-check">Check for replies</button>' : ''}</div>
    ${msgs.length ? `<ol class="po-thread">${msgs.map((m) => `<li class="po-msg po-${m.direction}">
      <div class="po-msg-head"><strong>${m.direction === 'in' ? esc(m.from_name || m.from_address || 'Supplier') : `${esc(m.sent_by_name ?? 'Atlas')} → ${esc(m.to_address ?? '')}`}</strong>
        <span class="muted small">${fmtDateTime(m.created_at)}</span></div>
      ${m.subject ? `<div class="small muted">${esc(m.subject)}</div>` : ''}
      <div class="po-body">${esc(m.body ?? '').replace(/\n/g, '<br>')}</div>
      ${m.has_attachments || m.web_link ? `<div class="small">${m.has_attachments ? '📎 Has attachments · ' : ''}${m.web_link ? `<a href="${esc(m.web_link)}" target="_blank" rel="noopener">Open in Outlook</a>` : ''}</div>` : ''}
    </li>`).join('')}</ol>` : `<p class="muted">Not emailed yet. Use <strong>✉ Email to supplier</strong> to send it from ${esc(mail.address)}.</p>`}
    ${mail.connected && lastIn ? `<form id="po-reply" class="po-reply">
      <label class="field"><span>Reply to ${esc(lastIn.from_name || lastIn.from_address)}</span><textarea name="text" rows="3" required maxlength="5000" placeholder="e.g. Thanks – the substitute is fine."></textarea></label>
      <div class="actions"><button class="btn btn-primary" type="submit">Send reply</button></div></form>` : ''}
  </section>`;
}

function wireEmail(el, o, mail, ctx) {
  el.querySelector('#email')?.addEventListener('click', () => {
    const p = mail.preview;
    openModal({
      title: `Email PO-${o.id} to ${o.supplier_name}`,
      wide: true,
      body: `${mail.to.length ? '' : '<p class="notice small">There’s no order email address for this supplier yet – add one in Stock &amp; Ordering → Suppliers.</p>'}
        <dl class="po-envelope"><dt>From</dt><dd>${esc(mail.address)}</dd><dt>To</dt><dd>${esc(mail.to.join(', ') || '–')}</dd>
          ${mail.cc.length ? `<dt>Cc</dt><dd>${esc(mail.cc.join(', '))}</dd>` : ''}<dt>Subject</dt><dd>${esc(p.subject)}</dd></dl>
        ${field('Add a message (optional)', textarea('message', '', 'rows="2" maxlength="2000" placeholder="e.g. Please could you deliver before 10am?"'))}
        <details><summary class="small">See the email</summary><pre class="po-preview">${esc(p.text)}</pre></details>
        ${o.status === 'sent' ? '<p class="muted small">This sends the order again as a new email.</p>' : '<p class="muted small">Save any changes to the order first. Sending marks it as sent.</p>'}`,
      submitLabel: 'Send email',
      onSubmit: async (v) => {
        const r = await api(`/orders/${o.id}/email`, { method: 'POST', body: { message: v.message } });
        toast(`Order emailed to ${r.to.join(', ')}`);
        ctx.rerender();
      },
    });
  });
  el.querySelector('#po-check')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/orders-inbox/check', { method: 'POST' });
      toast(r.error ? `Couldn’t check: ${r.error}` : r.added ? `${r.added} new repl${r.added === 1 ? 'y' : 'ies'}` : 'No new replies', r.error ? 'error' : 'ok');
      ctx.rerender();
    } catch (err) { showError(err); e.target.disabled = false; }
  });
  const reply = el.querySelector('#po-reply');
  reply?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = reply.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api(`/orders/${o.id}/reply`, { method: 'POST', body: { text: reply.text.value } });
      toast('Reply sent');
      ctx.rerender();
    } catch (err) { showError(err); btn.disabled = false; }
  });
}

export async function renderOrder(ctx) {
  const { el, params, stale } = ctx;
  const [o, mail] = await Promise.all([api(`/orders/${params[0]}`), api(`/orders/${params[0]}/emails`).catch(() => null)]);
  if (stale()) return;
  // Emailing from the orders mailbox (Microsoft 365), when it's connected; otherwise the person's own email app.
  const inbox = mail?.connected && mail?.enabled;
  const draft = o.status === 'draft';
  const receivedTotal = o.lines.reduce((s, l) => s + (l.received_quantity ?? 0) * l.unit_cost, 0);

  el.innerHTML = `
    <div class="page-head">
      <h1>PO-${o.id} · ${esc(o.supplier_name)}</h1>
      <div class="actions">
        <a class="btn" href="#/orders">‹ Orders</a>
        ${draft ? `<button class="btn btn-primary" id="${inbox ? 'email' : 'send'}">${inbox ? '✉ Email to supplier' : 'Send to supplier'}</button>${inbox ? '<button class="btn" id="send">Mark as sent</button>' : ''}<button class="btn btn-ghost" id="delete">Delete</button>` : ''}
        ${o.status === 'sent' ? `<button class="btn btn-primary" id="receive">Receive delivery</button><button class="btn" id="${inbox ? 'email' : 'resend'}">Email again</button><button class="btn btn-ghost" id="cancel">Cancel order</button>` : ''}
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
          <td>${esc(l.product_name)}</td><td>${esc(packUnit(l.unit, l.pack_quantity))}</td><td class="num">${qty(l.quantity)}</td>
          ${o.status === 'received' ? `<td class="num">${qty(l.received_quantity)}</td>` : ''}
          <td class="num">${money(l.unit_cost)}</td><td class="num">${money(l.quantity * l.unit_cost)}</td></tr>`).join('')}</tbody>
      </table></div>
      ${o.status === 'received' ? `<p><strong>Value received:</strong> ${money(receivedTotal)}${Math.abs(receivedTotal - o.total) > 0.005 ? ` <span class="alert-text">(${money(receivedTotal - o.total)} vs ordered)</span>` : ''}</p>` : ''}
      ${o.notes ? `<p><strong>Notes:</strong> ${esc(o.notes)}</p>` : ''}
    </section>`}
    ${conversation(o, mail)}`;

  const mailto = () => {
    if (isDemo) {
      openModal({
        title: `Email to ${o.supplier_name}`,
        wide: true,
        body: `<p>To: <strong>${esc(o.supplier_email ?? 'no email saved')}</strong>${o.supplier_cc ? ` · Cc: ${esc(o.supplier_cc)}` : ''} · Subject: Order PO-${o.id} – ${esc(o.location_name)}</p>
          <p class="muted">In the installed app this opens a ready-written email. Here is the text:</p>
          <textarea rows="14" readonly>${esc(orderText(o))}</textarea>`,
      });
      return;
    }
    const cc = o.supplier_cc ? `&cc=${encodeURIComponent(o.supplier_cc.replace(/\s+/g, ''))}` : '';
    const url = `mailto:${encodeURIComponent((o.supplier_email ?? '').replace(/\s+/g, ''))}?subject=${encodeURIComponent(`Order PO-${o.id} – ${o.location_name}`)}${cc}&body=${encodeURIComponent(orderText(o))}`;
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
      const ask = inbox ? `Mark PO-${o.id} as sent without emailing it (e.g. you ordered by phone or on the supplier’s website)?` : `Mark PO-${o.id} as sent and open an email to ${o.supplier_name}? Save any changes first.`;
      if (!(await confirmDialog(ask, { confirmLabel: inbox ? 'Mark as sent' : 'Send', title: 'Send order' }))) return;
      try {
        await api(`/orders/${o.id}/send`, { method: 'POST' });
        if (!inbox) mailto();
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
  if (inbox) wireEmail(el, o, mail, ctx);
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
      <tbody>${o.lines.map((l) => `<tr><td>${esc(l.product_name)}</td><td class="num">${qty(l.quantity)} × ${esc(packUnit(l.unit, l.pack_quantity))}</td>
        <td class="num"><input type="number" min="0" step="any" name="line_${l.id}" value="${l.quantity}" class="qty-input"></td></tr>`).join('')}</tbody></table>`,
    submitLabel: 'Confirm delivery',
    onSubmit: async (v) => {
      const lines = o.lines.map((l) => ({ id: l.id, received_quantity: v[`line_${l.id}`] ?? 0 }));
      await api(`/orders/${o.id}/receive`, { method: 'POST', body: { lines } });
      toast('Delivery received');
      ctx.rerender();
    },
  }));
  // From Receive order: straight into checking the delivery in.
  if (ctx.query?.receive && o.status === 'sent') el.querySelector('#receive')?.click();
}
