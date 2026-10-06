import { api, esc, fmtDateTime, showError, toast } from '../lib.js';

// Setup → Xero: connect to Xero, then choose how bills are coded there (account code and the site tracking
// category), and whether confirmed invoices go across automatically.

export async function render(ctx) {
  const { el, state, stale, query, rerender } = ctx;
  const x = await api('/xero');
  if (stale()) return;
  if (query.connected) toast(`Connected to ${x.tenant_name ?? 'Xero'}`);
  if (query.error) setTimeout(() => showError(new Error(query.error)), 0);
  const sites = state.locations.filter((l) => l.active);

  const head = '<div class="page-head"><h1>Xero</h1></div>';
  if (!x.configured) {
    el.innerHTML = `${head}
      <section class="card">
        <h2>Connect Brewly to Xero (one-off, about 10 minutes)</h2>
        <p>Confirmed supplier invoices can go across to Xero as <strong>draft bills</strong> – with the supplier, every line, the VAT, the site (as your tracking category) and the original PDF attached.</p>
        <ol class="steps">
          <li>Go to <a href="https://developer.xero.com/app/manage" target="_blank" rel="noopener">developer.xero.com → My Apps</a> and click <strong>New app</strong>.</li>
          <li>Integration type: <strong>Web app</strong>. AI question: <strong>No</strong>. Security requirements: <strong>Yes</strong>.</li>
          <li>Company or application URL: <code>${esc(location.origin)}</code></li>
          <li>Redirect URI: <code>${esc(location.origin)}/api/xero/callback</code></li>
          <li>Create the app, open <strong>Configuration</strong>, copy the <strong>Client ID</strong> and click <strong>Generate a secret</strong>.</li>
          <li>In Railway, add <code>XERO_CLIENT_ID</code> and <code>XERO_CLIENT_SECRET</code> to your service’s Variables. Brewly restarts by itself.</li>
          <li>Come back here and click <strong>Connect to Xero</strong>.</li>
        </ol>
      </section>`;
    return;
  }

  if (!x.connected) {
    el.innerHTML = `${head}
      ${x.last_error ? `<p class="notice">${esc(x.last_error)}</p>` : ''}
      <section class="card">
        <h2>${x.tenant_name ? 'Reconnect to Xero' : 'Connect to Xero'}</h2>
        <p>You’ll sign in to Xero and choose your organisation. Brewly can then add <strong>draft bills</strong> for confirmed supplier invoices – nothing is approved or paid in Xero without you.</p>
        <p><a class="btn btn-primary" href="/api/xero/connect">Connect to Xero</a></p>
        <p class="muted small">Xero needs this redirect address in your app’s settings, exactly: <code>${esc(x.redirect_uri)}</code></p>
      </section>`;
    return;
  }

  el.innerHTML = `${head}
    <section class="card">
      <h2>Connected to ${esc(x.tenant_name)} ✓</h2>
      <p class="muted small">Since ${fmtDateTime(x.connected_at)} · ${x.sent} invoice${x.sent === 1 ? '' : 's'} sent so far</p>
      <button class="btn btn-small btn-ghost" id="xero-disconnect">Disconnect</button>
    </section>
    <section class="card" id="xero-settings"><div class="loading">Loading your Xero account codes…</div></section>`;

  el.querySelector('#xero-disconnect').addEventListener('click', async () => {
    try { await api('/xero/disconnect', { method: 'POST' }); toast('Disconnected from Xero'); rerender(); } catch (err) { showError(err); }
  });

  let opts;
  try { opts = await api('/xero/options'); } catch (err) {
    el.querySelector('#xero-settings').innerHTML = `<p class="notice">${esc(err.message)}</p>`;
    return;
  }
  if (stale()) return;
  const box = el.querySelector('#xero-settings');
  const cat = () => opts.tracking.find((t) => t.id === (box.querySelector('[name=tracking]')?.value ?? x.tracking_category_id)) ?? null;
  // Each site's option: what's saved, else one with the same name.
  const optionFor = (site, c) => x.site_options[site.id] ?? c?.options.find((o) => o.toLowerCase() === site.name.toLowerCase()) ?? '';
  const siteRows = () => {
    const c = cat();
    return c ? `<table class="xero-sites"><thead><tr><th>Brewly site</th><th>${esc(c.name)} in Xero</th></tr></thead><tbody>${sites.map((s) => `<tr>
      <td>${esc(s.name)}</td>
      <td><select data-site="${s.id}"><option value="">— None —</option>${c.options.map((o) => `<option ${o === optionFor(s, c) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted small">Bills won’t be tagged to a site.</p>';
  };
  box.innerHTML = `
    <h2>How bills are coded</h2>
    <label class="field"><span>Account code for supplier bills</span>
      <select name="account"><option value="">— Leave blank (choose in Xero) —</option>${opts.accounts.map((a) => `<option value="${esc(a.code)}" ${a.code === x.account_code ? 'selected' : ''}>${esc(a.code)} – ${esc(a.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Site tracking category</span>
      <select name="tracking"><option value="">— None —</option>${opts.tracking.map((t) => `<option value="${esc(t.id)}" ${t.id === x.tracking_category_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
    <div id="xero-site-rows">${siteRows()}</div>
    <label class="check"><input type="checkbox" name="auto" ${x.auto_send ? 'checked' : ''}> Send each invoice to Xero automatically when it’s confirmed</label>
    <p class="muted small">Bills arrive in Xero as <strong>drafts</strong>, with each line’s VAT (20%, 5% or zero-rated) and the original invoice attached. Otherwise use “Send to Xero” on a confirmed invoice.</p>
    <button class="btn btn-primary" id="xero-save">Save</button>`;
  box.querySelector('[name=tracking]').addEventListener('change', () => { box.querySelector('#xero-site-rows').innerHTML = siteRows(); });
  box.querySelector('#xero-save').addEventListener('click', async () => {
    const c = cat();
    const site_options = {};
    box.querySelectorAll('[data-site]').forEach((s) => { if (s.value) site_options[s.dataset.site] = s.value; });
    try {
      await api('/xero/settings', { method: 'PUT', body: {
        account_code: box.querySelector('[name=account]').value || null,
        tracking_category_id: c?.id ?? null,
        tracking_category_name: c?.name ?? null,
        site_options,
        auto_send: box.querySelector('[name=auto]').checked,
      } });
      toast('Xero settings saved');
    } catch (err) { showError(err); }
  });
}
