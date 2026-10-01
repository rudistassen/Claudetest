// Reading a shared Microsoft 365 mailbox through Microsoft Graph, with an app registration (read-only).
// Switched on by MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and INVOICE_MAILBOX (the shared inbox's address).
import { cleanEnv } from './seed.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export class MailboxError extends Error {}

export const MAILBOX_VARIABLES = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'INVOICE_MAILBOX'];

/**
 * Which of the inbox's settings Brewly can see (names only, never values), for the Invoices page while it isn't
 * connected: [{ name, status: 'ok' | 'missing' | 'empty' | 'misnamed', found? }]. "misnamed" is a variable that's
 * nearly right, e.g. lower case or with a space, and found is the name it was given.
 */
export function mailboxSetup(env = globalThis.process?.env ?? {}) {
  const simplify = (k) => k.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return MAILBOX_VARIABLES.map((name) => {
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

/**
 * The mailbox: listNew(sinceISO) → messages received since then that have attachments, oldest first;
 * attachments(id) → the message's file attachments (base64 data).
 */
export function graphMailbox({ tenant, clientId, secret, address }, { fetchFn = fetch } = {}) {
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
  const get = async (url) => {
    const res = await fetchFn(url, { headers: { Authorization: `Bearer ${await getToken()}` } });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    if (res.status === 401 || res.status === 403) {
      throw new MailboxError('Brewly isn’t allowed to read the invoice mailbox. In Microsoft Entra, give the app the Mail.Read application permission with admin consent, and make sure any mailbox access policy includes it.');
    }
    if (res.status === 404) throw new MailboxError(`The mailbox ${address} wasn’t found. Check INVOICE_MAILBOX is the shared inbox’s email address.`);
    throw new MailboxError(`Microsoft 365 returned an error (${res.status}): ${body.error?.message ?? 'unknown'}`);
  };
  const user = `${GRAPH}/users/${encodeURIComponent(address)}`;
  return {
    address,
    async listNew(since) {
      const filter = `receivedDateTime ge ${new Date(since).toISOString().replace(/\.\d+Z$/, 'Z')} and hasAttachments eq true`;
      let url = `${user}/mailFolders/inbox/messages?${new URLSearchParams({
        $filter: filter, $orderby: 'receivedDateTime asc', $top: '50',
        $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview',
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
  };
}
