import { api, confirmDialog, esc, field, fmtDate, input, openModal, qs, select, showError, siteColour, siteFilter, siteScope, textarea, toast, todayISO } from '../lib.js';

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

export async function renderRecruitment(ctx) {
  const { el, state, query, stale, navigate, rerender } = ctx;
  const scope = siteScope(state, query.scope);
  const showAll = query.show === 'all';
  const jobs = await api(`/vacancies${siteQuery(state, scope)}`);
  if (stale()) return;
  const shown = showAll ? jobs : jobs.filter((j) => j.status === 'open');
  const open = jobs.filter((j) => j.status === 'open');
  const inPlay = open.flatMap((j) => j.candidates).filter((c) => !['hired', 'rejected'].includes(c.stage));
  const multi = state.multiSite && scope === 'all';

  el.innerHTML = `
    <div class="page-head"><h1>Recruitment</h1><div class="actions"><button class="btn btn-primary" id="pp-new-job">+ New job</button></div></div>
    ${filters(state, scope)}
    <div class="kpis">
      <div class="kpi" data-icon="✎"><span>Open jobs</span><strong>${open.length}</strong></div>
      <div class="kpi" data-icon="☺"><span>Candidates in progress</span><strong>${inPlay.length}</strong>
        <small>${inPlay.filter((c) => c.stage === 'interview').length} to interview · ${inPlay.filter((c) => c.stage === 'trial').length} on trial</small></div>
    </div>
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
          <td><strong>${esc(c.name)}</strong><small class="muted">${[c.phone, c.email].filter(Boolean).map(esc).join(' · ')}</small></td>
          <td><select data-stage="${c.id}" aria-label="Stage for ${esc(c.name)}">${STAGES.map(([v, l]) => `<option value="${v}" ${v === c.stage ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          <td>${c.next_step_on ? `<span class="${c.next_step_on < todayISO() ? 'tone-bad' : ''}">${fmtDate(c.next_step_on)}</span>` : '<span class="muted">–</span>'}</td>
          <td class="num"><button class="btn btn-small btn-ghost" data-edit-cand="${c.id}" data-job-of="${j.id}">Edit</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="muted small">No candidates yet.</p>'}
    </section>`).join('') : `<div class="empty">${jobs.length ? 'No open jobs right now.' : 'No jobs yet – add one when you’re hiring.'}</div>`}`;

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
      if (!await confirmDialog(`Delete ${j.title} and its ${j.candidates.length} candidate${j.candidates.length === 1 ? '' : 's'}? To keep a record, set it to Filled or Closed instead.`, { confirmLabel: 'Delete' })) return;
      await api(`/vacancies/${j.id}`, { method: 'DELETE' });
      toast('Job deleted');
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
      <p>List the training your team needs – Brewly then shows who has done what, and what’s about to run out.</p>
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

  const recordModal = ({ courseId = null, userIds = [] } = {}) => openModal({
    title: 'Record training',
    body: `${field('Course', select('course_id', data.courses.map((c) => [c.id, c.name]), courseId ?? data.courses[0]?.id))}
      ${field('Date completed', input('completed_on', todayISO(), `type="date" required max="${todayISO()}"`))}
      <fieldset class="field pp-pick"><legend>Who did it</legend>${data.people.map((p) => `<label class="check"><input type="checkbox" data-who="${p.id}" ${userIds.includes(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}</fieldset>
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
  });

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
