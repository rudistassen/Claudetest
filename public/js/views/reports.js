import { api, confirmDialog, esc, field, input, openModal, select, showError, toast } from '../lib.js';

// Setup → Email reports: the dashboard emailed to chosen people at a set time on chosen days.

const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function daysText(days) {
  const key = days.join('');
  if (key === '0123456') return 'Every day';
  if (key === '01234') return 'Mon–Fri';
  if (key === '56') return 'Weekends';
  return days.map((d) => SHORT_DAYS[d]).join(', ');
}

const periodText = (p) => (p === 'yesterday' ? 'yesterday’s full day' : 'today so far');

function setupHelp(data) {
  if (data.demo) return '<p class="notice">Demo: emails aren’t really sent here. Use <strong>Preview</strong> to see exactly what people will get.</p>';
  if (data.ready) return `<p class="small muted">Emails are sent from <strong>${esc(data.sender)}</strong>.${data.app_url ? '' : ' Add <code>APP_URL</code> (your Brewly web address) to put an “Open Brewly” button in the email.'}</p>`;
  return `
    <section class="card email-setup">
      <h2>First, switch on email (one-off, about 10 minutes)</h2>
      <p>Brewly sends email through <strong>Brevo</strong>, a free email service (up to 300 emails a day).</p>
      <ol>
        <li>Go to <a href="https://www.brevo.com" target="_blank" rel="noopener">brevo.com</a> and sign up for a free account.</li>
        <li>In Brevo, open <strong>Senders, domains &amp; dedicated IPs → Senders</strong>, add the email address the reports should come from (e.g. your own) and click the link Brevo emails you to confirm it.</li>
        <li>Open <strong>SMTP &amp; API → API keys</strong>, click <strong>Generate a new API key</strong>, and copy it.</li>
        <li>In Railway, open your app → <strong>Variables</strong> and add:
          <ul>
            <li><code>BREVO_API_KEY</code> = the key you copied</li>
            <li><code>EMAIL_FROM</code> = the sender address from step 2</li>
          </ul>
          then click <strong>Deploy</strong> to apply them.</li>
      </ol>
      <p class="small muted">You can set up the reports below now; they start sending once email is switched on.</p>
    </section>`;
}

