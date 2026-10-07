import { api, confirmDialog, esc, field, fmtDate, fmtDateTime, input, openModal, qs, select, showError, siteColour, siteFilter, siteScope, textarea, toast, todayISO } from '../lib.js';

// People: Recruitment (jobs and their candidates), Learning and development (training and who has done it),
// Performance (one-to-ones, probation reviews and appraisals) and Areas (where each person can work).

const STAGES = [['applied', 'Applied'], ['interview', 'Interview'], ['trial', 'Trial shift'], ['offer', 'Offered'], ['hired', 'Hired'], ['rejected', 'Not taken on']];
const STAGE = Object.fromEntries(STAGES);
const KINDS = [['one_to_one', 'One-to-one'], ['probation', 'Probation review'], ['appraisal', 'Appraisal']];
const KIND = Object.fromEntries(KINDS);
const day = (d) => fmtDate(d, { day: 'numeric', month: 'short', year: 'numeric' });
const stars = (n) => (n ? `<span class="pp-stars" title="${n} out of 5">${'★'.repeat(n)}<span>${'★'.repeat(5 - n)}</span></span>` : '<span class="muted">–</span>');
const siteTag = (name, id) => (name ? `<span class="site-dot" style="--site: ${siteColour(name, id)}"></span>${esc(name)}` : '');

// The site filter at the top of each page; picking a site reloads the page for it.
function filters(state, scope) {
  return state.multiSite ? `<form class="filters" id="pp-filters">${siteFilter(state, scope)}</form>` : '';
}
function wireFilters(el, page, navigate, extra = {}) {
  const form = el.querySelector('#pp-filters');
  form?.addEventListener('submit', (e) => { e.preventDefault(); navigate(`${page}${qs({ scope: form.scope?.value, ...extra })}`); });
}
const siteQuery = (state, scope) => qs({ location_id: scope === 'all' ? undefined : state.locationId });

// ---- Recruitment ----

const fileSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const received = (c) => (c.received_at ? fmtDateTime(c.received_at.replace('T', ' ').slice(0, 19)) : day(c.created_at.slice(0, 10)));

/** Moving someone on to an interview: which job it's for (if they haven't got one) and when, if it's booked. */
export function interviewDialog(c, jobs, done) {
  const open = jobs.filter((j) => j.status === 'open' || j.id === c.vacancy_id);
  openModal({
    title: `Invite ${c.name} to interview`,
    body: `${field('For the job', select('vacancy_id', [['', '— Not for a particular job —'], ...open.map((j) => [j.id, `${j.title}${j.location_name ? ` – ${j.location_name}` : ''}`])], c.vacancy_id ?? ''))}
      ${field('Interview on (optional)', input('next_step_on', c.next_step_on, 'type="date"'), { hint: 'Leave blank if it isn’t booked yet' })}
      ${c.email ? `<p class="muted small">Get in touch with them to arrange it – <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>${c.phone ? ` or ${esc(c.phone)}` : ''}.</p>` : ''}`,
    submitLabel: '✓ Move to interview',
    onSubmit: async (v) => {
      await api(`/candidates/${c.id}`, { method: 'PUT', body: { stage: 'interview', vacancy_id: v.vacancy_id || null, next_step_on: v.next_step_on } });
      toast(`${c.name} moved to interview – they’re under In progress on Recruitment`);
      done();
    },
  });
}

/** Turning someone down: the reply, from the template, to check and change, then a draft in the careers inbox. */
export async function declineDialog(candidateId, done) {
  let c;
  try { c = await api(`/candidates/${candidateId}`); } catch (err) { showError(err); return; }
  openModal({
    title: `Turn down ${c.name}?`,
    wide: true,
    body: c.email ? `<p class="muted small">They’ll be marked as not taken on. Check the reply below – you can change it for them.</p>
        ${field('To', `<input value="${esc(c.email)}" disabled>`)}
        ${field('Subject', input('subject', c.decline.subject, 'required maxlength="200"'))}
        ${field('Message', textarea('body', c.decline.body, 'rows="11" required maxlength="5000"'))}
        ${c.can_draft_reply ? '<label class="check-row"><input type="checkbox" name="draft" checked><span>Save it as a <strong>draft reply in the careers inbox</strong>, to check and send from Outlook</span></label>'
          : '<p class="muted small">Next you can copy the reply, or open it in your email to send.</p>'}`
      : `<p>There’s no email address for ${esc(c.name)}, so they’ll just be marked as not taken on.</p>
        <input type="hidden" name="subject" value="${esc(c.decline.subject)}"><input type="hidden" name="body" value="${esc(c.decline.body)}">`,
    submitLabel: '✕ Turn down',
    onSubmit: async (v) => {
      const r = await api(`/candidates/${c.id}/decline`, { method: 'POST', body: { subject: v.subject, body: v.body, draft: !!v.draft } });
      done();
      if (r.draft === 'created') {
        toast(`Turned down – the reply is waiting in Drafts in ${r.mailbox}`);
        return;
      }
      toast(`${c.name} turned down`);
      if (r.to) setTimeout(() => sendYourself(r), 0);
    },
  });
}

// When Atlas couldn't save the reply as a draft: the email to copy or open in their own email.
function sendYourself(r) {
  const mailto = `mailto:${encodeURIComponent(r.to)}?${new URLSearchParams({ subject: r.subject, body: r.body }).toString().replace(/\+/g, '%20')}`;
  const { form } = openModal({
    title: 'Send your reply',
    wide: true,
    body: `${r.draft === 'failed' ? `<p class="notice notice-warn">The draft couldn’t be saved in the careers inbox: ${esc(r.error)}</p>` : ''}
      <p><strong>To:</strong> ${esc(r.to)}<br><strong>Subject:</strong> ${esc(r.subject)}</p>
      <pre class="pp-email">${esc(r.body)}</pre>
      <p class="pp-send-actions"><a class="btn btn-primary" href="${esc(mailto)}">✉ Open in my email</a>
        <button type="button" class="btn" data-copy>Copy the message</button></p>`,
  });
  form.querySelector('[data-copy]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(r.body); toast('Copied'); } catch { toast('Couldn’t copy – select the text instead', 'error'); }
  });
}

