import { api, confirmDialog, esc, fmtDateTime, money, openModal, showError, siteColour, toast } from '../lib.js';

// Setup → Payment links: ask a customer to pay a set amount through Square (deposits, catering, private hire).

const STATUS = { open: ['Waiting', 'badge-sent'], paid: ['Paid', 'badge-received'], cancelled: ['Cancelled', 'badge-cancelled'] };

async function copy(url) {
  try { await navigator.clipboard.writeText(url); toast('Link copied – paste it into an email, text or WhatsApp'); } catch { window.prompt('Copy this payment link:', url); }
}

export async function render(ctx) {
  const { el, stale } = ctx;
  const data = await api('/payment-links');
  if (stale()) return;
  const show = ctx.query.show === 'all' ? 'all' : ctx.query.show === 'paid' ? 'paid' : 'open';
  const list = data.links.filter((p) => show === 'all' || p.status === show);
  const waiting = data.links.filter((p) => p.status === 'open');
  const waitingTotal = waiting.reduce((n, p) => n + p.amount, 0);
  const tab = (v, label, n) => `<a href="#/admin/payment-links${v === 'open' ? '' : `?show=${v}`}" class="${show === v ? 'active' : ''}">${label}${n !== undefined ? ` <span class="muted">${n}</span>` : ''}</a>`;

  el.innerHTML = `
    <div class="page-head">
      <h1>Payment links</h1>
      <div class="actions">${data.square_ready ? '<button class="btn btn-primary" id="new-link">+ New payment link</button>' : ''}</div>
    </div>
    ${data.square_ready ? '' : '<p class="notice">Connect Square first (Setup → Square) to send payment links.</p>'}
    <p class="muted">Ask a customer to pay a set amount – a deposit, a catering order, private hire – by card, Apple Pay or Google Pay. Square takes the payment; it shows here as paid and comes into that site’s sales.</p>
    ${waiting.length ? `<div class="kpis"><div class="kpi" data-icon="£"><span>Waiting to be paid</span><strong>${money(waitingTotal)}</strong><small>${waiting.length} link${waiting.length === 1 ? '' : 's'}</small></div></div>` : ''}
    <nav class="tabs">${tab('open', 'Waiting', waiting.length)}${tab('paid', 'Paid')}${tab('all', 'All')}</nav>
    <section class="card">
      ${list.length ? `<div class="table-wrap"><table class="pay-links">
        <thead><tr><th>Customer</th><th>For</th><th>Site</th><th class="num">Amount</th><th>Status</th><th>Sent</th><th></th></tr></thead>
        <tbody>${list.map((p) => {
          const [label, badge] = STATUS[p.status];
          return `<tr data-id="${p.id}">
            <td class="cell-title"><strong>${esc(p.customer_name || 'No name')}</strong>${p.customer_email ? `<small>${esc(p.customer_email)}</small>` : ''}</td>
            <td>${esc(p.description)}${p.note ? `<small class="muted">${esc(p.note)}</small>` : ''}</td>
            <td><span class="site-dot" style="--site: ${siteColour(p.location_name, p.location_id)}"></span>${esc(p.location_name)}</td>
            <td class="num"><strong>${money(p.amount)}</strong></td>
            <td><span class="badge ${badge}">${label}</span>${p.paid_at ? `<small class="muted">${fmtDateTime(p.paid_at)}</small>` : ''}</td>
            <td><small>${fmtDateTime(p.created_at)} · ${esc(p.created_by_name ?? '')}${p.emailed_at ? '<br>✉ emailed' : ''}</small></td>
            <td class="pay-actions">${p.status === 'open' ? `
              <button class="btn btn-small" data-copy="${esc(p.url)}">Copy link</button>
              ${data.email_ready ? `<button class="btn btn-small" data-email="${p.id}">${p.emailed_at ? 'Email again' : 'Email'}</button>` : ''}
              <button class="btn btn-small btn-ghost" data-check="${p.id}">Check paid</button>
              <button class="btn btn-small btn-ghost" data-cancel="${p.id}">Cancel</button>` : ''}</td>
          </tr>`;
        }).join('')}</tbody></table></div>`
        : `<div class="empty">${show === 'open' ? 'No payment links waiting to be paid.' : 'Nothing here yet.'}</div>`}
      <p class="muted small">Paid links are checked with Square each time this page opens. Refunds are done in the Square Dashboard.</p>
    </section>`;

  el.querySelector('#new-link')?.addEventListener('click', () => newLink(ctx, data));
  el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy)));
  el.querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api(`/payment-links/${b.dataset.check}/check`, { method: 'POST' });
      toast(r.status === 'paid' ? 'Paid ✓' : 'Not paid yet');
      ctx.rerender();
    } catch (err) { showError(err); b.disabled = false; }
  }));
  el.querySelectorAll('[data-email]').forEach((b) => b.addEventListener('click', () => {
    const p = data.links.find((x) => x.id === Number(b.dataset.email));
    openModal({
      title: `Email the payment link`,
      submitLabel: 'Send email',
      body: `<p>${money(p.amount)} – ${esc(p.description)}</p>
        <label class="field"><span>Customer email</span><input name="customer_email" type="email" required value="${esc(p.customer_email ?? '')}"></label>`,
      onSubmit: async (v) => {
        await api(`/payment-links/${p.id}/email`, { method: 'POST', body: { customer_email: v.customer_email } });
        toast(`Emailed to ${v.customer_email}`);
        ctx.rerender();
      },
    });
  }));
  el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    const p = data.links.find((x) => x.id === Number(b.dataset.cancel));
    if (!(await confirmDialog(`Cancel the ${money(p.amount)} link for ${p.customer_name || 'this customer'}? It stops working straight away.`, { confirmLabel: 'Cancel link', title: 'Cancel payment link' }))) return;
    try { await api(`/payment-links/${p.id}/cancel`, { method: 'POST' }); toast('Link cancelled'); ctx.rerender(); } catch (err) { showError(err); }
  }));
}