export async function renderEmailReports(ctx) {
  const { el, stale, rerender } = ctx;
  const data = await api('/reports/email');
  if (stale()) return;

  const card = (s) => `
    <section class="card report-card ${s.active ? '' : 'is-off'}">
      <header class="card-head">
        <h2>${esc(s.name)} ${s.active ? '' : '<span class="badge badge-draft">Off</span>'}</h2>
        <button class="btn btn-small" data-edit="${s.id}">Edit</button>
      </header>
      <p class="report-when"><strong>${daysText(s.days)} at ${s.send_time}</strong> · covers ${periodText(s.period)}</p>
      <p><span class="muted">To:</span> ${s.recipients.map((r) => esc(r.name)).join(', ') || '<span class="muted">nobody</span>'}</p>
      ${s.last_result ? `<p class="small muted">Last sent ${esc(s.last_result)}</p>` : ''}
      <div class="report-actions">
        <button class="btn btn-small" data-preview="${s.id}">Preview</button>
        <button class="btn btn-small" data-test="${s.id}">Send me a test</button>
        <button class="btn btn-small btn-ghost" data-send-all="${s.id}">Send to everyone now</button>
      </div>
    </section>`;

  el.innerHTML = `
    <div class="page-head">
      <h1>Email reports</h1>
      <div class="actions"><button class="btn btn-primary" id="add">+ New email report</button></div>
    </div>
    <p class="muted">Email the dashboard to chosen people at a set time. Each person gets the sites they can access in Brewly, and sales and labour figures only if their permissions let them see sales.</p>
    ${setupHelp(data)}
    ${data.schedules.length ? `<div class="report-cards">${data.schedules.map(card).join('')}</div>`
      : '<div class="empty">No email reports yet. Click <strong>+ New email report</strong> to set one up.</div>'}`;

  const form = (s) => {
    const picked = new Set((s.recipients ?? []).map((r) => r.id));
    const days = new Set(s.days ?? [0, 1, 2, 3, 4, 5, 6]);
    return `
      ${field('Name', input('name', s.name ?? 'Daily report', 'required maxlength="100"'), { hint: 'Shown in the email’s subject line' })}
      <div class="row">
        ${field('Send at', input('send_time', s.send_time ?? '07:00', 'type="time" required'), { hint: 'UK time' })}
        ${field('Covers', select('period', [['yesterday', 'Yesterday (the full day)'], ['today', 'Today so far (up to the send time)']], s.period ?? 'yesterday'))}
      </div>
      <div class="field"><label>Days</label>
        <div class="day-picks">${SHORT_DAYS.map((d, i) => `<label class="check-row"><input type="checkbox" name="day_pick" value="${i}" ${days.has(i) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div>
      </div>
      <div class="field"><label>Send to</label>
        <div class="pick-links"><button type="button" class="btn btn-small btn-ghost" data-pick="managers">Everyone who sees sales</button>
          <button type="button" class="btn btn-small btn-ghost" data-pick="none">Clear</button></div>
        <div class="people-picks">${data.people.map((p) => `<label class="check-row"><input type="checkbox" name="person_pick" value="${p.id}" data-sales="${p.sees_sales ? 1 : 0}" ${picked.has(p.id) ? 'checked' : ''}>
          <span><strong>${esc(p.name)}</strong> <small class="muted">${esc(p.access_name ?? p.role)} · ${p.sites} site${p.sites === 1 ? '' : 's'}${p.sees_sales ? '' : ' · no sales figures'}</small></span></label>`).join('')}</div>
        <small class="muted">Only people with an email address in Brewly are listed.</small>
      </div>
      ${field('Switched on', `<input type="checkbox" name="active" ${s.active === 0 ? '' : 'checked'}>`, { className: 'field-inline' })}`;
  };
  const values = (v, f) => ({
    ...v,
    days: [...f.querySelectorAll('[name=day_pick]:checked')].map((c) => Number(c.value)),
    recipient_ids: [...f.querySelectorAll('[name=person_pick]:checked')].map((c) => Number(c.value)),
  });
  const wirePicks = () => {
    document.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('[name=person_pick]').forEach((c) => { c.checked = b.dataset.pick === 'managers' && c.dataset.sales === '1'; });
    }));
  };
  const firstSend = (s) => (s.send_time <= data.now ? 'tomorrow' : 'today');

  el.querySelector('#add').addEventListener('click', () => {
    openModal({
      title: 'New email report',
      wide: true,
      body: form({}),
      submitLabel: 'Save',
      onSubmit: async (v, f) => {
        const s = await api('/reports/email', { method: 'POST', body: values(v, f) });
        toast(`Saved – the first one goes ${firstSend(s)} at ${s.send_time}`);
        rerender();
      },
    });
    wirePicks();
  });

  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const s = data.schedules.find((x) => x.id === Number(b.dataset.edit));
    openModal({
      title: `Edit “${s.name}”`,
      wide: true,
      body: form(s),
      danger: 'Delete',
      onDanger: async () => {
        await api(`/reports/email/${s.id}`, { method: 'DELETE' });
        toast('Email report deleted');
        rerender();
      },
      onSubmit: async (v, f) => {
        await api(`/reports/email/${s.id}`, { method: 'PUT', body: values(v, f) });
        toast('Saved');
        rerender();
      },
    });
    wirePicks();
  }));

  el.querySelectorAll('[data-preview]').forEach((b) => b.addEventListener('click', async () => {
    const s = data.schedules.find((x) => x.id === Number(b.dataset.preview));
    const show = async (userId) => {
      try {
        const p = await api(`/reports/email/${s.id}/preview${userId ? `?user_id=${userId}` : ''}`);
        const frame = document.querySelector('#preview-frame');
        if (!frame) return;
        document.querySelector('#preview-subject').textContent = p.subject;
        frame.srcdoc = p.html;
      } catch (err) { showError(err); }
    };
    openModal({
      title: `Preview: ${s.name}`,
      wide: true,
      body: `
        ${s.recipients.length ? field('As received by', `<select id="preview-person">${s.recipients.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>`) : ''}
        <p class="small"><span class="muted">Subject:</span> <strong id="preview-subject">…</strong></p>
        <iframe id="preview-frame" class="email-preview" title="Email preview" sandbox=""></iframe>`,
    });
    document.querySelector('#preview-person')?.addEventListener('change', (e) => show(e.target.value));
    show(s.recipients[0]?.id);
  }));

  const send = async (id, to, button) => {
    button.disabled = true;
    try {
      const r = await api(`/reports/email/${id}/send`, { method: 'POST', body: { to } });
      const who = to === 'all' ? `${r.sent} ${r.sent === 1 ? 'person' : 'people'}` : 'you';
      toast(data.demo ? `Demo: would have been sent to ${who} – use Preview to see it` : `Sent to ${who}${r.failed.length ? ` (failed for ${r.failed.map((f) => f.name).join(', ')})` : ''}`);
      if (to === 'all') rerender();
    } catch (err) {
      showError(err);
    } finally {
      button.disabled = false;
    }
  };
  el.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => send(b.dataset.test, 'me', b)));
  el.querySelectorAll('[data-send-all]').forEach((b) => b.addEventListener('click', async () => {
    const s = data.schedules.find((x) => x.id === Number(b.dataset.sendAll));
    if (await confirmDialog(`Send “${s.name}” to ${s.recipients.length} ${s.recipients.length === 1 ? 'person' : 'people'} now? It still goes at its usual time as well.`, { confirmLabel: 'Send now', title: 'Send now' })) send(s.id, 'all', b);
  }));
}
