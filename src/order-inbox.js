// Supplier orders by email from the orders mailbox (ORDERS_MAILBOX, e.g. orders@…, in Microsoft 365): Atlas sends
// each order in its own email thread, then checks the mailbox every few minutes for replies and adds them to the
// order – matched by the email thread, or by the order number (PO-123) in the subject. Replies can be answered from
// the order, in the same thread.
import { assertLocation, requirePerm } from './auth.js';
import { tx } from './db.js';
import { getSetting, setSetting } from './invoice-inbox.js';
import { notify, peopleWith } from './push.js';
import { badRequest, notFound, str } from './util.js';

const KEY = { since: 'orders_inbox_since', lastCheck: 'orders_inbox_last_check', lastError: 'orders_inbox_last_error' };
const FIRST_DAYS = 7;
const html = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const sqlTime = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 19) : null);
const cleanBody = (t) => String(t ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
// The reply itself, without the earlier emails quoted beneath it.
const ownPart = (t) => cleanBody(String(t ?? '').split(/\n\s*(?:From:\s|-{3,}\s*Original Message|On .{5,80} wrote:|_{10,})/i)[0]);
const listOf = (v) => String(v ?? '').split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
const qty = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const packUnit = (unit, pack) => (pack && pack !== 1 ? `${unit} × ${qty(pack)}` : unit ?? '');
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** The order, its lines, the site's address and its account number with the supplier. */
function orderForEmail(db, id) {
  const o = db.prepare(`SELECT o.*, s.name AS supplier_name, COALESCE(s.order_email, s.email) AS supplier_email, s.cc_emails AS supplier_cc,
      l.name AS location_name, l.address AS location_address,
      (SELECT reference FROM supplier_site_refs r WHERE r.supplier_id = o.supplier_id AND r.location_id = o.location_id) AS account_ref
    FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id JOIN locations l ON l.id = o.location_id WHERE o.id = ?`).get(id);
  if (!o) throw notFound('Order');
  o.lines = db.prepare(`SELECT ol.quantity, p.name, p.unit, p.pack_quantity, p.sku FROM purchase_order_lines ol JOIN products p ON p.id = ol.product_id
    WHERE ol.order_id = ? ORDER BY p.category, p.name`).all(id);
  return o;
}

/** The email for an order: { subject, text, html }. The subject carries PO-<id> so replies can be matched. */
export function orderEmail(o, { sender = null, message = '' } = {}) {
  const subject = `Order PO-${o.id} – ${o.location_name}`;
  const when = o.delivery_date ? ` on ${longDate(o.delivery_date)}` : '';
  const intro = `Please could we order the following for delivery to ${o.location_name}${when}:`;
  const ref = o.account_ref ? `Account number: ${o.account_ref}` : '';
  const text = [`Hello ${o.supplier_name},`, message, intro,
    o.lines.map((l) => `- ${qty(l.quantity)} x ${l.name} (${packUnit(l.unit, l.pack_quantity)})${l.sku ? ` [${l.sku}]` : ''}`).join('\n'),
    o.notes ? `Notes: ${o.notes}` : '', o.location_address ? `Delivery address:\n${o.location_name}\n${o.location_address}` : '',
    [`Order reference: PO-${o.id}`, ref].filter(Boolean).join('\n'),
    'Please reply to this email to confirm the order, or to let us know about anything that’s out of stock or substituted.',
    `Thank you${sender ? `\n${sender}` : ''}`].filter(Boolean).join('\n\n');
  const rows = o.lines.map((l) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #e6dccd;text-align:right"><strong>${qty(l.quantity)}</strong></td>
    <td style="padding:6px 10px;border-bottom:1px solid #e6dccd">${html(l.name)}</td><td style="padding:6px 10px;border-bottom:1px solid #e6dccd;color:#6e5d4b">${html(packUnit(l.unit, l.pack_quantity))}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #e6dccd;color:#6e5d4b">${html(l.sku ?? '')}</td></tr>`).join('');
  const page = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#2b2118;line-height:1.5">
    <p>Hello ${html(o.supplier_name)},</p>
    ${message ? `<p>${html(message).replace(/\n/g, '<br>')}</p>` : ''}
    <p>${html(intro)}</p>
    <table style="border-collapse:collapse;margin:8px 0 14px"><thead><tr style="background:#f5efe6">
      <th style="padding:6px 10px;text-align:right">Qty</th><th style="padding:6px 10px;text-align:left">Product</th><th style="padding:6px 10px;text-align:left">Unit</th><th style="padding:6px 10px;text-align:left">Code</th></tr></thead>
      <tbody>${rows}</tbody></table>
    ${o.notes ? `<p><strong>Notes:</strong> ${html(o.notes)}</p>` : ''}
    ${o.location_address ? `<p><strong>Delivery address:</strong><br>${html(o.location_name)}<br>${html(o.location_address).replace(/\n/g, '<br>')}</p>` : ''}
    <p><strong>Order reference: PO-${o.id}</strong>${ref ? `<br>${html(ref)}` : ''}</p>
    <p>Please reply to this email to confirm the order, or to let us know about anything that’s out of stock or substituted.</p>
    <p>Thank you${sender ? `<br>${html(sender)}` : ''}</p></div>`;
  return { subject, text, html: page };
}

/** Who hears about a reply: whoever placed the order, and people who order for that site (their home site). */
function replyAudience(db, order) {
  const site = peopleWith(db, ['orders.manage'], order.location_id);
  const home = new Set(db.prepare('SELECT id FROM users WHERE location_id = ?').all(order.location_id).map((u) => u.id));
  return [order.created_by, ...site.filter((id) => home.has(id))];
}

/** Adds one email from the mailbox to its order, if it belongs to one. Returns the order id, or null. */
function take(db, mailbox, m, body) {
  const from = String(m.from ?? '').toLowerCase();
  if (!from || from === String(mailbox.address).toLowerCase()) return null;
  let order = m.conversationId ? db.prepare('SELECT * FROM purchase_orders WHERE email_conversation_id = ?').get(m.conversationId) : null;
  if (!order) {
    // A new email (not a reply in the thread) that names the order: PO-123 in the subject.
    const n = /\bPO[-\s]?(\d{1,7})\b/i.exec(m.subject ?? '')?.[1];
    order = n ? db.prepare(`SELECT * FROM purchase_orders WHERE id = ? AND emailed_to IS NOT NULL`).get(Number(n)) : null;
  }
  if (!order) return null;
  const at = sqlTime(m.receivedAt) ?? sqlTime(new Date().toISOString());
  tx(db, () => {
    db.prepare(`INSERT INTO order_messages (order_id, direction, from_address, from_name, to_address, subject, body, email_message_id, web_link, has_attachments, created_at)
      VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(order.id, m.from, m.fromName ?? null, mailbox.address, String(m.subject ?? '').slice(0, 300),
      body || m.preview || null, m.id, m.webLink ?? null, m.hasAttachments ? 1 : 0, at);
    db.prepare('UPDATE purchase_orders SET reply_unread = 1, last_reply_at = max(COALESCE(last_reply_at, \'\'), ?) WHERE id = ?').run(at, order.id);
  });
  const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(order.supplier_id)?.name ?? 'The supplier';
  notify(db, replyAudience(db, order), 'order_reply', {
    title: `${supplier} replied about PO-${order.id}`,
    body: (body || m.preview || '').replace(/\s+/g, ' ').slice(0, 140),
    url: `/#/orders/${order.id}`,
  });
  return order.id;
}

