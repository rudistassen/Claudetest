// Reading a shared Microsoft 365 mailbox through Microsoft Graph, with an app registration. The invoice inbox is
// switched on by MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and INVOICE_MAILBOX (the shared inbox's address); the
// careers inbox by the same app and CAREERS_MAILBOX. Brewly only reads, except for drafting replies to job
// applicants in the careers inbox (which needs Mail.ReadWrite).
import { cleanEnv } from './seed.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export class MailboxError extends Error {}

export const MAILBOX_VARIABLES = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'INVOICE_MAILBOX'];
export const CAREERS_VARIABLES = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'CAREERS_MAILBOX'];
export const EVENTS_VARIABLES = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'EVENTS_MAILBOX'];

/**
 * Which of the inbox's settings Brewly can see (names only, never values), for the Invoices page while it isn't
 * connected: [{ name, status: 'ok' | 'missing' | 'empty' | 'misnamed', found? }]. "misnamed" is a variable that's
 * nearly right, e.g. lower case or with a space, and found is the name it was given.
 */
export function mailboxSetup(env = globalThis.process?.env ?? {}, variables = MAILBOX_VARIABLES) {
  const simplify = (k) => k.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return variables.map((name) => {
    if (env[name] !== undefined) return { name, status: cleanEnv(env[name]) ? 'ok' : 'empty' };
    const found = Object.keys(env).find((k) => simplify(k) === name);
    return found ? { name, status: 'misnamed', found } : { name, status: 'missing' };
  });
}

export function mailboxConfig(env = process.env) {
  const tenant = cleanEnv(env.MS_TENANT_ID);
  const clientId = cleanEnv(env.MS_CLIENT_ID);
  const secret = cleanEnv(env.MS_CLIENT_SECRET);
  const address = cleanEnv(env.INVOICE_MAILBOX);
  if (!tenant || !clientId || !secret || !address) return null;
  return { tenant, clientId, secret, address, minutes: Math.max(2, Number(cleanEnv(env.INVOICE_INBOX_MINUTES)) || 10) };
}

/** The careers inbox: the same Microsoft app as the invoice inbox, and CAREERS_MAILBOX. */
export function careersMailboxConfig(env = process.env) {
  const tenant = cleanEnv(env.MS_TENANT_ID);
  const clientId = cleanEnv(env.MS_CLIENT_ID);
  const secret = cleanEnv(env.MS_CLIENT_SECRET);
  const address = cleanEnv(env.CAREERS_MAILBOX);
  if (!tenant || !clientId || !secret || !address) return null;
  return { tenant, clientId, secret, address, minutes: Math.max(2, Number(cleanEnv(env.CAREERS_INBOX_MINUTES)) || 10) };
}

/** The events inbox: the same Microsoft app, and EVENTS_MAILBOX. Replies are sent from it (Mail.Send). */
export function eventsMailboxConfig(env = process.env) {
  const tenant = cleanEnv(env.MS_TENANT_ID);
  const clientId = cleanEnv(env.MS_CLIENT_ID);
  const secret = cleanEnv(env.MS_CLIENT_SECRET);
  const address = cleanEnv(env.EVENTS_MAILBOX);
  if (!tenant || !clientId || !secret || !address) return null;
  return { tenant, clientId, secret, address, minutes: Math.max(2, Number(cleanEnv(env.EVENTS_INBOX_MINUTES)) || 5) };
}

/**
 * The mailbox: listNew(sinceISO) → messages received since then that have attachments, oldest first;
 * attachments(id) → the message's file attachments (base64 data); body(id) → the email's text;
 * replyDraft(id, text) → a reply saved in the mailbox's Drafts, not sent ({ id, webLink });
 * reply(id, text) → sends a reply to that email, in its thread; send({ to, subject, text }) → sends a new email.
 * (Sending needs the app's Mail.Send permission.)
 * withAttachmentsOnly: only list emails with something attached (the invoice inbox); label names it in errors.
 */
