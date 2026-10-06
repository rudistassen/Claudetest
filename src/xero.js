// Xero: sends confirmed supplier invoices to Xero as draft bills (with the supplier, lines, VAT, the site's
// tracking option and the original file attached). Connecting is done once by an admin through Xero's sign-in
// (OAuth 2.0, a "Web app" made at developer.xero.com); Brewly keeps the tokens fresh. Set XERO_CLIENT_ID and
// XERO_CLIENT_SECRET (and XERO_REDIRECT_URI if APP_URL isn't set).
import { addDays, HttpError, round2 } from './util.js';
import { vatCodeForRate } from './vat-codes.js';
import { appUrl } from './reports.js';

const IDENTITY = 'https://identity.xero.com';
const LOGIN = 'https://login.xero.com/identity/connect/authorize';
const API = 'https://api.xero.com';
// Bills, suppliers, account codes / tracking categories, and attaching the invoice file. offline_access keeps the
// connection going without signing in again. (XERO_SCOPES overrides this if Xero asks for different ones.)
export const DEFAULT_SCOPES = 'offline_access accounting.invoices accounting.contacts accounting.settings accounting.attachments';

/** Xero settings from the environment, or null when Xero isn't set up. */
export function xeroConfig(env = process.env) {
  if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET) return null;
  return {
    clientId: env.XERO_CLIENT_ID.trim(),
    clientSecret: env.XERO_CLIENT_SECRET.trim(),
    redirectUri: env.XERO_REDIRECT_URI?.trim() || (appUrl(env) ? `${appUrl(env)}/api/xero/callback` : null),
    scopes: env.XERO_SCOPES?.trim() || DEFAULT_SCOPES,
  };
}

// UK VAT rates on supplier bills → Xero's tax types.
const message = (data, fallback) => {
  const v = data?.Elements?.flatMap((e) => [...(e.ValidationErrors ?? []), ...(e.LineItems ?? []).flatMap((l) => l.ValidationErrors ?? [])]).map((e) => e.Message).filter(Boolean);
  return (v?.length ? [...new Set(v)].join('; ') : null) ?? data?.Detail ?? data?.Message ?? data?.error_description ?? data?.error ?? fallback;
};

export class Xero {
  constructor(db, config, fetchImpl = fetch) {
    this.db = db;
    this.config = config;
    this.fetch = fetchImpl;
  }

  connection() { return this.db.prepare('SELECT * FROM xero_connection WHERE id = 1').get() ?? null; }

  authorizeUrl(state, redirectUri) {
    return `${LOGIN}?${new URLSearchParams({ response_type: 'code', client_id: this.config.clientId, redirect_uri: redirectUri, scope: this.config.scopes, state })}`;
  }

