// Setup → Payment links: ask a customer to pay a set amount (a deposit, a catering order, private hire) through a
// Square Checkout link. Brewly creates the link in Square for the chosen site, can email it to the customer, and
// keeps a list showing whether each has been paid. Card details only ever go to Square.
import { randomBytes } from 'node:crypto';
import { requirePerm, resolveLocation } from '../auth.js';
import { appUrl } from '../reports.js';
import { badRequest, HttpError, notFound, num, str } from '../util.js';

const MAX_AMOUNT = 10000;
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
const key = () => randomBytes(16).toString('hex');

function squareProblem(err) {
  const msg = String(err.message ?? '').replace(/^Square error: /, '');
  if (/UNAUTHORIZED|INSUFFICIENT_SCOPES|forbidden|permission/i.test(msg)) {
    return new HttpError(502, `Square didn’t allow it: ${msg}. The Square access token needs permission to create orders and take payments (ORDERS_WRITE and PAYMENTS_WRITE).`);
  }
  return new HttpError(err.status ?? 502, `Square: ${msg}`);
}

function linkEmail({ name, site, description, amount, url, sender }) {
  const first = String(name || '').split(' ')[0];
  return {
    subject: `Payment request from ${site}: ${description}`,
    text: `${first ? `Hi ${first},\n\n` : ''}${site} has sent you a payment request for ${money(amount)} – ${description}.\n\nPay securely here (card, Apple Pay or Google Pay):\n${url}\n\nThanks,\n${sender}, ${site}\n`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:auto;color:#0c1014">
      ${first ? `<p>Hi ${escHtml(first)},</p>` : ''}
      <p><strong>${escHtml(site)}</strong> has sent you a payment request:</p>
      <p style="font-size:18px"><strong>${escHtml(money(amount))}</strong> – ${escHtml(description)}</p>
      <p style="margin:28px 0"><a href="${escHtml(url)}" style="background:#0095f6;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Pay ${escHtml(money(amount))}</a></p>
      <p style="color:#737373;font-size:13px">Payments are taken securely by Square. Button not working? Copy this link into your browser:<br>${escHtml(url)}</p>
      <p>Thanks,<br>${escHtml(sender)}, ${escHtml(site)}</p></div>`,
  };
}

export function registerPaymentLinkRoutes(router, db, square, mailer) {
  const siteName = (locationId) => db.prepare('SELECT name FROM locations WHERE id = ?').get(locationId)?.name ?? 'Brewly';
  const visible = (req) => db.prepare(`SELECT p.*, l.name AS location_name FROM payment_links p JOIN locations l ON l.id = p.location_id
    ORDER BY p.created_at DESC, p.id DESC LIMIT 300`).all().filter((p) => req.user.site_ids.includes(p.location_id));
  const load = (req) => {
    const p = db.prepare('SELECT p.*, l.name AS location_name FROM payment_links p JOIN locations l ON l.id = p.location_id WHERE p.id = ?').get(Number(req.params.id));
    if (!p || !req.user.site_ids.includes(p.location_id)) throw notFound('Payment link');
    return p;
  };
  const needSquare = () => { if (!square) throw badRequest('Square isn’t connected yet (Setup → Square).'); };

  // Whether a link has been paid: its Square order has a payment and nothing left to pay.
  async function refresh(p) {
    if (p.status !== 'open' || !p.square_order_id) return p;
    const order = await square.client.getOrder(p.square_order_id);
    const paid = order && (order.state === 'COMPLETED' || ((order.tenders ?? []).length > 0 && (order.net_amount_due_money?.amount ?? 1) === 0));
    db.prepare(`UPDATE payment_links SET checked_at = datetime('now')${paid ? ", status = 'paid', paid_at = datetime('now')" : ''} WHERE id = ?`).run(p.id);
    return { ...p, ...(paid ? { status: 'paid' } : {}) };
  }

  async function sendEmail(req, p) {
    if (!mailer) throw badRequest('Email isn’t set up, so use “Copy link” and send it yourself.');
    if (!p.customer_email) throw badRequest('Add the customer’s email first');
    await mailer.send({ to: p.customer_email, name: p.customer_name, ...linkEmail({ name: p.customer_name, site: p.location_name ?? siteName(p.location_id), description: p.description, amount: p.amount, url: p.url, sender: req.user.name }) });
    db.prepare(`UPDATE payment_links SET emailed_at = datetime('now') WHERE id = ?`).run(p.id);
  }

  router.get('/payment-links', requirePerm('payments.send'), async (req, res) => {
    let list = visible(req);
    // Check the unpaid ones with Square (not more often than every couple of minutes each).
    if (square) {
      const due = list.filter((p) => p.status === 'open' && (!p.checked_at || Date.parse(`${p.checked_at.replace(' ', 'T')}Z`) < Date.now() - 2 * 60000)).slice(0, 20);
      for (const p of due) { try { await refresh(p); } catch { /* shown as unpaid; checked again next time */ } }
      if (due.length) list = visible(req);
    }
    res.json({ square_ready: !!square, email_ready: !!mailer, links: list });
  });

  router.post('/payment-links', requirePerm('payments.send'), async (req, res) => {
    needSquare();
    const b = req.body ?? {};
    const locationId = resolveLocation(req, b.location_id);
    const site = db.prepare('SELECT name, square_location_id FROM locations WHERE id = ?').get(locationId);
    if (!site.square_location_id) throw badRequest(`${site.name} isn’t linked to a Square location yet (Setup → Square)`);
    const amount = num(b.amount, 'Amount', { required: true, min: 1, max: MAX_AMOUNT });
    if (Math.round(amount * 100) !== amount * 100) throw badRequest('Amount can only have pence (two decimal places)');
    const description = str(b.description, 'What it’s for', { required: true, max: 120 });
    const customerName = str(b.customer_name, 'Customer name', { max: 100 });
    const customerEmail = str(b.customer_email, 'Customer email', { max: 200 });
    if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw badRequest('That email address doesn’t look right');
    const note = str(b.note, 'Note', { max: 500 });
    if (b.send_email && !customerEmail) throw badRequest('Add the customer’s email to send it to them');

    let link;
    try {
      const base = appUrl();
      ({ payment_link: link } = await square.client.createPaymentLink({
        idempotency_key: key(),
        description: `${description}${customerName ? ` – ${customerName}` : ''}`.slice(0, 255),
        quick_pay: { name: description, price_money: { amount: Math.round(amount * 100), currency: 'GBP' }, location_id: site.square_location_id },
        ...(customerEmail ? { pre_populated_data: { buyer_email: customerEmail } } : {}),
        ...(base ? { checkout_options: { redirect_url: `${base}/paid.html` } } : {}),
        payment_note: `Brewly payment link${customerName ? ` – ${customerName}` : ''}`.slice(0, 500),
      }));
    } catch (err) {
      throw squareProblem(err);
    }
    if (!link?.url) throw new HttpError(502, 'Square didn’t return a link – try again');
    const r = db.prepare(`INSERT INTO payment_links (location_id, square_link_id, square_order_id, url, amount, description, customer_name, customer_email, note, created_by, created_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(locationId, link.id, link.order_id ?? null, link.url, amount, description, customerName, customerEmail, note, req.user.id, req.user.name);
    const saved = db.prepare('SELECT p.*, l.name AS location_name FROM payment_links p JOIN locations l ON l.id = p.location_id WHERE p.id = ?').get(r.lastInsertRowid);
    let emailError = null;
    if (b.send_email) {
      try { await sendEmail(req, saved); } catch (err) { emailError = err.message; }
    }
    res.status(201).json({ ...db.prepare('SELECT * FROM payment_links WHERE id = ?').get(saved.id), email_error: emailError });
  });

  router.post('/payment-links/:id/email', requirePerm('payments.send'), async (req, res) => {
    const p = load(req);
    if (p.status !== 'open') throw badRequest(p.status === 'paid' ? 'This has already been paid' : 'This link was cancelled');
    if (req.body?.customer_email !== undefined) {
      const email = str(req.body.customer_email, 'Customer email', { required: true, max: 200 });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('That email address doesn’t look right');
      db.prepare('UPDATE payment_links SET customer_email = ? WHERE id = ?').run(email, p.id);
      p.customer_email = email;
    }
    await sendEmail(req, p);
    res.json(db.prepare('SELECT * FROM payment_links WHERE id = ?').get(p.id));
  });

  router.post('/payment-links/:id/check', requirePerm('payments.send'), async (req, res) => {
    needSquare();
    try { await refresh(load(req)); } catch (err) { throw squareProblem(err); }
    res.json(db.prepare('SELECT * FROM payment_links WHERE id = ?').get(Number(req.params.id)));
  });

  // Cancelling deletes the link in Square, so it can't be paid any more.
  router.post('/payment-links/:id/cancel', requirePerm('payments.send'), async (req, res) => {
    needSquare();
    let p = load(req);
    if (p.status !== 'open') throw badRequest(p.status === 'paid' ? 'This has already been paid – refund it in Square instead' : 'Already cancelled');
    try { p = await refresh(p); } catch { /* still try to cancel */ }
    if (p.status === 'paid') throw badRequest('This has just been paid – refund it in Square instead');
    try { await square.client.deletePaymentLink(p.square_link_id); } catch (err) { throw squareProblem(err); }
    db.prepare(`UPDATE payment_links SET status = 'cancelled' WHERE id = ?`).run(p.id);
    res.json(db.prepare('SELECT * FROM payment_links WHERE id = ?').get(p.id));
  });

}
