// Sending email through Brevo (brevo.com), a free email service with a web API. Hosting platforms such as
// Railway block ordinary email (SMTP) on their cheaper plans; a web API works everywhere.
//
// Set in the environment:
//   BREVO_API_KEY   the API key from Brevo (SMTP & API → API keys)
//   EMAIL_FROM      the sender address, verified in Brevo (Senders, domains & dedicated IPs → Senders)
//   EMAIL_FROM_NAME optional, defaults to "Atlas"

import { cleanEnv } from './seed.js';
import { HttpError } from './util.js';

export function emailConfig(env = process.env) {
  const apiKey = cleanEnv(env.BREVO_API_KEY);
  const from = cleanEnv(env.EMAIL_FROM);
  if (!apiKey || !from) return null;
  return { apiKey, from, fromName: cleanEnv(env.EMAIL_FROM_NAME) || 'Atlas' };
}

/** A mailer: { from, send({ to, name, subject, html, text, from?, fromName?, replyTo? }) }. */
export function brevoMailer(config, fetchImpl = fetch) {
  return {
    from: config.from,
    fromName: config.fromName,
    async send({ to, name, subject, html, text, from, fromName, replyTo }) {
      const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: from || config.from, name: fromName || config.fromName },
          to: [{ email: to, ...(name ? { name } : {}) }],
          ...(replyTo ? { replyTo: { email: replyTo } } : {}),
          subject,
          htmlContent: html,
          textContent: text,
        }),
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).message ?? ''; } catch { /* not JSON */ }
        const hint = res.status === 401 ? ' – check BREVO_API_KEY' : /sender/i.test(detail) ? ` – check ${from || config.from} is a verified sender in Brevo (Setup → Email)` : '';
        throw Object.assign(new HttpError(502, `The email service refused the email (${res.status}${detail ? `: ${detail}` : ''})${hint}`), { senderProblem: !!hint });
      }
    },
  };
}

/** Keeps emails instead of sending them (tests and the demo). */
export function memoryMailer() {
  const sent = [];
  return { from: 'reports@brewly.demo', fromName: 'Atlas', sent, async send(email) { sent.push(email); } };
}

// Setup → Email: who each kind of email comes from. Anything left blank uses the default, and a blank default uses
// EMAIL_FROM / EMAIL_FROM_NAME from the server's settings. Every address must be a verified sender in Brevo.
export const EMAIL_KINDS = [
  ['default', 'Default', 'Anything without its own address below.'],
  ['invites', 'Invites and password resets', 'Invites to join Atlas and “Forgot password?” links.'],
  ['rota', 'Rota changes', 'When the rota is published, everyone whose shifts changed is emailed their shifts for that week.'],
  ['reports', 'Email reports', 'The scheduled reports (Setup → Email reports).'],
  ['payments', 'Payment links', 'Square payment links emailed to customers (e.g. deposits).'],
  ['orders', 'Supplier orders', 'Orders emailed to suppliers, and replies to them – always from the orders mailbox.'],
];
// Each kind of email has to be switched on in Setup → Email. Those Atlas sent before the switch existed start on;
// new ones start off.
const ON_AT_FIRST = { invites: true, reports: true, payments: true, orders: true, rota: false };
// Kinds sent from a mailbox of their own rather than the address chosen here.
export const OWN_MAILBOX = new Set(['orders']);
const ON_KEY = 'email_on';

/** Whether this kind of email is switched on in Setup → Email. */
export function emailOn(db, kind) {
  if (kind === 'default') return true;
  let saved = {};
  try { saved = JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get(ON_KEY)?.value ?? '{}'); } catch { /* use the defaults */ }
  return saved[kind] ?? ON_AT_FIRST[kind] ?? false;
}

export function saveEmailOn(db, map) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(ON_KEY, JSON.stringify(map));
}

/** The error when a kind of email is switched off. */
export const switchedOff = (kind) => {
  const label = EMAIL_KINDS.find(([k]) => k === kind)?.[1] ?? 'These';
  return Object.assign(new HttpError(400, `${label} emails are switched off – switch them on in Setup → Email`), { switchedOff: true });
};
const SETTINGS_KEY = 'email_senders';

/** { kind: { from, name, reply_to } } as saved (blank fields left out). */
export function savedSenders(db) {
  try { return JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY)?.value ?? '{}'); } catch { return {}; }
}

export function saveSenders(db, senders) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SETTINGS_KEY, JSON.stringify(senders));
}

/** Who an email of this kind comes from: { from, name, reply_to }. */
export function senderFor(db, mailer, kind = 'default') {
  const saved = savedSenders(db);
  const own = saved[kind] ?? {};
  const base = saved.default ?? {};
  return {
    from: own.from || base.from || mailer?.from || null,
    name: own.name || base.name || mailer?.fromName || 'Atlas',
    reply_to: own.reply_to || base.reply_to || null,
  };
}

// What sends the email: Brevo, or Microsoft 365 (your own mailboxes, through Microsoft Graph). Chosen in Setup → Email.
export const PROVIDERS = { brevo: 'Brevo', microsoft: 'Microsoft 365' };

/** The service picked in Setup → Email, if it's set up; otherwise the first one that is. */
export function chosenProvider(db, available) {
  const saved = db.prepare('SELECT value FROM settings WHERE key = ?').get('email_provider')?.value;
  return available.includes(saved) ? saved : available[0] ?? null;
}

export function saveProvider(db, provider) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('email_provider', provider);
}

/**
 * One mailer for the whole app: send({ kind, … }) uses the sender set up for that kind in Setup → Email, through the
 * service chosen there. mailers: a mailer (Brevo, or a pretend one) or { brevo, microsoft } (either can be null).
 * Null when no service is set up.
 */
export function withSenders(db, mailers) {
  if (!mailers || mailers.senders) return mailers;
  const services = typeof mailers.send === 'function' ? { brevo: mailers } : mailers;
  const available = Object.keys(PROVIDERS).filter((k) => services[k]);
  if (!available.length) return null;
  const base = services.brevo ?? services[available[0]];
  return {
    from: base.from ?? null,
    fromName: base.fromName ?? 'Atlas',
    sent: base.sent,
    senders: true,
    available,
    provider: () => chosenProvider(db, available),
    senderFor: (kind) => senderFor(db, base, kind),
    // force: send even if this kind is switched off (the test button in Setup → Email).
    async send({ kind = 'default', force = false, ...email }) {
      if (!force && !emailOn(db, kind)) throw switchedOff(kind);
      const s = senderFor(db, base, kind);
      const service = services[chosenProvider(db, available)];
      return service.send({ ...email, from: s.from, fromName: s.name, replyTo: s.reply_to ?? undefined });
    },
  };
}