// The careers inbox: set-up steps until it's connected, then when it was last checked and the decline wording.
function careersCard(inbox) {
  if (!inbox) return '';
  if (!inbox.configured) {
    const have = inbox.setup?.filter((v) => v.status === 'ok').map((v) => v.name) ?? [];
    return `<details class="card inbox-card"><summary><strong>✉ Careers inbox</strong> <span class="muted small">– have job applications added here automatically</span></summary>
      <p>Emails to your careers address (for example <em>careers@yourcompany.co.uk</em>) can be added here as candidates every few minutes – with their message and their CV on their profile.</p>
      <p>It uses the same Microsoft 365 app as the invoice inbox. In Railway, add:</p>
      <ul><li><code>CAREERS_MAILBOX</code> – the careers inbox’s email address${have.includes('CAREERS_MAILBOX') ? ' ✓' : ''}</li>
        ${['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET'].map((n) => `<li><code>${n}</code>${have.includes(n) ? ' ✓ already there' : ' – from the Microsoft app (see Invoices → Invoice inbox)'}</li>`).join('')}</ul>
      <p class="muted small">To have Atlas save turn-down replies as drafts in the careers inbox, give the Microsoft app the <strong>Mail.ReadWrite</strong> permission (not just Mail.Read).</p>
      <p><button type="button" class="btn btn-small" data-edit-template>Edit the turn-down email</button></p>
    </details>`;
  }
  return `<section class="card inbox-card">
    <div class="card-head"><h2>✉ Careers inbox</h2><button class="btn btn-small" id="careers-check">Check now</button></div>
    <p class="small">Applications emailed to <strong>${esc(inbox.mailbox)}</strong> are added above every few minutes.
      ${inbox.last_check ? `Last checked ${fmtDateTime(inbox.last_check.replace('T', ' ').slice(0, 19))}.` : 'Not checked yet.'}</p>
    ${inbox.last_error ? `<p class="notice notice-warn">${esc(inbox.last_error)}</p>` : ''}
    <p><button type="button" class="btn btn-small" data-edit-template>Edit the turn-down email</button></p>
  </section>`;
}

function templateDialog(inbox, done) {
  openModal({
    title: 'The turn-down email',
    wide: true,
    body: `<p class="muted small">Filled in for each person when you turn them down – you can still change it each time. These are replaced for you:
        <code>{first_name}</code>, <code>{name}</code>, <code>{job}</code>, <code>{job_as}</code> (“ as a Barista”) and <code>{job_for}</code> (“ for Barista”).</p>
      ${field('Subject', input('subject', inbox.template.subject, 'required maxlength="200"'), { hint: 'Used when you send it yourself – a draft in the careers inbox replies to their email' })}
      ${field('Message', textarea('body', inbox.template.body, 'rows="13" required maxlength="5000"'))}`,
    onSubmit: async (v) => {
      await api('/careers-inbox/template', { method: 'PUT', body: v });
      toast('Saved');
      done();
    },
    danger: 'Use the standard wording',
    onDanger: async () => {
      await api('/careers-inbox/template', { method: 'PUT', body: inbox.default_template });
      toast('Back to the standard wording');
      done();
    },
  });
}

// A star to put someone on (or take them off) the To review list.
// On the list itself it reads "Done", which takes them off.
const reviewButton = (c, onList = false) => `<button type="button" class="btn btn-small ${c.to_review_at ? 'pp-starred' : ''}" data-review="${c.id}" data-on="${c.to_review_at ? '' : '1'}"
  title="${c.to_review_at ? 'Take off the To review list' : 'Put on the To review list'}">${!c.to_review_at ? '☆ To review' : onList ? '✓ Done reviewing' : '★ To review'}</button>`;

const applicationCard = (c, onList = false) => `<li class="pp-app">
  <div class="pp-app-main">
    <a href="#/people/recruitment/candidates/${c.id}" class="pp-app-name"><strong>${esc(c.name)}</strong></a>
    <small class="muted">${esc(received(c))}${c.job_title ? ` · for <strong>${esc(c.job_title)}</strong>` : ''}${c.site_name ? ` · ${siteTag(c.site_name, c.site_id)}` : ''}${c.files ? ` · 📎 ${c.files} file${c.files === 1 ? '' : 's'}` : ' · no CV'}</small>
    ${c.subject ? `<span class="pp-app-subject">${esc(c.subject)}</span>` : ''}
    ${c.preview ? `<span class="pp-app-preview">${esc(c.preview.replace(/\s+/g, ' '))}</span>` : ''}
  </div>
  <div class="pp-app-actions">
    <a class="btn btn-small btn-ghost" href="#/people/recruitment/candidates/${c.id}">View</a>
    ${reviewButton(c, onList)}
    ${c.stage === 'applied' ? `<button type="button" class="btn btn-small btn-primary" data-interview="${c.id}">✓ Interview</button>` : ''}
    <button type="button" class="btn btn-small" data-decline="${c.id}">✕ Decline</button>
  </div></li>`;