let running = null;
/** Checks the orders mailbox once for replies (the first time, looking back a week). */
export function checkOrderReplies(db, { mailbox, now = new Date() }) {
  if (running) return running;
  running = (async () => {
    const summary = { checked: 0, added: 0 };
    let since = getSetting(db, KEY.since);
    if (!since) {
      since = new Date(now.getTime() - FIRST_DAYS * 86400000).toISOString();
      setSetting(db, KEY.since, since);
    }
    try {
      const seen = db.prepare('SELECT 1 FROM order_messages WHERE email_message_id = ?');
      let latest = since;
      for (const m of await mailbox.listNew(since)) {
        if (m.receivedAt && m.receivedAt > latest) latest = m.receivedAt;
        if (seen.get(m.id)) continue;
        summary.checked++;
        // Only emails that could belong to an order are opened.
        const could = (m.conversationId && db.prepare('SELECT 1 FROM purchase_orders WHERE email_conversation_id = ?').get(m.conversationId)) || /\bPO[-\s]?\d/i.test(m.subject ?? '');
        if (!could) continue;
        const body = ownPart(await mailbox.body(m.id));
        if (take(db, mailbox, m, body)) summary.added++;
      }
      // Next time, from the newest email seen (a little overlap is fine – each email is only added once).
      setSetting(db, KEY.since, latest);
      setSetting(db, KEY.lastError, null);
    } catch (err) {
      setSetting(db, KEY.lastError, err.message);
      summary.error = err.message;
    } finally {
      setSetting(db, KEY.lastCheck, now.toISOString());
    }
    return summary;
  })().finally(() => { running = null; });
  return running;
}

export function startOrdersInbox(db, { mailbox, minutes = 5, log = console }) {
  const run = async () => {
    const r = await checkOrderReplies(db, { mailbox });
    if (r.error) log.error(`Orders inbox: ${r.error}`);
    else if (r.added) log.log(`Orders inbox: ${r.added} supplier repl${r.added === 1 ? 'y' : 'ies'} added`);
  };
  setTimeout(run, 50000);
  return setInterval(run, minutes * 60000);
}

