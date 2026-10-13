// Setup → Email: who each kind of email Atlas sends comes from (address, name and reply-to), and the inboxes it
// reads. Sending goes through Brevo, which only sends from addresses verified there.

import { requireAdmin } from '../auth.js';
import { EMAIL_KINDS, PROVIDERS, saveProvider, saveSenders, savedSenders, senderFor } from '../email.js';
import { badRequest, str } from '../util.js';

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const address = (v, label) => {
  const s = str(v, label, { max: 200 });
  if (s && !EMAIL.test(s)) throw badRequest(`${label} isn’t an email address`);
  return s ? s.toLowerCase() : null;
};

/** mailer: the (sender-aware) mailer or null; inboxes: { events, careers, invoices } mailboxes or null. */
export function registerEmailSettingsRoutes(router, db, mailer, inboxes = {}) {
  const view = () => {
    const saved = savedSenders(db);
    return {
      ready: !!mailer,
      // Brevo and/or Microsoft 365: which are set up on the server, and which is used.
      providers: Object.entries(PROVIDERS).map(([key, label]) => ({ key, label, ready: !!mailer?.available?.includes(key) })),
      provider: mailer?.provider?.() ?? null,
      server_from: mailer?.from ?? null,
      server_name: mailer?.fromName ?? null,
      kinds: EMAIL_KINDS.map(([key, label, note]) => ({
        key, label, note,
        saved: { from: saved[key]?.from ?? '', name: saved[key]?.name ?? '', reply_to: saved[key]?.reply_to ?? '' },
        uses: senderFor(db, mailer, key),
      })),
      inboxes: [
        ['orders', 'Supplier orders', 'Orders are emailed to suppliers from it, and their replies are added to the order.', 'ORDERS_MAILBOX'],
        ['events', 'Events enquiries', 'Read for enquiries, and replies to customers are sent from it.', 'EVENTS_MAILBOX'],
        ['careers', 'Careers (job applications)', 'Read for applications; replies are drafted in it.', 'CAREERS_MAILBOX'],
        ['invoices', 'Supplier invoices', 'Read for invoices to import.', 'INVOICE_MAILBOX'],
      ].map(([key, label, note, variable]) => ({ key, label, note, variable, address: inboxes[key]?.address ?? null })),
    };
  };

  router.get('/admin/email-settings', requireAdmin, (req, res) => res.json(view()));

  // { kinds: { default: { from, name, reply_to }, invites: {…}, … } }
  router.put('/admin/email-settings', requireAdmin, (req, res) => {
    const body = req.body?.kinds ?? {};
    const out = {};
    for (const [key, label] of EMAIL_KINDS) {
      const k = body[key] ?? {};
      const entry = {
        from: address(k.from, `${label}: send from`),
        name: str(k.name, `${label}: name`, { max: 100 }) || null,
        reply_to: address(k.reply_to, `${label}: replies go to`),
      };
      const kept = Object.fromEntries(Object.entries(entry).filter(([, v]) => v));
      if (Object.keys(kept).length) out[key] = kept;
    }
    saveSenders(db, out);
    if (req.body?.provider !== undefined) {
      if (!mailer?.available?.includes(req.body.provider)) throw badRequest(`${PROVIDERS[req.body.provider] ?? 'That email service'} isn’t set up on the server yet`);
      saveProvider(db, req.body.provider);
    }
    res.json(view());
  });

  // Sends a test of one kind to the person signed in, so they can check the address works in Brevo.
  router.post('/admin/email-settings/test', requireAdmin, async (req, res) => {
    if (!mailer) throw badRequest('Email isn’t set up yet: connect Microsoft 365 (MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET) or Brevo (BREVO_API_KEY and EMAIL_FROM) in Railway → Variables.');
    const kind = EMAIL_KINDS.some(([k]) => k === req.body?.kind) ? req.body.kind : 'default';
    if (!req.user.email) throw badRequest('Your account has no email address to send the test to');
    const s = senderFor(db, mailer, kind);
    const label = EMAIL_KINDS.find(([k]) => k === kind)[1];
    await mailer.send({
      kind, to: req.user.email, name: req.user.name,
      subject: `Atlas test email – ${label}`,
      text: `This is a test from Atlas (Setup → Email), sent through ${PROVIDERS[mailer.provider()]}.\n\n${label} emails come from ${s.name} <${s.from}>${s.reply_to ? `, and replies go to ${s.reply_to}` : ''}.\n`,
      html: `<p>This is a test from Atlas (Setup → Email), sent through ${PROVIDERS[mailer.provider()]}.</p><p><strong>${label}</strong> emails come from ${s.name} &lt;${s.from}&gt;${s.reply_to ? `, and replies go to ${s.reply_to}` : ''}.</p>`,
    });
    res.json({ ok: true, to: req.user.email, from: s.from, provider: PROVIDERS[mailer.provider()] });
  });
}
