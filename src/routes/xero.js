// Setup → Xero: connecting to Xero, choosing the account code and site tracking for bills, and sending confirmed
// invoices to Xero as draft bills (see xero.js).
import { randomBytes } from 'node:crypto';
import { requireAdmin, requirePerm } from '../auth.js';
import { badRequest, bool, notFound, str } from '../util.js';
import { billUrl } from '../xero.js';
import { STANDARD_VAT_CODES } from '../vat-codes.js';

const STATE_MINUTES = 10;

export function registerXeroRoutes(router, db, xero) {
  // Sign-ins in progress: state → { user, redirect URI, until }.
  const pending = new Map();
  const needXero = () => { if (!xero) throw badRequest('Xero isn’t set up yet – add XERO_CLIENT_ID and XERO_CLIENT_SECRET in Railway first'); };

  router.get('/xero', requireAdmin, (req, res) => {
    const c = xero?.connection();
    let siteOptions = {};
    try { siteOptions = JSON.parse(c?.site_options ?? '{}'); } catch { /* none yet */ }
    res.json({
      configured: !!xero,
      redirect_uri: xero ? (xero.config.redirectUri ?? `${req.protocol}://${req.get('host')}/api/xero/callback`) : null,
      connected: !!xero?.connected(),
      tenant_name: c?.tenant_name ?? null,
      connected_at: c?.connected_at ?? null,
      last_error: c?.last_error ?? null,
      account_code: c?.account_code ?? null,
      tracking_category_id: c?.tracking_category_id ?? null,
      tracking_category_name: c?.tracking_category_name ?? null,
      site_options: siteOptions,
      auto_send: !!c?.auto_send,
      sent: db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE xero_invoice_id IS NOT NULL').get().n,
    });
  });

  // Account codes and tracking categories, from Xero.
  // (Also for whoever sets up product categories, to pick each one's account code.)
  router.get('/xero/options', requirePerm('setup.products'), async (_req, res) => {
    needXero();
    res.json(await xero.options());
  });

  // The VAT codes products can have: Xero's own when it's connected, else the standard UK ones.
  router.get('/vat-codes', async (_req, res) => {
    if (xero?.connected()) {
      try {
        const codes = await xero.vatCodes();
        if (codes.length) return res.json({ from_xero: true, codes });
      } catch { /* Xero unreachable: the standard list will do */ }
    }
    res.json({ from_xero: false, codes: STANDARD_VAT_CODES });
  });

  // Starts connecting: off to Xero's sign-in, which comes back to /api/xero/callback.
  router.get('/xero/connect', requireAdmin, (req, res) => {
    needXero();
    const redirectUri = xero.config.redirectUri ?? `${req.protocol}://${req.get('host')}/api/xero/callback`;
    const state = randomBytes(18).toString('base64url');
    for (const [k, v] of pending) if (v.until < Date.now()) pending.delete(k);
    pending.set(state, { userId: req.user.id, redirectUri, until: Date.now() + STATE_MINUTES * 60000 });
    res.redirect(xero.authorizeUrl(state, redirectUri));
  });

  router.get('/xero/callback', requireAdmin, async (req, res) => {
    const back = (q) => res.redirect(`/#/admin/xero?${new URLSearchParams(q)}`);
    const p = pending.get(String(req.query.state ?? ''));
    pending.delete(String(req.query.state ?? ''));
    if (req.query.error) return back({ error: req.query.error === 'access_denied' ? 'You cancelled connecting to Xero' : `Xero: ${req.query.error_description || req.query.error}` });
    if (!xero || !p || p.until < Date.now() || p.userId !== req.user.id) return back({ error: 'That sign-in had expired – try connecting again' });
    try {
      await xero.connect(String(req.query.code ?? ''), p.redirectUri, req.user.id);
      back({ connected: '1' });
    } catch (err) {
      back({ error: err.message });
    }
  });

  router.post('/xero/disconnect', requireAdmin, (_req, res) => {
    needXero();
    xero.disconnect();
    res.json({ ok: true });
  });

  // { account_code, tracking_category_id, tracking_category_name, site_options: { locationId: option }, auto_send }
  router.put('/xero/settings', requireAdmin, (req, res) => {
    needXero();
    if (!xero.connection()) throw badRequest('Connect to Xero first');
    const b = req.body ?? {};
    const options = {};
    for (const [k, v] of Object.entries(b.site_options ?? {})) {
      if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(Number(k))) continue;
      const o = str(v, 'option', { max: 100 });
      if (o) options[Number(k)] = o;
    }
    db.prepare(`UPDATE xero_connection SET account_code = ?, tracking_category_id = ?, tracking_category_name = ?, site_options = ?, auto_send = ? WHERE id = 1`)
      .run(str(b.account_code, 'account_code', { max: 20 }), str(b.tracking_category_id, 'tracking_category_id', { max: 64 }),
        str(b.tracking_category_name, 'tracking_category_name', { max: 100 }), JSON.stringify(options), bool(b.auto_send));
    res.json({ ok: true });
  });

  // Send one confirmed invoice to Xero as a draft bill.
  router.post('/invoices/:id/xero', requirePerm('orders.manage'), async (req, res) => {
    needXero();
    const inv = db.prepare('SELECT id, location_id FROM invoices WHERE id = ?').get(Number(req.params.id));
    if (!inv || !req.user.site_ids.includes(inv.location_id)) throw notFound('Invoice');
    res.json(await xero.sendInvoice(inv.id));
  });
}

/** For the invoice page: whether Xero is ready to take bills, and this invoice's link if it's there already. */
export function xeroInvoiceInfo(xero, inv) {
  return {
    xero_ready: !!xero?.connected(),
    xero_url: inv.xero_invoice_id ? billUrl(inv.xero_invoice_id) : null,
  };
}

/** After an invoice is confirmed: sends it to Xero in the background when "send automatically" is on. */
export function autoSendToXero(xero, invoiceId) {
  if (!xero?.connected() || !xero.connection()?.auto_send) return;
  xero.sendInvoice(invoiceId).catch((err) => console.error(`Xero: invoice ${invoiceId} not sent: ${err.message}`));
}