  async token(params) {
    const res = await this.fetch(`${IDENTITY}/connect/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    }).catch((err) => { throw new HttpError(502, `Could not reach Xero: ${err.message}`); });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new HttpError(502, `Xero sign-in: ${message(data, `HTTP ${res.status}`)}`);
      err.code = data.error;
      throw err;
    }
    return data;
  }

  /** Finishes connecting: swaps the code from Xero's sign-in for tokens and saves the organisation. */
  async connect(code, redirectUri, userId) {
    const t = await this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    const res = await this.fetch(`${API}/connections`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' } });
    const tenants = (await res.json().catch(() => [])) ?? [];
    const org = Array.isArray(tenants) ? tenants.find((x) => x.tenantType === 'ORGANISATION') ?? tenants[0] : null;
    if (!org) throw new HttpError(502, 'Xero didn’t share an organisation – try connecting again and tick your organisation');
    this.db.prepare(`INSERT INTO xero_connection (id, tenant_id, tenant_name, access_token, refresh_token, expires_at, connected_by, connected_at, last_error)
      VALUES (1, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
      ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, tenant_name = excluded.tenant_name, access_token = excluded.access_token,
        refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, connected_by = excluded.connected_by, connected_at = excluded.connected_at, last_error = NULL`)
      .run(org.tenantId, org.tenantName ?? 'Xero', t.access_token, t.refresh_token, Date.now() + (t.expires_in ?? 1800) * 1000, userId);
    return { tenant_name: org.tenantName };
  }

  disconnect() {
    const c = this.connection();
    this.db.prepare('UPDATE xero_connection SET access_token = NULL, refresh_token = NULL, tenant_id = NULL WHERE id = 1').run();
    // Tell Xero too, so the connection disappears from its list of connected apps.
    if (c?.refresh_token) {
      this.fetch(`${IDENTITY}/connect/revocation`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: c.refresh_token }).toString(),
      }).catch(() => {});
    }
  }

  connected() { return !!this.connection()?.refresh_token; }

  /** A current access token, refreshed when it's about to run out (Xero's last 30 minutes; refresh tokens 60 days). */
  async accessToken() {
    const c = this.connection();
    if (!c?.refresh_token) throw new HttpError(400, 'Xero isn’t connected – an admin can connect it under Setup → Xero');
    if (c.access_token && c.expires_at > Date.now() + 60000) return c;
    // One refresh at a time: Xero gives a new refresh token each time, so two at once would trip each other up.
    this.refreshing ??= this.refresh(c).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async refresh(c) {
    try {
      const t = await this.token({ grant_type: 'refresh_token', refresh_token: c.refresh_token });
      this.db.prepare('UPDATE xero_connection SET access_token = ?, refresh_token = ?, expires_at = ?, last_error = NULL WHERE id = 1')
        .run(t.access_token, t.refresh_token ?? c.refresh_token, Date.now() + (t.expires_in ?? 1800) * 1000);
      return this.connection();
    } catch (err) {
      if (err.code === 'invalid_grant') {
        this.db.prepare(`UPDATE xero_connection SET access_token = NULL, refresh_token = NULL, last_error = 'The connection to Xero has expired – reconnect it under Setup → Xero' WHERE id = 1`).run();
        throw new HttpError(400, 'The connection to Xero has expired – an admin can reconnect it under Setup → Xero');
      }
      throw err;
    }
  }

  /** Calls Xero's Accounting API. body: JSON, or { raw: Buffer, type } for a file. */
  async api(method, path, body) {
    const c = await this.accessToken();
    const raw = body?.raw;
    const res = await this.fetch(`${API}/api.xro/2.0${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${c.access_token}`,
        'xero-tenant-id': c.tenant_id,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': raw ? body.type : 'application/json' } : {}),
      },
      body: raw ? body.raw : body ? JSON.stringify(body) : undefined,
    }).catch((err) => { throw new HttpError(502, `Could not reach Xero: ${err.message}`); });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) throw new HttpError(502, 'Xero is busy – try again in a minute');
    if (!res.ok) throw new HttpError(502, `Xero: ${message(data, `HTTP ${res.status}`)}`);
    return data;
  }

  /** What the settings page offers: expense account codes and tracking categories with their options. */
  async options() {
    const [accounts, tracking] = await Promise.all([this.api('GET', '/Accounts'), this.api('GET', '/TrackingCategories')]);
    return {
      accounts: (accounts.Accounts ?? []).filter((a) => a.Status === 'ACTIVE' && ['DIRECTCOSTS', 'EXPENSE', 'OVERHEADS'].includes(a.Type) && a.Code)
        .map((a) => ({ code: a.Code, name: a.Name })).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
      tracking: (tracking.TrackingCategories ?? []).filter((t) => t.Status !== 'ARCHIVED')
        .map((t) => ({ id: t.TrackingCategoryID, name: t.Name, options: (t.Options ?? []).filter((o) => o.Status !== 'ARCHIVED').map((o) => o.Name) })),
    };
  }

  /** Contacts in Xero whose name contains the search: [{ id, name, email }] (up to 25). */
  async findContacts(search) {
    const q = String(search ?? '').trim().slice(0, 100);
    const r = await this.api('GET', `/Contacts?summaryOnly=true&page=1${q ? `&searchTerm=${encodeURIComponent(q)}` : ''}`);
    return (r.Contacts ?? []).filter((c) => c.ContactStatus !== 'ARCHIVED').slice(0, 25)
      .map((c) => ({ id: c.ContactID, name: c.Name, email: c.EmailAddress ?? null }));
  }

  /** Xero's VAT rates that can go on bills: [{ code, name, rate }]. */
  async vatCodes() {
    const r = await this.api('GET', '/TaxRates');
    return (r.TaxRates ?? []).filter((t) => t.Status === 'ACTIVE' && t.CanApplyToExpenses !== false && t.TaxType)
      .map((t) => ({ code: t.TaxType, name: t.Name, rate: Number(t.EffectiveRate ?? t.DisplayTaxRate ?? 0) }));
  }

  /** The supplier's Xero contact: remembered, else found by name, else added. */
  async contactFor(supplier, name) {
    if (supplier?.xero_contact_id) return supplier.xero_contact_id;
    const safe = name.replace(/"/g, '\\"');
    const found = await this.api('GET', `/Contacts?where=${encodeURIComponent(`Name=="${safe}"`)}`);
    let id = found.Contacts?.[0]?.ContactID;
    if (!id) id = (await this.api('POST', '/Contacts', { Contacts: [{ Name: name, ...(supplier?.email ? { EmailAddress: supplier.email } : {}) }] })).Contacts?.[0]?.ContactID;
    if (!id) throw new HttpError(502, 'Xero didn’t add the supplier');
    if (supplier?.id) this.db.prepare('UPDATE suppliers SET xero_contact_id = ? WHERE id = ?').run(id, supplier.id);
    return id;
  }

  /** Sends a confirmed invoice to Xero as a draft bill. Returns { xero_invoice_id, url, warning? }. */
  async sendInvoice(invoiceId) {
    const db = this.db;
    const inv = db.prepare(`SELECT i.*, l.name AS location_name FROM invoices i JOIN locations l ON l.id = i.location_id WHERE i.id = ?`).get(invoiceId);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    if (inv.status !== 'confirmed') throw new HttpError(400, 'Confirm the invoice before sending it to Xero');
    if (inv.xero_invoice_id) throw new HttpError(400, 'This invoice is already in Xero');
    const c = this.connection();
    const supplier = inv.supplier_id ? db.prepare('SELECT * FROM suppliers WHERE id = ?').get(inv.supplier_id) : null;
    const name = supplier?.name ?? inv.supplier_name;
    if (!name) throw new HttpError(400, 'The invoice has no supplier');
    try {
      const contactId = await this.contactFor(supplier, name);
      const options = (() => { try { return JSON.parse(c.site_options ?? '{}'); } catch { return {}; } })();
      const option = options[inv.location_id] ?? inv.location_name;
      const tracking = c.tracking_category_name && option ? [{ Name: c.tracking_category_name, Option: option }] : undefined;
      // Each line goes to its product's category's account code, if it has one; otherwise the usual account.
      // …and with its product's VAT code; otherwise the VAT rate read off the invoice.
      const lines = db.prepare(`SELECT il.*, pc.xero_account_code AS category_account, p.vat_code FROM invoice_lines il
        LEFT JOIN products p ON p.id = il.product_id LEFT JOIN product_categories pc ON pc.name = p.category
        WHERE il.invoice_id = ? ORDER BY il.line_no`).all(inv.id);
      const item = (description, quantity, unit, taxType, account = null) => ({
        Description: description.slice(0, 4000),
        Quantity: quantity,
        UnitAmount: unit,
        ...(account || c.account_code ? { AccountCode: account || c.account_code } : {}),
        ...(taxType ? { TaxType: taxType } : {}),
        ...(tracking ? { Tracking: tracking } : {}),
      });
      const items = lines.length ? lines.map((l) => {
        const qty = l.quantity && l.quantity > 0 ? l.quantity : 1;
        const unit = l.unit_price ?? (l.line_total !== null ? round2(l.line_total / qty) : 0);
        return item(`${l.description}${l.sku ? ` (${l.sku})` : ''}`, qty, unit, l.vat_code || vatCodeForRate(l.vat_rate), l.category_account);
      }) : [item(`Invoice ${inv.invoice_number ?? ''}`.trim(), 1, inv.subtotal ?? inv.total ?? 0, null)];
      const bill = {
        Type: 'ACCPAY',
        Contact: { ContactID: contactId },
        ...(inv.invoice_date ? { Date: inv.invoice_date } : {}),
        // No due date on the invoice: the supplier's payment terms from the invoice date.
        ...(inv.due_date ? { DueDate: inv.due_date }
          : inv.invoice_date && supplier?.payment_terms_days != null ? { DueDate: addDays(inv.invoice_date, supplier.payment_terms_days) } : {}),
        ...(inv.invoice_number ? { InvoiceNumber: inv.invoice_number } : {}),
        Reference: `Brewly #${inv.id} · ${inv.location_name}`.slice(0, 255),
        Status: 'DRAFT',
        LineAmountTypes: 'Exclusive',
        LineItems: items,
      };
      const made = (await this.api('POST', '/Invoices', { Invoices: [bill] })).Invoices?.[0];
      if (!made?.InvoiceID) throw new HttpError(502, `Xero: ${message({ Elements: [made] }, 'the bill wasn’t created')}`);
      let warning;
      const file = db.prepare('SELECT file, file_name, file_type FROM invoices WHERE id = ?').get(inv.id);
      if (file?.file) {
        const fileName = (file.file_name || `invoice-${inv.id}`).replace(/[^\w.\- ]+/g, '_').slice(0, 100);
        try {
          await this.api('PUT', `/Invoices/${made.InvoiceID}/Attachments/${encodeURIComponent(fileName)}`, { raw: Buffer.from(file.file), type: file.file_type || 'application/octet-stream' });
        } catch (err) { warning = `The bill was added, but the file couldn’t be attached (${err.message})`; }
      }
      db.prepare(`UPDATE invoices SET xero_invoice_id = ?, xero_sent_at = datetime('now'), xero_error = ? WHERE id = ?`).run(made.InvoiceID, warning ?? null, inv.id);
      return { xero_invoice_id: made.InvoiceID, url: billUrl(made.InvoiceID), ...(warning ? { warning } : {}) };
    } catch (err) {
      db.prepare('UPDATE invoices SET xero_error = ? WHERE id = ?').run(err.message, inv.id);
      throw err;
    }
  }
}

/** The bill's page in Xero. */
export const billUrl = (id) => `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${encodeURIComponent(id)}`;