/** mailbox: the orders mailbox (graphMailbox / memoryMailbox), or null when it isn't connected. */
export function registerOrderEmailRoutes(router, db, mailbox = null) {
  const perm = requirePerm('orders.manage');
  const order = (req) => {
    const o = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(Number(req.params.id));
    if (!o) throw notFound('Order');
    assertLocation(req, o.location_id);
    return o;
  };
  const status = () => ({
    connected: !!mailbox,
    address: mailbox?.address ?? null,
    last_check: sqlTime(getSetting(db, KEY.lastCheck)),
    last_error: getSetting(db, KEY.lastError),
  });

  router.get('/orders-inbox', perm, (req, res) => res.json(status()));

  // The emails about an order (oldest first), and what the email to the supplier would say. Looking marks replies read.
  router.get('/orders/:id/emails', perm, (req, res) => {
    const o = order(req);
    if (o.reply_unread) db.prepare('UPDATE purchase_orders SET reply_unread = 0 WHERE id = ?').run(o.id);
    const full = orderForEmail(db, o.id);
    res.json({
      ...status(),
      to: listOf(full.supplier_email),
      cc: listOf(full.supplier_cc),
      preview: orderEmail(full, { sender: req.user.name }),
      messages: db.prepare(`SELECT m.*, u.name AS sent_by_name FROM order_messages m LEFT JOIN users u ON u.id = m.sent_by
        WHERE m.order_id = ? ORDER BY m.created_at, m.id`).all(o.id),
    });
  });

  // Emails the order to the supplier from the orders mailbox ({ message? } – a line to add at the top), and marks a
  // draft as sent. Sending again starts a new email with the order in it.
  router.post('/orders/:id/email', perm, async (req, res) => {
    if (!mailbox) throw badRequest('The orders mailbox isn’t connected yet – see Setup → Email.');
    const o = order(req);
    if (!['draft', 'sent'].includes(o.status)) throw badRequest('Only draft or sent orders can be emailed');
    const full = orderForEmail(db, o.id);
    if (!full.lines.length) throw badRequest('Add something to the order first');
    const to = listOf(full.supplier_email);
    if (!to.length) throw badRequest(`There’s no order email for ${full.supplier_name} – add one in Stock & Ordering → Suppliers`);
    const cc = listOf(full.supplier_cc);
    const message = str(req.body?.message, 'Message', { max: 2000 }) ?? '';
    const email = orderEmail(full, { sender: req.user.name, message });
    let sent;
    try {
      sent = await mailbox.sendNew({ to, cc, ...email });
    } catch (err) {
      throw badRequest(`The order couldn’t be emailed: ${err.message}`);
    }
    tx(db, () => {
      db.prepare(`UPDATE purchase_orders SET status = 'sent', sent_at = COALESCE(sent_at, datetime('now')), emailed_to = ?,
        email_conversation_id = COALESCE(?, email_conversation_id) WHERE id = ?`).run([...to, ...cc].join(', '), sent?.conversationId ?? null, o.id);
      db.prepare(`INSERT INTO order_messages (order_id, direction, from_address, to_address, subject, body, sent_by) VALUES (?, 'out', ?, ?, ?, ?, ?)`)
        .run(o.id, mailbox.address, [...to, ...cc].join(', '), email.subject, email.text, req.user.id);
    });
    res.json({ ok: true, to, cc, from: mailbox.address });
  });

  // Answers the supplier's latest email in its thread ({ text }).
  router.post('/orders/:id/reply', perm, async (req, res) => {
    if (!mailbox) throw badRequest('The orders mailbox isn’t connected yet – see Setup → Email.');
    const o = order(req);
    const text = str(req.body?.text, 'Reply', { required: true, max: 5000 });
    const last = db.prepare(`SELECT * FROM order_messages WHERE order_id = ? AND direction = 'in' AND email_message_id IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1`).get(o.id);
    if (!last) throw badRequest('There’s no email from the supplier to reply to yet');
    try {
      await mailbox.reply(last.email_message_id, `${text}\n\n${req.user.name}`);
    } catch (err) {
      throw badRequest(`The reply couldn’t be sent: ${err.message}`);
    }
    db.prepare(`INSERT INTO order_messages (order_id, direction, from_address, to_address, subject, body, sent_by) VALUES (?, 'out', ?, ?, ?, ?, ?)`)
      .run(o.id, mailbox.address, last.from_address, `RE: ${String(last.subject ?? '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '')}`.slice(0, 300), `${text}\n\n${req.user.name}`, req.user.id);
    db.prepare('UPDATE purchase_orders SET reply_unread = 0 WHERE id = ?').run(o.id);
    res.json({ ok: true });
  });

  // Checks the mailbox for replies now.
  router.post('/orders-inbox/check', perm, async (req, res) => {
    if (!mailbox) throw badRequest('The orders mailbox isn’t connected yet');
    res.json(await checkOrderReplies(db, { mailbox }));
  });
}

