import { api, esc, showError, toast } from '../lib.js';

// Setup → Email: the address each kind of email Atlas sends comes from, the name people see, and where replies go.
// Blank boxes use the default; a blank default uses the address set on the server (EMAIL_FROM).

const row = (k, data) => `
  <section class="card em-kind" data-kind="${k.key}">
    <div class="em-head"><div><h2>${esc(k.label)}</h2><p class="muted small">${esc(k.note)}</p></div>
      ${data.ready ? `<button type="button" class="btn btn-small" data-test="${k.key}">Send me a test</button>` : ''}</div>
    <div class="em-fields">
      <label class="field"><span>Send from</span><input type="email" name="from" value="${esc(k.saved.from)}" placeholder="${esc(k.key === 'default' ? data.server_from ?? 'e.g. hello@yourcafe.co.uk' : `Default – ${k.uses.from ?? 'not set'}`)}" autocomplete="off"></label>
      <label class="field"><span>Name people see</span><input name="name" value="${esc(k.saved.name)}" maxlength="100" placeholder="${esc(k.key === 'default' ? data.server_name ?? 'Atlas' : `Default – ${k.uses.name}`)}" autocomplete="off"></label>
      <label class="field"><span>Replies go to</span><input type="email" name="reply_to" value="${esc(k.saved.reply_to)}" placeholder="${k.key === 'default' ? 'Optional – same as “Send from”' : 'Optional – default'}" autocomplete="off"></label>
    </div>
    <p class="small em-uses">Sends as <strong>${esc(k.uses.name)}</strong> &lt;${esc(k.uses.from ?? 'not set')}&gt;${k.uses.reply_to ? ` · replies to ${esc(k.uses.reply_to)}` : ''}</p>
  </section>`;

export async function render({ el, stale, rerender }) {
  const data = await api('/admin/email-settings');
  if (stale()) return;
  el.innerHTML = `
    <div class="page-head"><h1>Email</h1></div>
    <p class="muted">Choose the address each kind of email from Atlas comes from, the name people see, and where replies go. Leave a box blank to use the default.</p>
    ${data.ready ? `<p class="notice small">Every “Send from” address must be a <strong>verified sender in Brevo</strong> (Senders, domains &amp; dedicated IPs → Senders) – or on a domain you’ve authenticated there – or Brevo will refuse to send. Use <strong>Send me a test</strong> to check.</p>`
      : `<p class="notice small">Email isn’t switched on yet. Add <code>BREVO_API_KEY</code> and <code>EMAIL_FROM</code> to the app’s Variables in Railway (see Setup → Email reports for the steps). You can still fill these in now.</p>`}
    <form id="em-form">
      ${data.kinds.map((k) => row(k, data)).join('')}
      <div class="actions em-save"><button class="btn btn-primary" type="submit">Save</button></div>
    </form>
    <section class="card em-inboxes"><h2>Inboxes Atlas reads</h2>
      <p class="muted small">These are Microsoft 365 mailboxes connected on the server. To change one, change its setting in Railway → Variables.</p>
      <table class="table"><tbody>${data.inboxes.map((b) => `<tr><th>${esc(b.label)}<small class="muted">${esc(b.note)}</small></th>
        <td>${b.address ? `<strong>${esc(b.address)}</strong>` : '<span class="muted">Not connected</span>'}</td><td class="muted small"><code>${b.variable}</code></td></tr>`).join('')}</tbody></table>
    </section>`;

  const form = el.querySelector('#em-form');
  const values = () => Object.fromEntries([...form.querySelectorAll('[data-kind]')].map((s) => [s.dataset.kind, {
    from: s.querySelector('[name=from]').value.trim(), name: s.querySelector('[name=name]').value.trim(), reply_to: s.querySelector('[name=reply_to]').value.trim(),
  }]));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api('/admin/email-settings', { method: 'PUT', body: { kinds: values() } });
      toast('Email addresses saved');
      rerender();
    } catch (err) { showError(err); btn.disabled = false; }
  });
  el.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      // Save first, so the test uses what's on screen.
      await api('/admin/email-settings', { method: 'PUT', body: { kinds: values() } });
      const r = await api('/admin/email-settings/test', { method: 'POST', body: { kind: b.dataset.test } });
      toast(`Test sent from ${r.from} to ${r.to}`);
    } catch (err) { showError(err); }
    b.disabled = false;
  }));
}