function newLink(ctx, data) {
  const { state } = ctx;
  const sites = state.locations.filter((l) => l.active);
  const { form } = openModal({
    title: 'New payment link',
    submitLabel: 'Create link',
    body: `
      <div class="row">
        <label class="field"><span>Amount (£)</span><input name="amount" type="number" min="1" max="10000" step="0.01" required inputmode="decimal"></label>
        ${sites.length > 1 ? `<label class="field"><span>Paid to</span><select name="location_id">${sites.map((l) => `<option value="${l.id}" ${l.id === state.locationId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>` : ''}
      </div>
      <label class="field"><span>What it’s for</span><input name="description" required maxlength="120" placeholder="e.g. Deposit – birthday party, Sat 14 Nov"></label>
      <div class="row">
        <label class="field"><span>Customer name</span><input name="customer_name" maxlength="100"></label>
        <label class="field"><span>Customer email</span><input name="customer_email" type="email" maxlength="200"></label>
      </div>
      <label class="field"><span>Note for your team (optional)</span><input name="note" maxlength="500" placeholder="Only shown in Atlas"></label>
      ${data.email_ready ? '<label class="check-row"><input type="checkbox" name="send_email" checked><span><strong>Email the link to the customer</strong><small>From your Atlas email address. Untick to copy the link and send it yourself.</small></span></label>' : '<p class="muted small">Email isn’t set up, so you’ll get a link to copy and send yourself.</p>'}
      <p class="muted small">The customer pays on a secure Square page by card, Apple Pay or Google Pay.</p>`,
    onSubmit: async (v) => {
      if (v.send_email && !v.customer_email) throw new Error('Add the customer’s email, or untick “Email the link”');
      const r = await api('/payment-links', { method: 'POST', body: { ...v, amount: Number(v.amount), location_id: v.location_id ? Number(v.location_id) : state.locationId, send_email: !!v.send_email } });
      if (r.email_error) toast(`Link created, but the email didn’t send: ${r.email_error}`, 'error');
      else if (v.send_email) toast(`Payment link emailed to ${v.customer_email}`);
      else await copy(r.url);
      ctx.rerender();
    },
  });
  form.amount.focus();
}
