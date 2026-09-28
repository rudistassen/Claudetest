// Sending email through Brevo (brevo.com), a free email service with a web API. Hosting platforms such as
// Railway block ordinary email (SMTP) on their cheaper plans; a web API works everywhere.
//
// Set in the environment:
//   BREVO_API_KEY   the API key from Brevo (SMTP & API → API keys)
//   EMAIL_FROM      the sender address, verified in Brevo (Senders, domains & dedicated IPs → Senders)
//   EMAIL_FROM_NAME optional, defaults to "Cafe Ops"

import { cleanEnv } from './seed.js';
import { HttpError } from './util.js';

export function emailConfig(env = process.env) {
  const apiKey = cleanEnv(env.BREVO_API_KEY);
  const from = cleanEnv(env.EMAIL_FROM);
  if (!apiKey || !from) return null;
  return { apiKey, from, fromName: cleanEnv(env.EMAIL_FROM_NAME) || 'Cafe Ops' };
}

/** A mailer: { from, send({ to, name, subject, html, text }) }. */
export function brevoMailer(config, fetchImpl = fetch) {
  return {
    from: config.from,
    async send({ to, name, subject, html, text }) {
      const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: config.from, name: config.fromName },
          to: [{ email: to, ...(name ? { name } : {}) }],
          subject,
          htmlContent: html,
          textContent: text,
        }),
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).message ?? ''; } catch { /* not JSON */ }
        const hint = res.status === 401 ? ' – check BREVO_API_KEY' : /sender/i.test(detail) ? ' – check EMAIL_FROM is a verified sender in Brevo' : '';
        throw new HttpError(502, `The email service refused the email (${res.status}${detail ? `: ${detail}` : ''})${hint}`);
      }
    },
  };
}

/** Keeps emails instead of sending them (tests and the demo). */
export function memoryMailer() {
  const sent = [];
  return { from: 'reports@cafe-ops.demo', sent, async send(email) { sent.push(email); } };
}