export function graphMailbox({ tenant, clientId, secret, address }, { fetchFn = fetch, withAttachmentsOnly = true, label = 'invoice mailbox', variable = 'INVOICE_MAILBOX' } = {}) {
  let token = null;
  let expires = 0;
  const getToken = async () => {
    if (token && Date.now() < expires - 60000) return token;
    const res = await fetchFn(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new MailboxError(`Microsoft sign-in failed (${body.error ?? res.status}). Check MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET – the client secret may have expired.`);
    }
    token = body.access_token;
    expires = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    return token;
  };
  const call = async (url, { method = 'GET', body: payload, headers = {}, writing = false } = {}) => {
    const res = await fetchFn(url, {
      method,
      headers: { Authorization: `Bearer ${await getToken()}`, ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    if ((res.status === 401 || res.status === 403) && writing === 'send') {
      throw new MailboxError(`Brewly can read the ${label} but isn’t allowed to send from it. In Microsoft Entra, give the app the Mail.Send application permission (with admin consent).`);
    }
    if ((res.status === 401 || res.status === 403) && writing) {
      throw new MailboxError(`Brewly can read the ${label} but isn’t allowed to save draft replies in it. In Microsoft Entra, give the app the Mail.ReadWrite application permission (with admin consent).`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new MailboxError(`Brewly isn’t allowed to read the ${label}. In Microsoft Entra, give the app the Mail.Read application permission with admin consent, and make sure any mailbox access policy includes it.`);
    }
    if (res.status === 404) throw new MailboxError(`The mailbox ${address} wasn’t found. Check ${variable} is the shared inbox’s email address.`);
    throw new MailboxError(`Microsoft 365 returned an error (${res.status}): ${body.error?.message ?? 'unknown'}`);
  };
  const get = (url) => call(url);
  const user = `${GRAPH}/users/${encodeURIComponent(address)}`;
  return {
    address,
    async listNew(since) {
      const filter = `receivedDateTime ge ${new Date(since).toISOString().replace(/\.\d+Z$/, 'Z')}${withAttachmentsOnly ? ' and hasAttachments eq true' : ''}`;
      let url = `${user}/mailFolders/inbox/messages?${new URLSearchParams({
        $filter: filter, $orderby: 'receivedDateTime asc', $top: '50',
        $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,hasAttachments,conversationId',
      })}`;
      const out = [];
      for (let page = 0; url && page < 5; page++) {
        const body = await get(url);
        for (const m of body.value ?? []) {
          out.push({
            id: m.id,
            subject: m.subject ?? '',
            from: m.from?.emailAddress?.address ?? null,
            fromName: m.from?.emailAddress?.name ?? null,
            to: [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].map((r) => r.emailAddress?.address).filter(Boolean),
            receivedAt: m.receivedDateTime,
            preview: m.bodyPreview ?? '',
            hasAttachments: m.hasAttachments !== false,
            conversationId: m.conversationId ?? null,
          });
        }
        url = body['@odata.nextLink'] ?? null;
      }
      return out;
    },
    async attachments(messageId) {
      const body = await get(`${user}/messages/${encodeURIComponent(messageId)}/attachments`);
      return (body.value ?? [])
        .filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment' && a.contentBytes)
        .map((a) => ({ name: a.name ?? 'attachment', contentType: a.contentType ?? '', size: a.size ?? 0, isInline: !!a.isInline, data: a.contentBytes }));
    },
    async body(messageId) {
      const m = await call(`${user}/messages/${encodeURIComponent(messageId)}?$select=body`, { headers: { Prefer: 'outlook.body-content-type="text"' } });
      return m.body?.content ?? '';
    },
    async replyDraft(messageId, text) {
      const d = await call(`${user}/messages/${encodeURIComponent(messageId)}/createReply`, { method: 'POST', body: { comment: text }, writing: true });
      return { id: d.id, webLink: d.webLink ?? null };
    },
    async reply(messageId, text) {
      await call(`${user}/messages/${encodeURIComponent(messageId)}/reply`, { method: 'POST', body: { comment: text }, writing: 'send' });
    },
    async send({ to, subject, text }) {
      await call(`${user}/sendMail`, { method: 'POST', writing: 'send', body: {
        message: { subject, body: { contentType: 'Text', content: text }, toRecipients: [{ emailAddress: { address: to } }] },
        saveToSentItems: true,
      } });
    },
  };
}

/** A pretend mailbox for the demo and tests. messages: [{ id, subject, from, fromName, to, receivedAt, preview, attachments }] */
export function memoryMailbox(messages = [], address = 'invoices@example.com') {
  return {
    address,
    messages,
    async listNew(since) {
      return messages.filter((m) => m.receivedAt >= since).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).map(({ attachments, ...m }) => m);
    },
    async attachments(id) { return messages.find((m) => m.id === id)?.attachments ?? []; },
    async body(id) { return messages.find((m) => m.id === id)?.body ?? messages.find((m) => m.id === id)?.preview ?? ''; },
    drafts: [],
    async replyDraft(id, text) {
      this.drafts.push({ id, text });
      return { id: `draft-${this.drafts.length}`, webLink: null };
    },
    sent: [],
    async reply(id, text) { this.sent.push({ reply_to: id, text }); },
    async send(email) { this.sent.push(email); },
  };
}