export async function renderRecruitment(ctx) {
  const { el, state, query, stale, navigate, rerender } = ctx;
  const scope = siteScope(state, query.scope);
  const showAll = query.show === 'all';
  const [jobs, apps, inbox] = await Promise.all([api(`/vacancies${siteQuery(state, scope)}`), api('/applications'), api('/careers-inbox').catch(() => null)]);
  if (stale()) return;
  const noJob = apps.no_job.filter((c) => showAll || c.stage !== 'rejected');
  const shown = showAll ? jobs : jobs.filter((j) => j.status === 'open');
  const open = jobs.filter((j) => j.status === 'open');
  const multi = state.multiSite && scope === 'all';

  el.innerHTML = `
    <div class="page-head"><h1>Recruitment</h1><div class="actions"><button class="btn" id="pp-add-review">+ Add someone to review</button><button class="btn btn-primary" id="pp-new-job">+ New job</button></div></div>
    ${filters(state, scope)}
    <div class="kpis">
      <div class="kpi" data-icon="✎"><span>Open jobs</span><strong>${open.length}</strong></div>
      <div class="kpi" data-icon="☆"><span>To review</span><strong>${apps.to_review.length}</strong></div>
      <div class="kpi" data-icon="☺"><span>Candidates in progress</span><strong>${apps.in_progress.length}</strong>
        <small>${apps.in_progress.filter((c) => c.stage === 'interview').length} to interview · ${apps.in_progress.filter((c) => c.stage === 'trial').length} on trial · ${apps.in_progress.filter((c) => c.stage === 'offer').length} offered</small></div>
    </div>
    ${apps.to_review.length ? `<section class="card pp-apps" id="pp-to-review">
      <div class="pp-job-head"><div><h2>☆ To review <span class="badge badge-sent">${apps.to_review.length}</span></h2>
        <p class="muted small">People to look at properly – invite them to interview, turn them down, or tap “Done reviewing” to take them off the list.</p></div></div>
      <ul class="pp-app-list">${apps.to_review.map((c) => applicationCard(c, true)).join('')}</ul>
    </section>` : ''}
    ${apps.new.length || inbox?.configured ? `<section class="card pp-apps">
      <div class="pp-job-head"><h2>✉ New applications <span class="badge ${apps.new.length ? 'badge-sent' : ''}">${apps.new.length}</span></h2></div>
      ${apps.new.length ? `<ul class="pp-app-list">${apps.new.map((c) => applicationCard(c)).join('')}</ul>` : '<p class="muted small">Nothing new – applications emailed to the careers inbox appear here.</p>'}
    </section>` : ''}
    ${apps.in_progress.length ? `<section class="card pp-job" id="pp-in-progress">
      <div class="pp-job-head"><div><h2>In progress <span class="badge badge-sent">${apps.in_progress.length}</span></h2>
        <p class="muted small">Everyone being interviewed, on a trial shift or offered a job – soonest first.</p></div></div>
      <div class="table-wrap"><table class="pp-cands">
        <thead><tr><th>Candidate</th><th>Job</th><th>Stage</th><th>Next step</th></tr></thead>
        <tbody>${apps.in_progress.map((c) => `<tr>
          <td><a href="#/people/recruitment/candidates/${c.id}"><strong>${esc(c.name)}</strong></a>${c.files ? ' <span title="Has a CV">📎</span>' : ''}<small class="muted">${[c.phone, c.email].filter(Boolean).map(esc).join(' · ')}</small></td>
          <td>${c.job_title ? `${esc(c.job_title)}${c.site_name ? `<small class="muted">${esc(c.site_name)}</small>` : ''}` : '<span class="muted">No job picked</span>'}</td>
          <td><select data-stage="${c.id}" aria-label="Stage for ${esc(c.name)}">${STAGES.map(([v, l]) => `<option value="${v}" ${v === c.stage ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          <td>${c.next_step_on ? `<span class="${c.next_step_on < todayISO() ? 'tone-bad' : ''}">${fmtDate(c.next_step_on)}</span>` : '<span class="muted">Not booked</span>'}</td>
        </tr>`).join('')}</tbody></table></div>
    </section>` : ''}
    <p class="small"><a href="#/people/recruitment${qs({ scope: query.scope, show: showAll ? undefined : 'all' })}">${showAll ? 'Only show open jobs' : 'Show filled and closed jobs too'}</a></p>
    ${shown.length ? shown.map((j) => `<section class="card pp-job" data-job="${j.id}">
      <div class="pp-job-head">
        <div><h2>${esc(j.title)} ${j.status !== 'open' ? `<span class="badge">${j.status === 'filled' ? 'Filled' : 'Closed'}</span>` : ''}</h2>
          <p class="muted small">${multi || state.multiSite ? `${siteTag(j.location_name, j.location_id)} · ` : ''}${j.hours ? `${esc(j.hours)} · ` : ''}added ${day(j.created_at.slice(0, 10))}</p>
          ${j.notes ? `<p class="small">${esc(j.notes)}</p>` : ''}</div>
        <div class="actions"><button class="btn btn-small" data-edit-job="${j.id}">Edit</button>
          <button class="btn btn-small btn-primary" data-add-cand="${j.id}">+ Candidate</button></div>
      </div>
      ${j.candidates.length ? `<div class="table-wrap"><table class="pp-cands">
        <thead><tr><th>Candidate</th><th>Stage</th><th>Next step</th><th></th></tr></thead>
        <tbody>${j.candidates.map((c) => `<tr class="${c.stage === 'rejected' ? 'is-out' : ''}">
          <td><a href="#/people/recruitment/candidates/${c.id}"><strong>${esc(c.name)}</strong></a>${c.source === 'email' ? ' <span title="Applied by email">✉</span>' : ''}${c.files ? ` <span title="${c.files} file${c.files === 1 ? '' : 's'}">📎</span>` : ''}<small class="muted">${[c.phone, c.email].filter(Boolean).map(esc).join(' · ')}</small></td>
          <td><select data-stage="${c.id}" aria-label="Stage for ${esc(c.name)}">${STAGES.map(([v, l]) => `<option value="${v}" ${v === c.stage ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          <td>${c.next_step_on ? `<span class="${c.next_step_on < todayISO() ? 'tone-bad' : ''}">${fmtDate(c.next_step_on)}</span>` : '<span class="muted">–</span>'}</td>
          <td class="num pp-row-actions">${c.stage === 'rejected' || c.stage === 'hired' ? '' : reviewButton(c)}<button class="btn btn-small btn-ghost" data-edit-cand="${c.id}" data-job-of="${j.id}">Edit</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="muted small">No candidates yet.</p>'}
    </section>`).join('') : `<div class="empty">${jobs.length ? 'No open jobs right now.' : 'No jobs yet – add one when you’re hiring.'}</div>`}
    ${noJob.length ? `<section class="card pp-job">
      <div class="pp-job-head"><div><h2>Not for a particular job</h2><p class="muted small">People who applied in general – open their profile to put them forward for a job.</p></div></div>
      <div class="table-wrap"><table class="pp-cands">
        <thead><tr><th>Candidate</th><th>Stage</th><th>Next step</th><th></th></tr></thead>
        <tbody>${noJob.map((c) => `<tr class="${c.stage === 'rejected' ? 'is-out' : ''}">
          <td><a href="#/people/recruitment/candidates/${c.id}"><strong>${esc(c.name)}</strong></a>${c.files ? ' <span title="Has files">📎</span>' : ''}<small class="muted">${[c.phone, c.email].filter(Boolean).map(esc).join(' · ')}</small></td>
          <td><select data-stage="${c.id}" aria-label="Stage for ${esc(c.name)}">${STAGES.map(([v, l]) => `<option value="${v}" ${v === c.stage ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          <td>${c.next_step_on ? `<span class="${c.next_step_on < todayISO() ? 'tone-bad' : ''}">${fmtDate(c.next_step_on)}</span>` : '<span class="muted">–</span>'}</td>
          <td class="num">${c.stage === 'rejected' || c.stage === 'hired' ? '' : reviewButton(c)}</td>
        </tr>`).join('')}</tbody></table></div>
    </section>` : ''}
    ${careersCard(inbox)}`;

  el.querySelectorAll('[data-interview]').forEach((b) => b.addEventListener('click', () => interviewDialog([...apps.to_review, ...apps.new].find((c) => c.id === Number(b.dataset.interview)), jobs, rerender)));
  el.querySelectorAll('[data-review]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api(`/candidates/${b.dataset.review}/review`, { method: 'POST', body: { to_review: !!b.dataset.on } });
      toast(b.dataset.on ? 'Added to To review' : 'Taken off To review');
      rerender();
    } catch (err) { showError(err); b.disabled = false; }
  }));
  el.querySelectorAll('[data-decline]').forEach((b) => b.addEventListener('click', () => declineDialog(Number(b.dataset.decline), rerender)));
  el.querySelectorAll('[data-edit-template]').forEach((b) => b.addEventListener('click', () => templateDialog(inbox, rerender)));
  el.querySelector('#careers-check')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/careers-inbox/check', { method: 'POST' });
      toast(r.error ? r.error : r.added ? `${r.added} new application${r.added === 1 ? '' : 's'} added` : 'No new applications', r.error ? 'error' : 'ok');
      rerender();
    } catch (err) { showError(err); e.target.disabled = false; }
  });

  wireFilters(el, 'people/recruitment', navigate, { show: showAll ? 'all' : undefined });
  const job = (jid) => jobs.find((j) => j.id === Number(jid));
  const sites = state.locations.filter((l) => l.active);

  const jobModal = (j) => openModal({
    title: j ? `Edit ${j.title}` : 'New job',
    body: `${field('Job title', input('title', j?.title, 'required maxlength="100" placeholder="e.g. Barista"'))}
      ${!j && sites.length > 1 ? field('Site', select('location_id', sites.map((l) => [l.id, l.name]), state.locationId)) : ''}
      ${field('Hours', input('hours', j?.hours, 'maxlength="100" placeholder="e.g. Part time, weekends"'))}
      ${j ? field('Status', select('status', [['open', 'Open – still hiring'], ['filled', 'Filled'], ['closed', 'Closed']], j.status)) : ''}
      ${field('Notes', textarea('notes', j?.notes, 'maxlength="2000" placeholder="Where it’s advertised, pay, anything to remember"'))}`,
    submitLabel: j ? 'Save' : 'Add job',
    onSubmit: async (v) => {
      if (j) await api(`/vacancies/${j.id}`, { method: 'PUT', body: v });
      else await api('/vacancies', { method: 'POST', body: { ...v, location_id: v.location_id ?? state.locationId } });
      toast(j ? 'Job saved' : 'Job added');
      rerender();
    },
    danger: j ? 'Delete job' : null,
    onDanger: async () => {
      const n = j.candidates.length;
      if (!await confirmDialog(`Delete the ${j.title} job?${n ? ` Its ${n} candidate${n === 1 ? ' is' : 's are'} kept – they’ll show under “Not for a particular job” (or In progress), with their notes and CVs.` : ''}`, { confirmLabel: 'Delete job' })) return;
      await api(`/vacancies/${j.id}`, { method: 'DELETE' });
      toast(n ? `Job deleted – ${n} candidate${n === 1 ? '' : 's'} kept` : 'Job deleted');
      rerender();
    },
  });

  const candModal = (j, c) => openModal({
    title: c ? c.name : `New candidate – ${j.title}`,
    body: `${field('Name', input('name', c?.name, 'required maxlength="100"'))}
      <div class="row">${field('Phone', input('phone', c?.phone, 'type="tel" maxlength="50"'))}${field('Email', input('email', c?.email, 'type="email" maxlength="200"'))}</div>
      <div class="row">${field('Stage', select('stage', STAGES, c?.stage ?? 'applied'))}${field('Next step on', input('next_step_on', c?.next_step_on, 'type="date"'), { hint: 'e.g. their interview or trial shift' })}</div>
      ${field('Notes', textarea('notes', c?.notes, 'rows="5" maxlength="4000" placeholder="Interview notes, availability, references…"'))}`,
    submitLabel: c ? 'Save' : 'Add candidate',
    onSubmit: async (v) => {
      if (c) await api(`/candidates/${c.id}`, { method: 'PUT', body: v });
      else await api(`/vacancies/${j.id}/candidates`, { method: 'POST', body: v });
      toast(c ? 'Saved' : 'Candidate added');
      rerender();
    },
    danger: c ? 'Remove' : null,
    onDanger: async () => {
      await api(`/candidates/${c.id}`, { method: 'DELETE' });
      toast('Candidate removed');
      rerender();
    },
  });

  el.querySelector('#pp-new-job').addEventListener('click', () => jobModal(null));
  // Someone to look at who didn't come through the careers inbox – e.g. a CV handed in at the counter.
  el.querySelector('#pp-add-review').addEventListener('click', () => openModal({
    title: 'Add someone to review',
    body: `${field('Name', input('name', '', 'required maxlength="100"'))}
      <div class="row">${field('Phone', input('phone', '', 'type="tel" maxlength="50"'))}${field('Email', input('email', '', 'type="email" maxlength="200"'))}</div>
      ${field('For the job', select('vacancy_id', [['', '— Not for a particular job —'], ...open.map((j) => [j.id, `${j.title}${j.location_name ? ` – ${j.location_name}` : ''}`])], ''))}
      ${sites.length > 1 ? field('Site', select('location_id', sites.map((l) => [l.id, l.name]), state.locationId), { hint: 'Used when they’re not for a particular job' }) : ''}
      ${field('Notes', textarea('notes', '', 'rows="4" maxlength="4000" placeholder="Where they came from, what stood out…"'))}`,
    submitLabel: 'Add to To review',
    onSubmit: async (v) => {
      const body = { name: v.name, phone: v.phone, email: v.email, notes: v.notes };
      if (v.vacancy_id) {
        const r = await api(`/vacancies/${v.vacancy_id}/candidates`, { method: 'POST', body });
        await api(`/candidates/${r.id}/review`, { method: 'POST', body: { to_review: true } });
      } else {
        await api('/candidates', { method: 'POST', body: { ...body, location_id: v.location_id ?? state.locationId, to_review: true } });
      }
      toast(`${v.name} added to To review`);
      rerender();
    },
  }));
  el.querySelectorAll('[data-edit-job]').forEach((b) => b.addEventListener('click', () => jobModal(job(b.dataset.editJob))));
  el.querySelectorAll('[data-add-cand]').forEach((b) => b.addEventListener('click', () => candModal(job(b.dataset.addCand), null)));
  el.querySelectorAll('[data-edit-cand]').forEach((b) => b.addEventListener('click', () => {
    const j = job(b.dataset.jobOf);
    candModal(j, j.candidates.find((c) => c.id === Number(b.dataset.editCand)));
  }));
  el.querySelectorAll('[data-stage]').forEach((s) => s.addEventListener('change', async () => {
    try {
      await api(`/candidates/${s.dataset.stage}`, { method: 'PUT', body: { stage: s.value } });
      toast(s.value === 'hired' ? 'Hired! Add them in Square (or Setup → Staff) so they can sign in and go on the rota.' : `Moved to ${STAGE[s.value]}`);
      rerender();
    } catch (err) { showError(err); }
  }));
}

// A candidate's profile: their details, the email they sent, their CV and files, and notes.
export async function renderCandidate(ctx) {
  const { el, params, stale, rerender, navigate } = ctx;
  const [c, jobs] = await Promise.all([api(`/candidates/${params[0]}`), api('/vacancies')]);
  if (stale()) return;
  const fileUrl = (f) => `/api/candidates/${c.id}/files/${f.id}`;
  const viewable = (f) => f.file_type === 'application/pdf' || f.file_type.startsWith('image/');
  const first = c.files.find(viewable);

  el.innerHTML = `
    <p class="small"><a href="#/people/recruitment">← Recruitment</a></p>
    <div class="page-head"><div><h1>${esc(c.name)} <span class="badge ${c.stage === 'rejected' ? 'badge-cancelled' : c.stage === 'hired' ? 'badge-received' : 'badge-sent'}">${STAGE[c.stage]}</span></h1>
      <p class="muted small">${c.job_title ? `For <strong>${esc(c.job_title)}</strong>` : 'Not for a particular job'}${c.site_name ? ` · ${siteTag(c.site_name, c.site_id)}` : ''}
        · ${c.source === 'email' ? `applied by email ${esc(received(c))}` : `added ${day(c.created_at.slice(0, 10))}`}</p></div>
      <div class="actions">
        ${c.stage !== 'rejected' && c.stage !== 'hired' ? `<button class="btn" id="cand-review">${c.to_review_at ? '★ On To review – take off' : '☆ Add to To review'}</button>` : ''}
        ${c.stage === 'applied' ? '<button class="btn btn-primary" id="cand-interview">✓ Invite to interview</button>' : ''}
        ${c.stage !== 'rejected' && c.stage !== 'hired' ? '<button class="btn" id="cand-decline">✕ Decline</button>' : ''}
        <button class="btn btn-ghost" id="cand-edit">Edit</button></div></div>
    ${c.declined_at ? `<p class="notice">Turned down on ${fmtDateTime(c.declined_at)}${c.reply_drafted_at ? ' – a reply was saved in the careers inbox’s Drafts' : ''}.</p>` : ''}
    <div class="pp-profile">
      <div>
        <section class="card">
          <h2>Contact</h2>
          <p>${c.email ? `✉ <a href="mailto:${esc(c.email)}">${esc(c.email)}</a><br>` : ''}${c.phone ? `☎ <a href="tel:${esc(c.phone.replace(/\s/g, ''))}">${esc(c.phone)}</a>` : ''}${!c.email && !c.phone ? '<span class="muted">No contact details</span>' : ''}</p>
          ${c.next_step_on ? `<p class="small">Next step: <strong class="${c.next_step_on < todayISO() ? 'tone-bad' : ''}">${fmtDate(c.next_step_on)}</strong></p>` : ''}
        </section>
        ${c.message ? `<section class="card"><h2>Their email</h2>${c.subject ? `<p class="small muted">Subject: ${esc(c.subject)}</p>` : ''}<div class="pp-text pp-message">${esc(c.message)}</div></section>` : ''}
        <section class="card">
          <h2>Notes</h2>
          <textarea id="cand-notes" rows="5" maxlength="4000" placeholder="Interview notes, availability, references…">${esc(c.notes ?? '')}</textarea>
          <p><button class="btn btn-small" id="cand-save-notes">Save notes</button></p>
        </section>
      </div>
      <section class="card">
        <div class="pp-job-head"><h2>CV and files</h2>
          <label class="btn btn-small">+ Add a file<input type="file" id="cand-file" accept=".pdf,.doc,.docx,.odt,.rtf,.txt,.pages,image/*" hidden></label></div>
        ${c.files.length ? `<ul class="pp-files">${c.files.map((f) => `<li><span>📄 <button class="link-btn" data-open-file="${f.id}">${esc(f.file_name)}</button> <small class="muted">${fileSize(f.size)}</small></span>
          <button class="btn btn-small btn-ghost" data-del-file="${f.id}" title="Remove">✕</button></li>`).join('')}</ul>` : '<p class="muted small">No CV yet.</p>'}
        ${first ? '<div id="cand-preview" class="pp-preview muted small">Loading…</div>' : ''}
      </section>
    </div>`;

  const blobUrl = async (f) => {
    const r = await fetch(fileUrl(f));
    if (!r.ok) throw new Error('The file couldn’t be opened');
    return URL.createObjectURL(await r.blob());
  };
  if (first) {
    (async () => {
      const box = el.querySelector('#cand-preview');
      try {
        const url = await blobUrl(first);
        if (stale()) return;
        box.className = 'pp-preview';
        box.innerHTML = first.file_type === 'application/pdf' ? `<iframe src="${url}" title="${esc(first.file_name)}"></iframe>` : `<img src="${url}" alt="${esc(first.file_name)}">`;
      } catch { box.textContent = 'The CV couldn’t be shown here – open it above.'; }
    })();
  }
  el.querySelectorAll('[data-open-file]').forEach((b) => b.addEventListener('click', async () => {
    const f = c.files.find((x) => x.id === Number(b.dataset.openFile));
    try {
      const url = await blobUrl(f);
      const a = document.createElement('a');
      a.href = url;
      if (viewable(f)) a.target = '_blank'; else a.download = f.file_name;
      a.rel = 'noopener';
      a.click();
    } catch (err) { showError(err); }
  }));
  el.querySelectorAll('[data-del-file]').forEach((b) => b.addEventListener('click', async () => {
    const f = c.files.find((x) => x.id === Number(b.dataset.delFile));
    if (!await confirmDialog(`Remove ${f.file_name}?`, { confirmLabel: 'Remove' })) return;
    try { await api(`/candidates/${c.id}/files/${f.id}`, { method: 'DELETE' }); toast('Removed'); rerender(); } catch (err) { showError(err); }
  }));
  el.querySelector('#cand-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { showError(new Error('Files can be up to 10 MB')); return; }
    try {
      const data = await new Promise((ok, fail) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(',')[1] ?? '');
        r.onerror = () => fail(new Error('The file couldn’t be read'));
        r.readAsDataURL(file);
      });
      await api(`/candidates/${c.id}/files`, { method: 'POST', body: { file_name: file.name, media_type: file.type, data } });
      toast('File added');
      rerender();
    } catch (err) { showError(err); }
  });
  el.querySelector('#cand-save-notes').addEventListener('click', async () => {
    try { await api(`/candidates/${c.id}`, { method: 'PUT', body: { notes: el.querySelector('#cand-notes').value } }); toast('Notes saved'); } catch (err) { showError(err); }
  });
  el.querySelector('#cand-interview')?.addEventListener('click', () => interviewDialog(c, jobs, rerender));
  el.querySelector('#cand-review')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api(`/candidates/${c.id}/review`, { method: 'POST', body: { to_review: !c.to_review_at } });
      toast(c.to_review_at ? 'Taken off To review' : 'Added to To review');
      rerender();
    } catch (err) { showError(err); e.target.disabled = false; }
  });
  el.querySelector('#cand-decline')?.addEventListener('click', () => declineDialog(c.id, rerender));
  el.querySelector('#cand-edit').addEventListener('click', () => openModal({
    title: `Edit ${c.name}`,
    body: `${field('Name', input('name', c.name, 'required maxlength="100"'))}
      <div class="row">${field('Phone', input('phone', c.phone, 'type="tel" maxlength="50"'))}${field('Email', input('email', c.email, 'type="email" maxlength="200"'))}</div>
      ${field('For the job', select('vacancy_id', [['', '— Not for a particular job —'], ...jobs.filter((j) => j.status === 'open' || j.id === c.vacancy_id).map((j) => [j.id, `${j.title} – ${j.location_name}`])], c.vacancy_id ?? ''))}
      <div class="row">${field('Stage', select('stage', STAGES, c.stage))}${field('Next step on', input('next_step_on', c.next_step_on, 'type="date"'))}</div>`,
    onSubmit: async (v) => {
      await api(`/candidates/${c.id}`, { method: 'PUT', body: { ...v, vacancy_id: v.vacancy_id || null } });
      toast('Saved');
      rerender();
    },
    danger: 'Delete candidate',
    onDanger: async () => {
      if (!await confirmDialog(`Delete ${c.name}, their email and their files? This can’t be undone.`, { confirmLabel: 'Delete' })) return;
      await api(`/candidates/${c.id}`, { method: 'DELETE' });
      toast('Deleted');
      navigate('people/recruitment');
    },
  }));
}

// ---- Learning and development ----

const COURSE_IDEAS = [['Food hygiene level 2', 36], ['Allergen awareness', 12], ['Fire safety', 12], ['Barista training', null], ['Manual handling', 36], ['First aid', 36]];

export async function renderTraining(ctx) {
  const { el, state, query, stale, navigate, rerender } = ctx;
  const scope = siteScope(state, query.scope);
  const data = await api(`/training${siteQuery(state, scope)}`);
  if (stale()) return;
  const rec = new Map(data.records.map((r) => [`${r.user_id}|${r.course_id}`, r]));
  const expired = data.records.filter((r) => r.status === 'expired');
  const soon = data.records.filter((r) => r.status === 'due_soon');
  const missing = data.people.length * data.courses.length - data.records.length;

  el.innerHTML = `
    <div class="page-head"><h1>Learning &amp; development</h1><div class="actions">
      <button class="btn" id="pp-new-course">+ Course</button>
      ${data.courses.length ? '<button class="btn btn-primary" id="pp-record">Record training</button>' : ''}</div></div>
    ${filters(state, scope)}
    ${data.courses.length ? `<div class="kpis">
      <div class="kpi ${expired.length ? 'kpi-bad' : ''}" data-icon="!"><span>Out of date</span><strong>${expired.length}</strong></div>
      <div class="kpi ${soon.length ? 'kpi-warn' : ''}" data-icon="◷"><span>Due in the next month</span><strong>${soon.length}</strong></div>
      <div class="kpi" data-icon="○"><span>Not done yet</span><strong>${Math.max(missing, 0)}</strong></div>
    </div>
    <section class="card">
      <h2>Training matrix</h2>
      <p class="muted small">Tap a box to record training. Tap a name for everything they’ve done, or a course to change it.</p>
      ${data.people.length ? `<div class="table-wrap"><table class="pp-matrix">
        <thead><tr><th>Person</th>${data.courses.map((c) => `<th><button class="link-btn" data-course="${c.id}">${esc(c.name)}</button>${c.renew_months ? `<small class="muted"> ↻ every ${c.renew_months} months</small>` : ''}</th>`).join('')}</tr></thead>
        <tbody>${data.people.map((p) => `<tr><th scope="row"><button class="link-btn" data-history="${p.id}">${esc(p.name)}</button>${p.position ? `<small class="muted">${esc(p.position)}</small>` : ''}</th>
          ${data.courses.map((c) => {
            const r = rec.get(`${p.id}|${c.id}`);
            const label = !r ? '–' : r.status === 'expired' ? `Expired ${fmtDate(r.expires_on, { day: 'numeric', month: 'short' })}` : r.status === 'due_soon' ? `Due ${fmtDate(r.expires_on, { day: 'numeric', month: 'short' })}` : `✓ ${fmtDate(r.completed_on, { day: 'numeric', month: 'short', year: '2-digit' })}`;
            return `<td><button class="pp-cell pp-${r ? r.status : 'none'}" data-cell="${p.id}|${c.id}" title="${esc(`${p.name} – ${c.name}`)}">${label}</button></td>`;
          }).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="empty">No staff at this site yet.</div>'}
    </section>` : `<section class="card"><h2>Add your training courses</h2>
      <p>List the training your team needs – Atlas then shows who has done what, and what’s about to run out.</p>
      <p class="muted small">Quick add:</p>
      <div class="chips">${COURSE_IDEAS.map(([n, m]) => `<button class="chip chip-btn" data-idea="${esc(n)}" data-months="${m ?? ''}">+ ${esc(n)}</button>`).join('')}</div>
    </section>`}`;

  wireFilters(el, 'people/training', navigate);
  const course = (cid) => data.courses.find((c) => c.id === Number(cid));
  const who = (uid) => data.people.find((p) => p.id === Number(uid));

  const courseModal = (c) => openModal({
    title: c ? c.name : 'New training course',
    body: `${field('Course name', input('name', c?.name, 'required maxlength="100" placeholder="e.g. Food hygiene level 2"'))}
      ${field('Needs doing again every (months)', input('renew_months', c?.renew_months, 'type="number" min="1" max="120" placeholder="Leave blank if it’s once only"'))}
      ${field('Notes', textarea('description', c?.description, 'maxlength="1000" placeholder="e.g. Online course link, who runs it"'))}`,
    submitLabel: c ? 'Save' : 'Add course',
    onSubmit: async (v) => {
      await api(c ? `/training/courses/${c.id}` : '/training/courses', { method: c ? 'PUT' : 'POST', body: v });
      toast(c ? 'Course saved' : 'Course added');
      rerender();
    },
    danger: c ? 'Remove course' : null,
    onDanger: async () => {
      await api(`/training/courses/${c.id}`, { method: 'DELETE' });
      toast('Course removed');
      rerender();
    },
  });

  const recordModal = ({ courseId = null, userIds = [] } = {}) => wirePicker(openModal({
    title: 'Record training',
    body: `${field('Course', select('course_id', data.courses.map((c) => [c.id, c.name]), courseId ?? data.courses[0]?.id))}
      ${field('Date completed', input('completed_on', todayISO(), `type="date" required max="${todayISO()}"`))}
      <fieldset class="pp-pick"><legend>Who did it <span class="muted small" data-picked></span></legend>
        <div class="pp-pick-tools"><input type="search" data-pick-search placeholder="Search names…" aria-label="Search names" autocomplete="off">
          <button type="button" class="btn btn-small" data-pick-all>Tick all shown</button><button type="button" class="btn btn-small btn-ghost" data-pick-none>Clear</button></div>
        <div class="pp-pick-list">${data.people.map((p) => `<label class="pp-pick-item" data-name="${esc(p.name.toLowerCase())}"><input type="checkbox" data-who="${p.id}" ${userIds.includes(p.id) ? 'checked' : ''}>
          <span>${esc(p.name)}${p.position ? `<small class="muted">${esc(p.position)}</small>` : ''}</span></label>`).join('')}</div>
      </fieldset>
      ${field('Notes (optional)', textarea('notes', '', 'maxlength="1000" placeholder="e.g. Certificate number, score"'))}`,
    submitLabel: 'Save',
    wide: true,
    onSubmit: async (v, form) => {
      const ids = [...form.querySelectorAll('[data-who]:checked')].map((b) => Number(b.dataset.who));
      if (!ids.length) throw new Error('Tick who did the training');
      await api('/training/records', { method: 'POST', body: { course_id: v.course_id, completed_on: v.completed_on, notes: v.notes, user_ids: ids } });
      toast(`Training recorded for ${ids.length} ${ids.length === 1 ? 'person' : 'people'}`);
      rerender();
    },
  }).form);

  // The "Who did it" list: search by name, tick everyone shown, and a count of who's ticked.
  const wirePicker = (form) => {
    const items = [...form.querySelectorAll('.pp-pick-item')];
    const count = () => {
      const n = form.querySelectorAll('[data-who]:checked').length;
      form.querySelector('[data-picked]').textContent = n ? `· ${n} ticked` : '';
    };
    form.querySelector('[data-pick-search]').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      items.forEach((i) => { i.hidden = !!q && !i.dataset.name.includes(q); });
    });
    // Enter in the search box shouldn't save the form.
    form.querySelector('[data-pick-search]').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    form.querySelector('[data-pick-all]').addEventListener('click', () => { items.filter((i) => !i.hidden).forEach((i) => { i.querySelector('input').checked = true; }); count(); });
    form.querySelector('[data-pick-none]').addEventListener('click', () => { items.forEach((i) => { i.querySelector('input').checked = false; }); count(); });
    form.addEventListener('change', count);
    count();
  };

  const historyModal = async (p) => {
    try {
      const h = await api(`/training/people/${p.id}`);
      const { form } = openModal({
        title: `${p.name}’s training`,
        body: h.records.length ? `<ul class="pp-history">${h.records.map((r) => `<li><div><strong>${esc(r.course_name)}</strong> · ${day(r.completed_on)}
          ${r.notes ? `<small>${esc(r.notes)}</small>` : ''}${r.recorded_by_name ? `<small class="muted">recorded by ${esc(r.recorded_by_name)}</small>` : ''}</div>
          <button type="button" class="btn btn-small btn-ghost" data-del-rec="${r.id}">Remove</button></li>`).join('')}</ul>` : '<p class="muted">Nothing recorded yet.</p>',
      });
      form.querySelectorAll('[data-del-rec]').forEach((b) => b.addEventListener('click', async () => {
        try {
          await api(`/training/records/${b.dataset.delRec}`, { method: 'DELETE' });
          b.closest('li').remove();
          toast('Removed');
          rerender();
        } catch (err) { showError(err); }
      }));
    } catch (err) { showError(err); }
  };

  el.querySelector('#pp-new-course').addEventListener('click', () => courseModal(null));
  el.querySelector('#pp-record')?.addEventListener('click', () => recordModal());
  el.querySelectorAll('[data-course]').forEach((b) => b.addEventListener('click', () => courseModal(course(b.dataset.course))));
  el.querySelectorAll('[data-history]').forEach((b) => b.addEventListener('click', () => historyModal(who(b.dataset.history))));
  el.querySelectorAll('[data-cell]').forEach((b) => b.addEventListener('click', () => {
    const [uid, cid] = b.dataset.cell.split('|').map(Number);
    recordModal({ courseId: cid, userIds: [uid] });
  }));
  el.querySelectorAll('[data-idea]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api('/training/courses', { method: 'POST', body: { name: b.dataset.idea, renew_months: b.dataset.months || null } });
      toast(`${b.dataset.idea} added`);
      rerender();
    } catch (err) { showError(err); b.disabled = false; }
  }));
}

// ---- Performance ----

export async function renderPerformance(ctx) {
  const { el, state, query, stale, navigate } = ctx;
  const scope = siteScope(state, query.scope);
  const rows = await api(`/performance${siteQuery(state, scope)}`);
  if (stale()) return;
  const overdue = rows.filter((r) => r.overdue);
  const never = rows.filter((r) => !r.last);
  const multi = state.multiSite && scope === 'all';

  el.innerHTML = `
    <div class="page-head"><h1>Performance</h1></div>
    ${filters(state, scope)}
    <div class="kpis">
      <div class="kpi ${overdue.length ? 'kpi-bad' : ''}" data-icon="!"><span>Reviews overdue</span><strong>${overdue.length}</strong></div>
      <div class="kpi" data-icon="○"><span>Never reviewed</span><strong>${never.length}</strong></div>
    </div>
    <section class="card">
      ${rows.length ? `<div class="table-wrap"><table class="pp-perf">
        <thead><tr><th>Person</th>${multi ? '<th>Site</th>' : ''}<th>Last review</th><th>Rating</th><th>Next review</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><a href="#/people/performance/${r.id}"><strong>${esc(r.name)}</strong></a>${r.position ? `<small class="muted">${esc(r.position)}</small>` : ''}</td>
          ${multi ? `<td>${siteTag(r.location_name, r.location_id)}</td>` : ''}
          <td>${r.last ? `${day(r.last.review_date)}<small class="muted">${KIND[r.last.kind]}${r.reviews > 1 ? ` · ${r.reviews} in all` : ''}</small>` : '<span class="muted">None yet</span>'}</td>
          <td>${stars(r.last?.rating)}</td>
          <td>${r.last?.next_review_on ? `<span class="${r.overdue ? 'tone-bad' : ''}">${r.overdue ? 'Overdue · ' : ''}${day(r.last.next_review_on)}</span>` : '<span class="muted">–</span>'}</td>
          <td class="num"><a class="btn btn-small" href="#/people/performance/${r.id}?new=1">+ Review</a></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No staff at this site yet.</div>'}
    </section>
    <p class="muted small">Reviews are only seen by people who can use the People section.</p>`;
  wireFilters(el, 'people/performance', navigate);
}

export async function renderPerson(ctx) {
  const { el, params, query, stale, rerender, navigate } = ctx;
  const data = await api(`/performance/people/${params[0]}`);
  if (stale()) return;
  const p = data.person;

  el.innerHTML = `
    <p class="small"><a href="#/people/performance">← Performance</a></p>
    <div class="page-head"><h1>${esc(p.name)}</h1><div class="actions"><button class="btn btn-primary" id="pp-new-review">+ New review</button></div></div>
    ${data.reviews.length ? data.reviews.map((r) => `<section class="card pp-review">
      <div class="pp-job-head"><div><h2>${KIND[r.kind]} · ${day(r.review_date)}</h2>
        <p class="muted small">${r.reviewer_name ? `by ${esc(r.reviewer_name)}` : ''}${r.next_review_on ? ` · next review ${day(r.next_review_on)}` : ''}</p></div>
        <div class="actions">${stars(r.rating)} <button class="btn btn-small btn-ghost" data-edit-review="${r.id}">Edit</button></div></div>
      ${r.went_well ? `<h3>What went well</h3><p class="pp-text">${esc(r.went_well)}</p>` : ''}
      ${r.to_improve ? `<h3>What to work on</h3><p class="pp-text">${esc(r.to_improve)}</p>` : ''}
      ${r.goals ? `<h3>Goals</h3><p class="pp-text">${esc(r.goals)}</p>` : ''}
    </section>`).join('') : '<div class="empty">No reviews yet.</div>'}`;

  const reviewModal = (r) => {
    const next = new Date();
    next.setMonth(next.getMonth() + 3);
    openModal({
      title: r ? `Edit ${KIND[r.kind].toLowerCase()}` : `Review – ${p.name}`,
      wide: true,
      body: `<div class="row">${field('Type', select('kind', KINDS, r?.kind ?? 'one_to_one'))}${field('Date', input('review_date', r?.review_date ?? todayISO(), 'type="date" required'))}</div>
        ${field('Overall', select('rating', [['', '— No rating —'], [5, '★★★★★ Excellent'], [4, '★★★★ Good'], [3, '★★★ Fine'], [2, '★★ Needs to improve'], [1, '★ Of concern']], r?.rating ?? ''))}
        ${field('What went well', textarea('went_well', r?.went_well, 'rows="4" maxlength="4000"'))}
        ${field('What to work on', textarea('to_improve', r?.to_improve, 'rows="4" maxlength="4000"'))}
        ${field('Goals before the next review', textarea('goals', r?.goals, 'rows="3" maxlength="4000"'))}
        ${field('Next review', input('next_review_on', r ? r.next_review_on : next.toLocaleDateString('en-CA'), 'type="date"'))}`,
      submitLabel: r ? 'Save' : 'Save review',
      onSubmit: async (v) => {
        if (r) await api(`/performance/reviews/${r.id}`, { method: 'PUT', body: v });
        else await api('/performance/reviews', { method: 'POST', body: { ...v, user_id: p.id } });
        toast('Review saved');
        if (query.new) navigate(`people/performance/${p.id}`);
        else rerender();
      },
      danger: r ? 'Delete' : null,
      onDanger: async () => {
        if (!await confirmDialog('Delete this review?', { confirmLabel: 'Delete' })) return;
        await api(`/performance/reviews/${r.id}`, { method: 'DELETE' });
        toast('Review deleted');
        rerender();
      },
    });
  };
  el.querySelector('#pp-new-review').addEventListener('click', () => reviewModal(null));
  el.querySelectorAll('[data-edit-review]').forEach((b) => b.addEventListener('click', () => reviewModal(data.reviews.find((r) => r.id === Number(b.dataset.editReview)))));
  if (query.new) reviewModal(null);
}

// ---- Areas ----

const AREA_IDEAS = ['Barista', 'Bar', 'Floor', 'Till', 'Kitchen', 'Bakery'];
const NEXT_LEVEL = { none: 'learning', learning: 'trained', trained: null };
const LEVEL_LABEL = { learning: '◐ Learning', trained: '✓ Trained' };

export async function renderAreas(ctx) {
  const { el, state, query, stale, navigate, rerender } = ctx;
  const scope = siteScope(state, query.scope);
  const data = await api(`/areas${siteQuery(state, scope)}`);
  if (stale()) return;
  const level = new Map(data.links.map((l) => [`${l.user_id}|${l.area_id}`, l.level]));
  const count = (aid, lv) => data.people.filter((p) => level.get(`${p.id}|${aid}`) === lv).length;

  el.innerHTML = `
    <div class="page-head"><h1>Areas</h1><div class="actions"><button class="btn btn-primary" id="pp-new-area">+ Area</button></div></div>
    ${filters(state, scope)}
    ${data.areas.length ? `<section class="card">
      <p class="muted small">Who can work where. Tap a box to change it: blank → <strong>learning</strong> → <strong>trained</strong> → blank. Tap an area’s name to rename or remove it.</p>
      ${data.people.length ? `<div class="table-wrap"><table class="pp-matrix pp-areas">
        <thead><tr><th>Person</th>${data.areas.map((a) => `<th><button class="link-btn" data-area="${a.id}">${esc(a.name)}</button></th>`).join('')}</tr></thead>
        <tbody>${data.people.map((p) => `<tr><th scope="row">${esc(p.name)}${p.position ? `<small class="muted">${esc(p.position)}</small>` : ''}</th>
          ${data.areas.map((a) => {
            const lv = level.get(`${p.id}|${a.id}`) ?? 'none';
            return `<td><button class="pp-cell pp-${lv}" data-user="${p.id}" data-area-cell="${a.id}" data-level="${lv}" title="${esc(`${p.name} – ${a.name}`)}">${LEVEL_LABEL[lv] ?? '–'}</button></td>`;
          }).join('')}</tr>`).join('')}</tbody>
        <tfoot><tr><th>Trained</th>${data.areas.map((a) => `<td data-count="${a.id}"><strong>${count(a.id, 'trained')}</strong>${count(a.id, 'learning') ? ` <span class="muted small">+${count(a.id, 'learning')} learning</span>` : ''}</td>`).join('')}</tr></tfoot>
      </table></div>` : '<div class="empty">No staff at this site yet.</div>'}
    </section>` : `<section class="card"><h2>Set up your areas</h2>
      <p>Add the areas people work in – then tick who is trained or learning in each, so you can see your cover at a glance.</p>
      <p class="muted small">Quick add:</p>
      <div class="chips">${AREA_IDEAS.map((n) => `<button class="chip chip-btn" data-idea="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>
    </section>`}`;

  wireFilters(el, 'people/areas', navigate);
  const areaModal = (a) => openModal({
    title: a ? `Rename ${a.name}` : 'New area',
    body: field('Area name', input('name', a?.name, 'required maxlength="60" placeholder="e.g. Kitchen"')),
    submitLabel: a ? 'Save' : 'Add area',
    onSubmit: async (v) => {
      await api(a ? `/areas/${a.id}` : '/areas', { method: a ? 'PUT' : 'POST', body: v });
      toast(a ? 'Saved' : 'Area added');
      rerender();
    },
    danger: a ? 'Remove area' : null,
    onDanger: async () => {
      await api(`/areas/${a.id}`, { method: 'DELETE' });
      toast(`${a.name} removed`);
      rerender();
    },
  });
  el.querySelector('#pp-new-area').addEventListener('click', () => areaModal(null));
  el.querySelectorAll('[data-area]').forEach((b) => b.addEventListener('click', () => areaModal(data.areas.find((a) => a.id === Number(b.dataset.area)))));
  el.querySelectorAll('[data-idea]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api('/areas', { method: 'POST', body: { name: b.dataset.idea } });
      toast(`${b.dataset.idea} added`);
      rerender();
    } catch (err) { showError(err); b.disabled = false; }
  }));
  el.querySelectorAll('[data-area-cell]').forEach((b) => b.addEventListener('click', async () => {
    const next = NEXT_LEVEL[b.dataset.level];
    b.disabled = true;
    try {
      await api(`/areas/${b.dataset.areaCell}/people/${b.dataset.user}`, { method: 'PUT', body: { level: next } });
      const lv = next ?? 'none';
      level.set(`${b.dataset.user}|${b.dataset.areaCell}`, next ?? undefined);
      b.dataset.level = lv;
      b.className = `pp-cell pp-${lv}`;
      b.textContent = LEVEL_LABEL[lv] ?? '–';
      const aid = Number(b.dataset.areaCell);
      const learning = count(aid, 'learning');
      el.querySelector(`[data-count="${aid}"]`).innerHTML = `<strong>${count(aid, 'trained')}</strong>${learning ? ` <span class="muted small">+${learning} learning</span>` : ''}`;
    } catch (err) { showError(err); }
    b.disabled = false;
  }));
}
