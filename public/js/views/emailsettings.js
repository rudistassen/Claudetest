import { api, esc, showError, toast } from '../lib.js';

// Setup → Email: the address each kind of email Atlas sends comes from, the name people see, and where replies go.
// Blank boxes use the default; a blank default uses the address set on the server (EMAIL_FROM).

const MS = (data) => data.provider === 'microsoft';

const row = (k, data) => `
  <section class="card em-kind" data-kind="${k.key}">
    <div class="em-head"><div><h2>${esc(k.label)}</h2><p class="muted small">${esc(k.note)}</p></div>
      ${data.ready ? `<button type="button" class="btn btn-small" data-test="${k.key}">Send me a test</button>` : ''}</div>
    <div class="em-fields">
      <label class="field"><span>Send from</span><input type="email" name="from" value="${esc(k.saved.from)}" placeholder="${esc(k.key === 'default' ? data.server_from ?? 'e.g. hello@yourcafe.co.uk' : `Default – ${k.uses.from ?? 'not set'}`)}" autocomplete="off"></label>
      <label class="field"><span>Name people see</span><input name="name" value="${esc(k.saved.name)}" maxlength="100" ${MS(data) ? 'disabled title="Microsoft 365 uses the mailbox’s own name"' : ''} placeholder="${esc(MS(data) ? 'The mailbox’s own name' : k.key === 'default' ? data.server_name ?? 'Atlas' : `Default – ${k.uses.name}`)}" autocomplete="off"></label>
      <label class="field"><span>Replies go to</span><input type="email" name="reply_to" value="${esc(k.saved.reply_to)}" placeholder="${k.key === 'default' ? 'Optional – same as “Send from”' : 'Optional – default'}" autocomplete="off"></label>
    </div>
    <p class="small em-uses">Sends as ${MS(data) ? '' : `<strong>${esc(k.uses.name)}</strong> `}&lt;${esc(k.uses.from ?? 'not set')}&gt;${k.uses.reply_to ? ` · replies to ${esc(k.uses.reply_to)}` : ''}</p>
  </section>`;

export async function render({ el, stale, rerender }) {
  const data = await api('/admin/email-settings');
  if (stale()) return;
  el.innerHTML = `
    <div class="page-head"><h1>Email</h1></div>
    <p class="muted">Choose how Atlas sends email, the address each kind of email comes from, and where replies go. Leave a box blank to use the default.</p>
    <section class="card em-provider"><h2>Send using</h2>
      <div class="em-choices">${data.providers.map((p) => `<label class="em-choice ${p.ready ? '' : 'is-off'}">
        <input type="radio" name="provider" value="${p.key}" ${data.provider === p.key ? 'checked' : ''} ${p.ready ? '' : 'disabled'}>
        <span><strong>${esc(p.label)}</strong><small>${p.ready ? (p.key === 'microsoft' ? 'Your own mailboxes – copies go in their Sent Items' : 'A separate email service (free up to 300 a day)') : 'Not set up yet'}</small></span></label>`).join('')}</div>
      ${MS(data) ? `<p class="notice small">Each “Send from” address must be a <strong>mailbox or shared mailbox in your Microsoft 365</strong>. People see that mailbox’s own name. Use <strong>Send me a test</strong> to check each one.</p>`
        : data.provider === 'brevo' ? `<p class="notice small">Every “Send from” address must be a <strong>verified sender in Brevo</strong> (Senders, domains &amp; dedicated IPs → Senders) – or on a domain you’ve authenticated there – or Brevo will refuse to send. Use <strong>Send me a test</strong> to check.</p>`
        : '<p class="notice small">Email isn’t switched on yet – set up Microsoft 365 or Brevo below. You can still fill in the addresses now.</p>'}
      <details class="em-help" ${!data.providers.find((p) => p.key === 'microsoft').ready ? 'open' : ''}><summary>Setting up Microsoft 365</summary>
        <ol>
          <li>In <strong>Microsoft Entra</strong> (entra.microsoft.com) → <strong>App registrations</strong>, open the Atlas app (the one that reads the events, careers or invoice inbox) – or create one with <strong>New registration</strong>.</li>
          <li><strong>API permissions</strong> → <strong>Add a permission</strong> → <strong>Microsoft Graph</strong> → <strong>Application permissions</strong> → tick <strong>Mail.Send</strong> → <strong>Add</strong>, then <strong>Grant admin consent</strong>.</li>
          <li>If it’s a new app: <strong>Certificates &amp; secrets</strong> → <strong>New client secret</strong>, and copy its <em>Value</em>. Put it straight into Railway – never in an email or chat.</li>
          <li>In Railway → your app → <strong>Variables</strong>, make sure <code>MS_TENANT_ID</code> (Directory ID), <code>MS_CLIENT_ID</code> (Application ID) and <code>MS_CLIENT_SECRET</code> are set. Railway restarts Atlas.</li>
          <li>Come back here, choose <strong>Microsoft 365</strong>, fill in the “Send from” mailboxes and press <strong>Send me a test</strong>.</li>
        </ol>
        <p class="small"><strong>Recommended – limit which mailboxes Atlas can use.</strong> Mail.Send on its own lets the app send as <em>any</em> mailbox in your organisation. Ask whoever looks after your Microsoft 365 to run this in Exchange Online PowerShell, listing every mailbox Atlas sends from <em>and</em> reads (the inboxes below), with your app’s Application ID:</p>
        <pre class="em-code">New-DistributionGroup -Name "Atlas mailboxes" -Type Security -Members hello@yourdomain, people@yourdomain, events@yourdomain
New-ApplicationAccessPolicy -AppId &lt;Application ID&gt; -PolicyScopeGroupId "Atlas mailboxes" -AccessRight RestrictAccess -Description "Atlas can only use these mailboxes"
Test-ApplicationAccessPolicy -Identity hello@yourdomain -AppId &lt;Application ID&gt;</pre>
        <p class="small muted">Adding a mailbox later? Add it to the “Atlas mailboxes” group too, or Atlas won’t be able to use it. Changes can take up to an hour to apply.</p>
      </details>
      ${data.providers.find((p) => p.key === 'brevo').ready ? '' : '<p class="small muted">Prefer Brevo instead? See the steps on <a href="#/admin/email-reports">Setup → Email reports</a>.</p>'}
    </section>
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
      toast('Email settings saved');
      rerender();
    } catch (err) { showError(err); btn.disabled = false; }
  });
  // Switching service saves straight away (with the addresses on screen), as the page changes with it.
  el.querySelectorAll('[name=provider]').forEach((r) => r.addEventListener('change', async () => {
    try {
      await api('/admin/email-settings', { method: 'PUT', body: { kinds: values(), provider: r.value } });
      toast(`Sending email through ${data.providers.find((p) => p.key === r.value).label}`);
      rerender();
    } catch (err) { showError(err); rerender(); }
  }));
  el.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      // Save first, so the test uses what's on screen.
      await api('/admin/email-settings', { method: 'PUT', body: { kinds: values() } });
      const r = await api('/admin/email-settings/test', { method: 'POST', body: { kind: b.dataset.test } });
      toast(`Test sent from ${r.from} to ${r.to} through ${r.provider}`);
    } catch (err) { showError(err); }
    b.disabled = false;
  }));
}
