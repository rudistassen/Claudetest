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
        throw new HttpError(502, `The email service refused the email (${res.status}${detail ? `: ${detail}` : ''})${hint}`);
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
  ['reports', 'Email reports', 'The scheduled reports (Setup → Email reports).'],
  ['payments', 'Payment links', 'Square payment links emailed to customers (e.g. deposits).'],
];
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

/** Wraps a mailer so send({ kind, … }) uses the sender set up for that kind in Setup → Email. */
export function withSenders(db, mailer) {
  if (!mailer || mailer.senders) return mailer;
  return {
    ...mailer,
    senders: true,
    senderFor: (kind) => senderFor(db, mailer, kind),
    async send({ kind = 'default', ...email }) {
      const s = senderFor(db, mailer, kind);
      return mailer.send({ ...email, from: s.from, fromName: s.name, replyTo: s.reply_to ?? undefined });
    },
  };
}
