import { addDays, api, esc, fmtDate, money, qs, showError, todayISO } from '../lib.js';

// Reporting → Bank: the bank accounts in Xero with their balances, and money in and out of each one – read only,
// straight from Xero. Only what's been entered or reconciled in Xero shows (not lines still waiting in its bank feed).

const signed = (n) => (n === null || n === undefined ? '–' : money(n));

export async function render({ el, query, state, stale, navigate }) {
  const data = await api('/bank');
  if (stale()) return;
  const head = '<div class="page-head"><h1>Bank</h1></div>';
  if (!data.bank_access) {
    const admin = state.isAdmin;
    el.innerHTML = `${head}<section class="card">
      <h2>See your bank accounts here</h2>
      <p>Atlas can show your business bank accounts from <strong>Xero</strong> – balances, and money in and out – read only. It can’t move money or change anything in Xero.</p>
      ${!data.configured || !data.connected
        ? `<p>${admin ? 'First connect Xero under <a href="#/admin/xero">Setup → Xero</a>, then allow bank access there.' : 'An admin needs to connect Xero and allow bank access first.'}</p>`
        : admin ? '<p><a class="btn btn-primary" href="/api/xero/connect?bank=1">Allow bank access in Xero</a></p><p class="muted small">You’ll sign in to Xero again and approve read-only access to bank transactions, payments and the bank summary.</p>'
          : '<p>An admin needs to allow bank access under Setup → Xero first.</p>'}
      ${data.error ? `<p class="notice">${esc(data.error)}</p>` : ''}
    </section>`;
    return;
  }
  if (data.error) {
    el.innerHTML = `${head}<p class="notice">${esc(data.error)}</p>`;
    return;
  }
  if (!data.accounts.length) {
    el.innerHTML = `${head}<div class="card empty">There are no bank accounts in Xero yet.</div>`;
    return;
  }

  const account = data.accounts.find((a) => a.id === query.account) ?? data.accounts[0];
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to ?? '') ? query.to : todayISO();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from ?? '') ? query.from : addDays(to, -30);
  const show = ['in', 'out', 'unreconciled'].includes(query.show) ? query.show : 'all';
  const go = (changes) => navigate(`bank${qs({ account: account.id, from, to, show: show === 'all' ? undefined : show, q: query.q || undefined, ...changes })}`);

  el.innerHTML = `${head}
    <div class="bank-accounts">${data.accounts.map((a) => `<a class="bank-account ${a.id === account.id ? 'is-on' : ''}" href="#/bank${qs({ account: a.id, from, to })}">
      <span class="bank-name">${esc(a.name)}${a.number_last4 ? ` <small class="muted">···${esc(a.number_last4)}</small>` : ''}</span>
      <strong class="bank-balance ${a.balance < 0 ? 'tone-bad' : ''}">${a.balance === null ? '–' : money(a.balance)}</strong>
      <small class="muted">${a.balance === null ? 'Balance not available' : 'Balance in Xero today'}${a.currency && a.currency !== 'GBP' ? ` · ${esc(a.currency)}` : ''}</small>
    </a>`).join('')}</div>
    <section class="card">
      <form class="filters" id="bank-filters">
        <label class="inline-field">From <input type="date" name="from" value="${esc(from)}" max="${esc(to)}"></label>
        <label class="inline-field">To <input type="date" name="to" value="${esc(to)}" max="${esc(todayISO())}"></label>
        <select name="show" aria-label="Show">
          <option value="all" ${show === 'all' ? 'selected' : ''}>Money in and out</option>
          <option value="in" ${show === 'in' ? 'selected' : ''}>Money in</option>
          <option value="out" ${show === 'out' ? 'selected' : ''}>Money out</option>
          <option value="unreconciled" ${show === 'unreconciled' ? 'selected' : ''}>Not reconciled yet</option>
        </select>
        <input type="search" name="q" value="${esc(query.q ?? '')}" placeholder="Search who, reference…" aria-label="Search">
        <button class="btn">Show</button>
      </form>
      <div id="bank-lines"><div class="loading">Getting ${esc(account.name)} from Xero…</div></div>
      <p class="muted small">Read only, from Xero. Shows what’s been entered or reconciled in Xero – lines still waiting in Xero’s bank feed appear once they’re reconciled there.</p>
    </section>`;

  const form = el.querySelector('#bank-filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go({ from: form.from.value || undefined, to: form.to.value || undefined, show: form.show.value === 'all' ? undefined : form.show.value, q: form.q.value.trim() || undefined });
  });
  form.show.addEventListener('change', () => form.requestSubmit());

  let r;
  try { r = await api(`/bank/${encodeURIComponent(account.id)}/lines${qs({ from, to })}`); } catch (err) {
    if (stale()) return;
    el.querySelector('#bank-lines').innerHTML = `<p class="notice">${esc(err.message)}</p>`;
    showError(err);
    return;
  }
  if (stale()) return;
  const q = (query.q ?? '').trim().toLowerCase();
  const lines = r.lines.filter((l) => (show === 'in' ? l.amount_in !== null : show === 'out' ? l.amount_out !== null : show === 'unreconciled' ? !l.reconciled : true)
    && (!q || [l.who, l.details, l.reference, l.kind].some((v) => String(v ?? '').toLowerCase().includes(q))));
  const total = (k) => lines.reduce((t, l) => t + (l[k] ?? 0), 0);

  el.querySelector('#bank-lines').innerHTML = `
    <div class="bank-totals">
      <div><small class="muted">Money in</small><strong class="tone-good">${money(total('amount_in'))}</strong></div>
      <div><small class="muted">Money out</small><strong>${money(total('amount_out'))}</strong></div>
      <div><small class="muted">Lines</small><strong>${lines.length}</strong></div>
      ${r.unreconciled ? `<div><small class="muted">Not reconciled</small><strong class="tone-warn">${r.unreconciled}</strong></div>` : ''}
      ${lines.length ? '<button type="button" class="btn btn-small" id="bank-csv">Download CSV</button>' : ''}
    </div>
    ${lines.length ? `<div class="table-wrap"><table class="bank-table">
      <thead><tr><th>Date</th><th>Who</th><th>Reference</th><th class="num">In</th><th class="num">Out</th><th></th></tr></thead>
      <tbody>${lines.map((l) => `<tr>
        <td>${fmtDate(l.date, { day: 'numeric', month: 'short' })}</td>
        <td><strong>${esc(l.who ?? l.kind)}</strong><small class="muted">${esc([l.kind, l.details].filter(Boolean).join(' · '))}</small></td>
        <td>${esc(l.reference ?? '')}</td>
        <td class="num tone-good">${l.amount_in === null ? '' : signed(l.amount_in)}</td>
        <td class="num">${l.amount_out === null ? '' : signed(l.amount_out)}</td>
        <td class="bank-flags">${l.reconciled ? '<span class="muted" title="Reconciled in Xero">✓</span>' : '<span class="badge badge-draft" title="Not reconciled in Xero yet">Not reconciled</span>'}
          ${l.url ? `<a class="btn btn-small btn-ghost" href="${esc(l.url)}" target="_blank" rel="noopener">Xero ↗</a>` : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : `<div class="empty">Nothing ${q || show !== 'all' ? 'matches' : 'in or out'} between ${fmtDate(from)} and ${fmtDate(to)}.</div>`}`;

  el.querySelector('#bank-csv')?.addEventListener('click', () => {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Date', 'Who', 'Type', 'Details', 'Reference', 'Money in', 'Money out', 'Reconciled'],
      ...lines.map((l) => [l.date, l.who, l.kind, l.details, l.reference, l.amount_in ?? '', l.amount_out ?? '', l.reconciled ? 'Yes' : 'No'])];
    const blob = new Blob([rows.map((row) => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${account.name.replace(/[^\w-]+/g, '_')}_${from}_${to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}
