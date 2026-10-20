import { addDays, api, confirmDialog, esc, field, fmtDate, formData, input, openModal, qs, select, showError, sitePicker, textarea, toast, todayISO, weekStart } from '../lib.js';
import { methodByKey, SFBB_CLOSING, SFBB_CREDIT, SFBB_FACTSHEET, SFBB_METHODS, SFBB_OPENING, SFBB_REVIEW_CHECKS, SFBB_SECTIONS, SFBB_TRAINING_EXTRAS } from '../sfbb-content.js';

// Safer Food, Better Business: the Food Standards Agency's food safety pack, worked through in Atlas for each site –
// the safe methods, the diary, the 4-weekly review, staff training and the records kept with the pack.

function sfbbTabs(state, active) {
  const items = [['safety/sfbb', 'Safe methods'], ['safety/diary', 'Diary'], ['safety/review', '4-weekly review'], ['safety/training', 'Training record'], ['safety/records', 'Records']];
  return `<div class="tabs">${items.map(([p, l]) => `<a href="#/${p}" class="${active === p ? 'active' : ''}">${l}</a>`).join('')}</div>`;
}

const head = (state, title, extra = '') => `
  <div class="page-head">
    <h1>${esc(title)}${state.location?.name ? ` · ${esc(state.location.name)}` : ''}</h1>
    <div class="actions">${extra}${sitePicker(state)}</div>
  </div>`;
// On a phone the tabs scroll sideways: bring the open one into view.
const showTab = (el) => {
  for (const a of el.querySelectorAll('.tabs a.active')) a.parentElement.scrollLeft = a.offsetLeft - a.parentElement.offsetLeft - 16;
};
const credit = `<p class="muted small sfbb-credit">${esc(SFBB_CREDIT)}</p>`;
const canManage = (state) => state.can('safety.manage');
const canWrite = (state) => state.can('safety.complete') || state.can('safety.manage');
const fmtWhen = (iso) => (iso ? fmtDate(iso, { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
const list = (items) => (items.length ? `<ul class="sfbb-list">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');

function methodStatus(m) {
  if (!m) return ['To do', ''];
  if (m.not_relevant) return ['Not relevant', 'sfbb-na'];
  if (m.completed_at) return [`Done ${fmtWhen(m.completed_at)}`, 'pill-good'];
  return ['Started', 'pill-warn'];
}

// --- The pack: every safe method and how far the site has got ---

export async function renderPack(ctx) {
  const { el, state, stale } = ctx;
  const data = await api(`/sfbb/pack${qs({ location_id: state.locationId })}`);
  if (stale()) return;
  const m = data.methods;
  const relevant = SFBB_METHODS.filter((x) => !m[x.key]?.not_relevant);
  const done = relevant.filter((x) => m[x.key]?.completed_at).length;
  const pct = relevant.length ? Math.round((done / relevant.length) * 100) : 100;
  const overdue = data.review_due <= todayISO();

  el.innerHTML = `
    ${head(state, 'Safer Food, Better Business', '<a class="btn btn-primary" href="#/safety/sfbb/download">⬇ Download pack</a>')}
    ${sfbbTabs(state, 'safety/sfbb')}
    <section class="card sfbb-summary">
      <div class="sfbb-progress">
        <strong>${done} of ${relevant.length} safe methods worked through</strong>
        <div class="sfbb-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
        <small class="muted">Work through each safe method that applies to this site: answer its questions, then sign it off. Mark any that don’t apply as not relevant.</small>
      </div>
      <ul class="sfbb-alerts">
        <li class="${data.unsigned_days ? 'is-bad' : 'is-good'}"><a href="#/safety/diary">${data.unsigned_days ? `The diary wasn’t signed on ${data.unsigned_days} of the last 7 days` : 'Diary signed every day this week'}</a></li>
        <li class="${overdue ? 'is-bad' : 'is-good'}"><a href="#/safety/review">${data.last_review ? `4-weekly review ${overdue ? 'due – last done' : 'done'} ${fmtWhen(data.last_review.date)}${overdue ? '' : ` · next by ${fmtWhen(data.review_due)}`}` : '4-weekly review not done yet'}</a></li>
      </ul>
    </section>
    ${SFBB_SECTIONS.map((s) => `
      <section class="card">
        <header class="card-head"><h2>${esc(s.title)}</h2><span class="pill">${s.methods.filter((x) => m[x.key]?.completed_at || m[x.key]?.not_relevant).length} / ${s.methods.length}</span></header>
        <p class="muted">${esc(s.intro)}</p>
        <ul class="sfbb-methods">${s.methods.map((x) => {
          const [label, tone] = methodStatus(m[x.key]);
          return `<li><a href="#/safety/sfbb/${x.key}"><span>${esc(x.title)}</span><span class="pill ${tone}">${esc(label)}</span><span class="hub-go" aria-hidden="true">›</span></a></li>`;
        }).join('')}</ul>
      </section>`).join('')}
    ${credit}`;
  showTab(el);
}

// --- One safe method: what to do and why, its questions, and what to do if things go wrong ---

export async function renderMethod(ctx) {
  const { el, state, params, stale } = ctx;
  const method = methodByKey(params[0]);
  if (!method) {
    el.innerHTML = '<div class="empty">That safe method wasn’t found. <a href="#/safety/sfbb">Back to the pack</a></div>';
    return;
  }
  const [data, checks] = await Promise.all([
    api(`/sfbb/pack${qs({ location_id: state.locationId })}`),
    method.checks ? api(`/sfbb/checks${qs({ location_id: state.locationId })}`) : null,
  ]);
  if (stale()) return;
  const saved = data.methods[method.key];
  const answers = saved?.answers ?? {};
  const manage = canManage(state);
  const dis = manage ? '' : 'disabled';
  const [label, tone] = methodStatus(saved);
  const idx = SFBB_METHODS.findIndex((x) => x.key === method.key);
  const prev = SFBB_METHODS[idx - 1];
  const next = SFBB_METHODS[idx + 1];

  const question = ([q, kind], i) => {
    const a = answers[i] ?? {};
    return `<div class="sfbb-q">
      <p><strong>${esc(q)}</strong></p>
      ${kind === 'yn' ? `<div class="sfbb-yn">
        <label><input type="radio" name="q${i}" value="yes" ${a.answer === 'yes' ? 'checked' : ''} ${dis}> Yes</label>
        <label><input type="radio" name="q${i}" value="no" ${a.answer === 'no' ? 'checked' : ''} ${dis}> No</label>
        ${input(`n${i}`, a.note, `placeholder="Notes (optional – say what you do if not)" ${dis} aria-label="Notes"`)}</div>`
        : textarea(`n${i}`, a.note, `rows="2" ${dis} aria-label="${esc(q)}"`)}
    </div>`;
  };

  el.innerHTML = `
    <p class="sfbb-back"><a href="#/safety/sfbb">‹ All safe methods</a></p>
    <div class="page-head">
      <div><small class="muted">${esc(method.sectionTitle)} · ${state.location?.name ? esc(state.location.name) : ''}</small><h1>${esc(method.title)}</h1></div>
      <div class="actions"><span class="pill ${tone}">${esc(label)}</span>${sitePicker(state)}</div>
    </div>
    <p class="sfbb-intro">${esc(method.intro)}</p>
    ${saved?.completed_at ? `<p class="sfbb-signoff">${saved.not_relevant ? 'Marked as not relevant to this site' : 'Signed off'} by ${esc(saved.completed_by_name ?? 'someone')} on ${fmtWhen(saved.completed_at)}.</p>` : ''}
    ${method.points.length ? `<section class="card">
      <h2>What to do${method.points.some(([, why]) => why) ? ' and why' : ''}</h2>
      <ul class="sfbb-points">${method.points.map(([what, why]) => `<li><span>${esc(what)}</span>${why ? `<small>${esc(why)}</small>` : ''}</li>`).join('')}</ul>
    </section>` : ''}
    ${(method.notes ?? []).map(([h, t]) => `<section class="card sfbb-note"><h3>${esc(h)}</h3><p>${esc(t)}</p></section>`).join('')}
    ${checks ? `<section class="card">
      <h2>The pack’s opening and closing checks</h2>
      <p class="muted">These are done every day in <a href="#/safety/checks">Food Safety Checks</a>. Ticked ones are already in this site’s checks.</p>
      ${[['Opening checks', SFBB_OPENING], ['Closing checks', SFBB_CLOSING]].map(([h, items]) => `<h3 class="group-title">${h}</h3>
        <ul class="sfbb-checks">${items.map((t) => `<li class="${checks.checks.find((c) => c.title === t)?.added ? 'is-added' : ''}">${esc(t)}</li>`).join('')}</ul>`).join('')}
      ${manage && checks.checks.some((c) => !c.added) ? `<button class="btn btn-primary" id="add-checks">Add the ${checks.checks.filter((c) => !c.added).length} missing checks to this site</button>
        <p class="muted small">You can then switch off any older checks that say the same thing in <a href="#/safety/setup">Set up Checks</a>.</p>` : ''}
    </section>` : ''}
    <form id="sfbb-form">
      ${method.questions.length ? `<section class="card">
        <h2>How do you do this?</h2>
        ${manage ? '' : '<p class="muted">Only managers can change these answers.</p>'}
        ${method.questions.map(question).join('')}
      </section>` : ''}
      ${method.wrong.length || method.stop.length ? `<section class="card sfbb-wrong">
        ${method.wrong.length ? `<h2>What to do if things go wrong</h2>${list(method.wrong)}` : ''}
        ${method.stop.length ? `<h2>How to stop this happening again</h2>${list(method.stop)}` : ''}
        <p class="muted">Write down what went wrong and what you did about it in the <a href="#/safety/diary">diary</a>.</p>
      </section>` : ''}
      ${manage ? `<div class="sfbb-actions">
        <button class="btn" type="submit" data-act="save">Save answers</button>
        ${saved?.completed_at && !saved.not_relevant ? '<button class="btn" type="submit" data-act="unsign">Take off sign-off</button>' : '<button class="btn btn-primary" type="submit" data-act="sign">Save and sign off</button>'}
        <button class="btn btn-ghost" type="submit" data-act="na">${saved?.not_relevant ? 'It is relevant after all' : 'Not relevant to this site'}</button>
      </div>` : ''}
    </form>
    <nav class="sfbb-pager">
      ${prev ? `<a class="btn btn-ghost" href="#/safety/sfbb/${prev.key}">‹ ${esc(prev.title)}</a>` : '<span></span>'}
      ${next ? `<a class="btn btn-ghost" href="#/safety/sfbb/${next.key}">${esc(next.title)} ›</a>` : ''}
    </nav>
    ${credit}`;
  showTab(el);

  el.querySelector('#add-checks')?.addEventListener('click', async () => {
    try {
      const r = await api('/sfbb/checks', { method: 'POST', body: { location_id: state.locationId } });
      toast(`${r.added} check${r.added === 1 ? '' : 's'} added to Food Safety Checks`);
      ctx.rerender();
    } catch (err) { showError(err); }
  });

  const form = el.querySelector('#sfbb-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const act = e.submitter?.dataset.act ?? 'save';
    const out = {};
    method.questions.forEach((_, i) => {
      out[i] = { answer: form.querySelector(`[name="q${i}"]:checked`)?.value ?? null, note: form.elements[`n${i}`]?.value.trim() || null };
    });
    if (act === 'sign') {
      const blank = method.questions.filter(([, kind], i) => (kind === 'yn' ? !out[i].answer : !out[i].note)).length;
      if (blank && !(await confirmDialog(`${blank} question${blank === 1 ? ' hasn’t' : 's haven’t'} been answered. Sign off anyway?`, { confirmLabel: 'Sign off', title: 'Sign off this safe method' }))) return;
    }
    const body = { location_id: state.locationId, answers: out, not_relevant: act === 'na' ? !saved?.not_relevant : false };
    if (act === 'sign') body.complete = true;
    if (act === 'unsign' || (act === 'na' && saved?.not_relevant)) body.complete = false;
    try {
      await api(`/sfbb/methods/${method.key}`, { method: 'PUT', body });
      toast({ sign: 'Signed off', unsign: 'Sign-off taken off', na: saved?.not_relevant ? 'Marked as relevant' : 'Marked as not relevant' }[act] ?? 'Answers saved');
      if (act === 'sign' && next) ctx.navigate(`safety/sfbb/${next.key}`);
      else ctx.rerender();
    } catch (err) { showError(err); }
  });
}

// --- The diary: a week at a time ---

export async function renderDiary(ctx) {
  const { el, state, query, stale } = ctx;
  const ws = weekStart(query.week || todayISO());
  const data = await api(`/sfbb/diary${qs({ location_id: state.locationId, week: ws })}`);
  if (stale()) return;
  const manage = canManage(state);
  const write = canWrite(state);
  const thisWeek = ws === weekStart(todayISO());
  const hasSplit = data.days.some((d) => d.opening.total || d.closing.total);
  const tally = (t, d) => {
    if (!t.total) return '<span class="muted">–</span>';
    const future = d > data.today;
    const tone = future ? '' : t.done === t.total ? 'pill-good' : d === data.today ? 'pill-warn' : 'pill-bad';
    return `<a class="pill ${tone}" href="#/safety/checks${qs({ date: d === data.today ? undefined : d })}">${t.done}/${t.total}</a>`;
  };

  el.innerHTML = `
    ${head(state, 'Food safety diary', `
      <button class="btn" data-week="-7" aria-label="Previous week">‹</button>
      <span class="sfbb-week">w/c ${fmtDate(ws, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
      <button class="btn" data-week="7" ${thisWeek ? 'disabled' : ''} aria-label="Next week">›</button>`)}
    ${sfbbTabs(state, 'safety/diary')}
    <p class="muted">Sign the diary every day to say the opening and closing checks were done and your safe methods were followed. If anything different happens or something goes wrong, write down what happened and what you did.</p>
    <section class="card sfbb-diary">
      ${data.days.map((d) => {
        const future = d.date > data.today;
        return `<article class="sfbb-day ${future ? 'is-future' : ''} ${d.date === data.today ? 'is-today' : ''}">
          <header><strong>${fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'short' })}</strong>
            ${d.signed_at ? `<span class="sfbb-signed">✓ Signed by ${esc(d.signed_by_name ?? '')}${manage ? ` <button class="btn btn-small btn-ghost" data-unsign="${d.date}">Undo</button>` : ''}</span>`
              : future ? '' : manage ? `<button class="btn btn-small btn-primary" data-sign="${d.date}">Sign</button>` : '<span class="pill pill-warn">Not signed</span>'}
          </header>
          ${future ? '' : `<div class="sfbb-day-checks">
            ${hasSplit ? `<span>Opening checks ${tally(d.opening, d.date)}</span><span>Closing checks ${tally(d.closing, d.date)}</span>` : `<span>Checks ${tally(d.all, d.date)}</span>`}
          </div>`}
          ${d.problems.length ? `<ul class="sfbb-problems">${d.problems.map((p) => `<li><strong>${esc(p.title)}${p.reading !== null ? ` (${p.reading})` : ''}:</strong> ${esc(p.corrective_action ?? '')}${p.by ? ` <span class="muted">– ${esc(p.by)}</span>` : ''}</li>`).join('')}</ul>` : ''}
          ${d.notes ? `<p class="sfbb-note-text">${esc(d.notes)}</p>` : ''}
          ${write && !future ? `<button class="btn btn-small btn-ghost" data-note="${d.date}">${d.notes ? 'Edit note' : '+ Problems or changes – what did you do?'}</button>` : ''}
        </article>`;
      }).join('')}
    </section>
    <section class="card">
      <header class="card-head"><h2>Extra checks this week</h2>${data.extra_checks_by ? `<small class="muted">Last updated by ${esc(data.extra_checks_by)}</small>` : ''}</header>
      <p class="muted">Less frequent checks, e.g. deep clean, maintenance, dishwasher, probe check, pest control. <a href="#/safety/sfbb/extra-checks">What to check</a></p>
      ${write ? `<form id="extra">${textarea('extra_checks', data.extra_checks, 'rows="3" placeholder="What did you check, and what did you find?"')}<button class="btn" type="submit">Save</button></form>`
        : `<p>${esc(data.extra_checks ?? 'None recorded.')}</p>`}
    </section>
    ${credit}`;
  showTab(el);

  el.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => {
    const w = addDays(ws, Number(b.dataset.week));
    ctx.navigate(`safety/diary${w === weekStart(todayISO()) ? '' : `?week=${w}`}`);
  }));
  const day = (date) => data.days.find((d) => d.date === date);
  el.querySelectorAll('[data-sign]').forEach((b) => b.addEventListener('click', async () => {
    const d = day(b.dataset.sign);
    const missing = (hasSplit ? d.opening.total + d.closing.total - d.opening.done - d.closing.done : d.all.total - d.all.done);
    const msg = `${missing > 0 ? `${missing} of the day’s opening and closing checks ${missing === 1 ? 'isn’t' : 'aren’t'} recorded yet. ` : ''}By signing you confirm: “Our safe methods were followed and effectively supervised today.”`;
    if (!(await confirmDialog(msg, { title: `Sign the diary for ${fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'short' })}`, confirmLabel: 'Sign' }))) return;
    try {
      await api(`/sfbb/diary/${d.date}/sign`, { method: 'POST', body: { location_id: state.locationId } });
      toast('Diary signed');
      ctx.rerender();
    } catch (err) { showError(err); }
  }));
  el.querySelectorAll('[data-unsign]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/sfbb/diary/${b.dataset.unsign}/sign`, { method: 'POST', body: { location_id: state.locationId, signed: false } });
      ctx.rerender();
    } catch (err) { showError(err); }
  }));
  el.querySelectorAll('[data-note]').forEach((b) => b.addEventListener('click', () => {
    const d = day(b.dataset.note);
    openModal({
      title: `Diary · ${fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'short' })}`,
      body: field('Any problems or changes – what did you do?', textarea('notes', d.notes, 'rows="5" placeholder="e.g. Fridge 2 at 9°C at opening – moved food to fridge 1 and called the engineer"')),
      onSubmit: async (v) => {
        await api(`/sfbb/diary/${d.date}`, { method: 'PUT', body: { location_id: state.locationId, notes: v.notes } });
        toast('Diary updated');
        ctx.rerender();
      },
    });
  }));
  el.querySelector('#extra')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/sfbb/weeks/${ws}`, { method: 'PUT', body: { location_id: state.locationId, extra_checks: e.target.extra_checks.value } });
      toast('Extra checks saved');
    } catch (err) { showError(err); }
  });
}

// --- The 4-weekly review ---

const yesNo = (name, value, attrs = '') => `<span class="sfbb-yn">
  <label><input type="radio" name="${name}" value="yes" ${value === 'yes' ? 'checked' : ''} ${attrs}> Yes</label>
  <label><input type="radio" name="${name}" value="no" ${value === 'no' ? 'checked' : ''} ${attrs}> No</label></span>`;

export async function renderReview(ctx) {
  const { el, state, stale } = ctx;
  const data = await api(`/sfbb/reviews${qs({ location_id: state.locationId })}`);
  if (stale()) return;
  const last = data.reviews[0];
  const due = last ? addDays(last.date, 28) : todayISO();
  const repeated = data.repeats.filter((r) => r.times >= 3);

  el.innerHTML = `
    ${head(state, '4-weekly review', canManage(state) ? '<button class="btn btn-primary" id="new-review">Do the review</button>' : '')}
    ${sfbbTabs(state, 'safety/review')}
    <p class="${due <= todayISO() ? 'notice' : 'muted'}">${last ? `Last done ${fmtWhen(last.date)} by ${esc(last.signed_by_name ?? '')}. ${due <= todayISO() ? 'The next one is due now.' : `Next one due by ${fmtWhen(due)}.`}` : 'Not done yet at this site.'}
      Walk around the kitchen to see whether safe methods are being followed, and look back over the last 4 weeks. It needs doing even if nothing went wrong.</p>
    <section class="card">
      <h2>The last 4 weeks at a glance</h2>
      <ul class="sfbb-alerts">
        <li class="${repeated.length ? 'is-bad' : 'is-good'}">${repeated.length ? `Went wrong three times or more: ${repeated.map((r) => `${esc(r.title)} (${r.times}×)`).join(', ')}` : 'Nothing went wrong three times or more'}</li>
        <li class="${data.unsigned_days ? 'is-bad' : 'is-good'}">${data.unsigned_days ? `Diary not signed on ${data.unsigned_days} day${data.unsigned_days === 1 ? '' : 's'}` : 'Diary signed every day'}</li>
      </ul>
      ${data.repeats.length ? `<h3 class="group-title">Failed checks</h3><ul class="sfbb-list">${data.repeats.map((r) => `<li>${esc(r.title)} – ${r.times}×</li>`).join('')}</ul>` : ''}
      ${data.notes.length ? `<h3 class="group-title">Diary notes</h3><ul class="sfbb-list">${data.notes.map((n) => `<li><strong>${fmtDate(n.date)}:</strong> ${esc(n.notes)}</li>`).join('')}</ul>` : ''}
    </section>
    <section class="card">
      <h2>Past reviews</h2>
      ${data.reviews.length ? data.reviews.map((r) => `<details class="sfbb-review">
        <summary><strong>${fmtWhen(r.date)}</strong> · ${esc(r.signed_by_name ?? '')} · ${r.problems ? '<span class="pill pill-warn">Problems found</span>' : '<span class="pill pill-good">No problems</span>'}</summary>
        ${r.details ? `<p><strong>Details:</strong> ${esc(r.details)}</p>` : ''}
        ${r.action ? `<p><strong>What we did:</strong> ${esc(r.action)}</p>` : ''}
        <ul class="sfbb-review-checks">${SFBB_REVIEW_CHECKS.map((q, i) => `<li><span>${esc(q)}</span><strong class="${r.checklist[i] === 'no' ? 'is-no' : ''}">${r.checklist[i] === 'yes' ? 'Yes' : r.checklist[i] === 'no' ? 'No' : '–'}</strong></li>`).join('')}</ul>
        ${r.additional ? `<p><strong>Additional details:</strong> ${esc(r.additional)}</p>` : ''}
      </details>`).join('') : '<p class="muted">None yet.</p>'}
    </section>
    ${credit}`;
  showTab(el);

  el.querySelector('#new-review')?.addEventListener('click', () => openModal({
    title: '4-weekly review',
    wide: true,
    submitLabel: 'Sign and save',
    body: `
      <p><strong>Did you observe any problems, or did the same issue occur in the diary three times or more?</strong></p>
      ${yesNo('problems', repeated.length ? 'yes' : null, 'required')}
      ${field('Details', textarea('details', repeated.map((r) => `${r.title} failed ${r.times} times`).join('\n'), 'rows="3"'))}
      ${field('What did you do about it?', textarea('action', '', 'rows="3"'))}
      <h3 class="group-title">Safe method check list</h3>
      <ul class="sfbb-review-checks">${SFBB_REVIEW_CHECKS.map((q, i) => `<li><span>${esc(q)}</span>${yesNo(`c${i}`, null)}</li>`).join('')}</ul>
      ${field('Additional details', textarea('additional', '', 'rows="2"'))}
      <p class="muted small">Saving signs the review in your name.</p>`,
    onSubmit: async (v, form) => {
      const checklist = {};
      SFBB_REVIEW_CHECKS.forEach((_, i) => { checklist[i] = form.querySelector(`[name="c${i}"]:checked`)?.value ?? null; });
      const problems = form.querySelector('[name="problems"]:checked')?.value;
      if (!problems) throw new Error('Say whether you found any problems');
      await api('/sfbb/reviews', { method: 'POST', body: { location_id: state.locationId, problems: problems === 'yes', details: v.details, action: v.action, additional: v.additional, checklist } });
      toast('Review saved');
      ctx.rerender();
    },
  }));
}

// --- Staff training record ---

const TOPIC_TITLES = new Map([...SFBB_TRAINING_EXTRAS, ...SFBB_METHODS.map((m) => [m.key, m.title])]);

export async function renderTraining(ctx) {
  const { el, state, stale } = ctx;
  const data = await api(`/sfbb/training${qs({ location_id: state.locationId })}`);
  if (stale()) return;
  const manage = canManage(state);
  const byPerson = new Map(data.people.map((p) => [p.id, data.records.filter((r) => r.user_id === p.id)]));
  const has = (recs, topic) => recs.some((r) => r.topic === topic);
  const tick = (ok) => (ok ? '<span class="sfbb-tick">✓</span>' : '<span class="muted">–</span>');

  el.innerHTML = `
    ${head(state, 'Staff training record', manage ? '<button class="btn btn-primary" id="record">Record training</button>' : '')}
    ${sfbbTabs(state, 'safety/training')}
    <p class="muted">Train each person on the safe methods for the work they do: show them, question them, then ask them to show you. Record it here every time.</p>
    <section class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>First day</th><th>Safe methods</th><th>Level 2</th><th>Allergen awareness</th><th>Last trained</th><th></th></tr></thead>
        <tbody>${data.people.map((p) => {
          const recs = byPerson.get(p.id);
          const methods = new Set(recs.filter((r) => methodByKey(r.topic)).map((r) => r.topic)).size;
          return `<tr><th>${esc(p.name)}</th>
            <td>${tick(has(recs, 'factsheet') && has(recs, 'opening-closing'))}</td>
            <td>${methods} of ${SFBB_METHODS.length}</td>
            <td>${tick(has(recs, 'level2'))}</td><td>${tick(has(recs, 'allergen-awareness'))}</td>
            <td>${recs[0] ? fmtWhen(recs[0].date) : '<span class="muted">Never</span>'}</td>
            <td><button class="btn btn-small btn-ghost" data-person="${p.id}">View</button></td></tr>`;
        }).join('')}</tbody>
      </table></div>
      ${data.people.length ? '' : '<p class="muted">Nobody works at this site yet.</p>'}
    </section>
    <section class="card">
      <h2>Working with food? – for every new starter</h2>
      <div class="sfbb-factsheet">
        <div><h3>Before you start working with food</h3>${list(SFBB_FACTSHEET.before)}</div>
        <div><h3>When you are working with food</h3>${list(SFBB_FACTSHEET.during)}</div>
      </div>
      <p class="muted">On their first day, also go through the <a href="#/safety/sfbb/opening-closing">opening and closing checks</a> and <a href="#/safety/sfbb/handwashing">handwashing</a>.</p>
    </section>
    ${credit}`;
  showTab(el);

  const topicBoxes = `<div class="sfbb-topics">
    <fieldset><legend>First day and other training</legend>${[...SFBB_TRAINING_EXTRAS, ['opening-closing', 'Opening and closing checks']].map(([k, l]) => `<label><input type="checkbox" name="t:${k}"> ${esc(l)}</label>`).join('')}</fieldset>
    ${SFBB_SECTIONS.map((s) => `<fieldset><legend>${esc(s.title)}</legend>${s.methods.filter((m) => m.key !== 'opening-closing').map((m) => `<label><input type="checkbox" name="t:${m.key}"> ${esc(m.title)}</label>`).join('')}</fieldset>`).join('')}
  </div>`;

  el.querySelector('#record')?.addEventListener('click', () => openModal({
    title: 'Record training',
    wide: true,
    body: `
      ${field('Date', input('date', todayISO(), `type="date" max="${todayISO()}" required`))}
      <fieldset class="sfbb-people"><legend>Who was trained</legend>${data.people.map((p) => `<label><input type="checkbox" name="p:${p.id}"> ${esc(p.name)}</label>`).join('')}</fieldset>
      <p><strong>What on</strong></p>${topicBoxes}`,
    onSubmit: async (v) => {
      const userIds = Object.keys(v).filter((k) => k.startsWith('p:') && v[k]).map((k) => Number(k.slice(2)));
      const topics = Object.keys(v).filter((k) => k.startsWith('t:') && v[k]).map((k) => k.slice(2));
      if (!userIds.length) throw new Error('Tick who was trained');
      if (!topics.length) throw new Error('Tick what they were trained on');
      await api('/sfbb/training', { method: 'POST', body: { location_id: state.locationId, user_ids: userIds, topics, date: v.date } });
      toast('Training recorded');
      ctx.rerender();
    },
  }));

  el.querySelectorAll('[data-person]').forEach((b) => b.addEventListener('click', () => {
    const p = data.people.find((x) => x.id === Number(b.dataset.person));
    const recs = byPerson.get(p.id);
    const latest = new Map();
    for (const r of recs) if (!latest.has(r.topic)) latest.set(r.topic, r);
    const row = ([k, l]) => {
      const r = latest.get(k);
      return `<li><span>${esc(l)}</span>${r ? `<span>${fmtWhen(r.date)}${manage ? ` <button type="button" class="btn btn-small btn-ghost" data-del="${r.id}" aria-label="Remove">✕</button>` : ''}</span>` : '<span class="muted">Not yet</span>'}</li>`;
    };
    openModal({
      title: `${p.name} · training`,
      wide: true,
      body: `<ul class="sfbb-review-checks">${[...SFBB_TRAINING_EXTRAS, ...SFBB_METHODS.map((m) => [m.key, m.title])].map(row).join('')}</ul>`,
    });
    document.querySelectorAll('.modal [data-del]').forEach((x) => x.addEventListener('click', async () => {
      try {
        await api(`/sfbb/training/${x.dataset.del}`, { method: 'DELETE' });
        x.closest('li').querySelector('span:last-child').innerHTML = '<span class="muted">Removed</span>';
        ctx.rerender();
      } catch (err) { showError(err); }
    }));
  }));
}

// --- Records kept with the pack: cleaning schedule, 'Prove it' checks, contacts ---

const RECORD_TABS = [['cleaning', 'Cleaning schedule'], ['prove-it', 'Prove it'], ['contacts', 'Contacts']];

export async function renderRecords(ctx) {
  const { el, state, query, stale } = ctx;
  const tab = RECORD_TABS.some(([k]) => k === query.tab) ? query.tab : 'cleaning';
  const data = await api(`/sfbb/records${qs({ location_id: state.locationId })}`);
  if (stale()) return;
  const manage = canManage(state);
  const methodOptions = SFBB_METHODS.map((m) => [m.key, m.title]);
  const save = async (path, row, body) => {
    await api(`/sfbb/${path}${row ? `/${row.id}` : ''}`, { method: row ? 'PUT' : 'POST', body: { location_id: state.locationId, ...body } });
    toast('Saved');
    ctx.rerender();
  };

  const body = {
    cleaning: () => `
      <p class="muted">Everything that needs cleaning, how and how often. Concentrate disinfecting on things that touch food and things people touch a lot. Print it and put it on the wall.</p>
      ${data.cleaning.length ? `<div class="table-wrap"><table class="sfbb-table">
        <thead><tr><th>Item</th><th>How often</th><th>Precautions</th><th>Method of cleaning</th>${manage ? '<th></th>' : ''}</tr></thead>
        <tbody>${data.cleaning.map((c) => `<tr><th>${esc(c.item)}</th><td>${esc(c.frequency)}</td><td>${esc(c.precautions ?? '')}</td><td class="sfbb-method">${esc(c.method ?? '')}</td>
          ${manage ? `<td><button class="btn btn-small btn-ghost" data-edit="${c.id}">Edit</button></td>` : ''}</tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty">No cleaning schedule yet.${manage ? ' <button class="btn" data-starter="cleaning">Start with a suggested schedule</button>' : ''}</div>`}`,
    'prove-it': () => `
      <p class="muted">Use a clean, disinfected probe to prove your methods are safe – especially if you do something differently from the pack. See <a href="#/safety/sfbb/prove-it">Prove it</a>.</p>
      ${data.prove_it.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Safe method</th><th>How did you prove it?</th><th>By</th>${manage ? '<th></th>' : ''}</tr></thead>
        <tbody>${data.prove_it.map((p) => `<tr><td>${fmtWhen(p.date)}</td><td>${esc(methodByKey(p.method_key)?.title ?? p.method_key)}</td><td>${esc(p.how)}</td><td>${esc(p.recorded_by_name ?? '')}</td>
          ${manage ? `<td><button class="btn btn-small btn-ghost" data-edit="${p.id}">Edit</button></td>` : ''}</tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">Nothing recorded yet.</div>'}`,
    contacts: () => `
      <p class="muted">People you might need day to day or in an emergency.${state.can('orders.manage') || state.can('setup.products') ? ' Your suppliers are under <a href="#/admin/suppliers">Suppliers</a>.' : ''}</p>
      ${data.contacts.length ? `<div class="sfbb-contacts">${data.contacts.map((c) => `<article class="card">
        <header class="card-head"><h3>${esc(c.role)}</h3>${manage ? `<button class="btn btn-small btn-ghost" data-edit="${c.id}">Edit</button>` : ''}</header>
        ${c.name ? `<p><strong>${esc(c.name)}</strong></p>` : '<p class="muted">Not filled in yet</p>'}
        ${c.phone ? `<p><a href="tel:${esc(c.phone.replace(/\s/g, ''))}">${esc(c.phone)}</a></p>` : ''}
        ${c.email ? `<p><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>` : ''}
        ${c.address ? `<p>${esc(c.address)}</p>` : ''}
        ${c.notes ? `<p class="muted">${esc(c.notes)}</p>` : ''}
      </article>`).join('')}</div>` : `<div class="empty">No contacts yet.${manage ? ' <button class="btn" data-starter="contacts">Start with the usual list</button>' : ''}</div>`}`,
  };
  const addLabel = { cleaning: '+ Item', 'prove-it': '+ Record a check', contacts: '+ Contact' }[tab];
  const canAdd = tab === 'prove-it' ? canWrite(state) : manage;

  el.innerHTML = `
    ${head(state, 'Food safety records', `${canAdd ? `<button class="btn btn-primary" id="add">${addLabel}</button>` : ''}${tab === 'cleaning' ? '<button class="btn" id="print">Print</button>' : ''}`)}
    ${sfbbTabs(state, 'safety/records')}
    <div class="tabs sub-tabs">${RECORD_TABS.map(([k, l]) => `<a href="#/safety/records${k === 'cleaning' ? '' : `?tab=${k}`}" class="${tab === k ? 'active' : ''}">${l}</a>`).join('')}</div>
    <section class="card">${body[tab]()}</section>
    ${credit}`;
  showTab(el);

  el.querySelector('#print')?.addEventListener('click', () => window.print());
  el.querySelectorAll('[data-starter]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/sfbb/starter/${b.dataset.starter}`, { method: 'POST', body: { location_id: state.locationId } });
      ctx.rerender();
    } catch (err) { showError(err); }
  }));

  const rows = { cleaning: data.cleaning, 'prove-it': data.prove_it, contacts: data.contacts }[tab];
  const remove = (row) => async () => {
    if (!(await confirmDialog('Delete this?', { confirmLabel: 'Delete' }))) return;
    await api(`/sfbb/${tab}/${row.id}`, { method: 'DELETE' });
    ctx.rerender();
  };
  const edit = (row) => {
    const forms = {
      cleaning: () => ({
        title: row ? 'Change cleaning item' : 'Add to the cleaning schedule',
        body: `${field('Item or area', input('item', row?.item, 'required placeholder="e.g. Slicer"'))}
          ${field('How often', select('frequency', data.frequencies.map((f) => [f, f]), row?.frequency ?? 'Daily'))}
          ${field('Precautions', input('precautions', row?.precautions, 'placeholder="e.g. Wear gloves, unplug first"'))}
          ${field('Method of cleaning', textarea('method', row?.method, 'rows="5" placeholder="Step by step, including the chemicals and equipment to use"'))}`,
        onSubmit: (v) => save('cleaning', row, { ...v, sort_order: row?.sort_order ?? data.cleaning.length }),
      }),
      'prove-it': () => ({
        title: row ? 'Change Prove it record' : 'Record a Prove it check',
        body: `${field('Safe method', select('method_key', methodOptions, row?.method_key ?? 'cooking-safely'))}
          ${field('How did you prove it?', textarea('how', row?.how, 'required rows="3" placeholder="e.g. Beef burger probed at 12:35 – 82.7°C"'))}
          ${field('Date', input('date', row?.date ?? todayISO(), `type="date" max="${todayISO()}"`))}`,
        onSubmit: (v) => save('prove-it', row, v),
      }),
      contacts: () => ({
        title: row ? 'Change contact' : 'Add a contact',
        body: `${field('Who they are', input('role', row?.role, 'required placeholder="e.g. Pest control contractor"'))}
          ${field('Name or company', input('name', row?.name))}
          ${field('Telephone', input('phone', row?.phone, 'type="tel"'))}
          ${field('Email', input('email', row?.email, 'type="email"'))}
          ${field('Address', textarea('address', row?.address, 'rows="2"'))}
          ${field('Notes', textarea('notes', row?.notes, 'rows="2" placeholder="e.g. useful for advice on…"'))}`,
        onSubmit: (v) => save('contacts', row, v),
      }),
    };
    openModal({ ...forms[tab](), ...(row && manage ? { danger: 'Delete', onDanger: remove(row) } : {}) });
  };
  el.querySelector('#add')?.addEventListener('click', () => edit(null));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(rows.find((r) => r.id === Number(b.dataset.edit)))));
}

// --- The whole pack for a site as one document, to save as a PDF or print ---

export async function renderDownload(ctx) {
  const { el, state, query, stale } = ctx;
  const withDiary = query.diary !== '0';
  const loc = state.location ?? {};
  const weeks = [0, 1, 2, 3].map((n) => addDays(weekStart(todayISO()), -7 * n)).reverse();
  const [pack, records, training, reviews, checklist, suppliers, ...diary] = await Promise.all([
    api(`/sfbb/pack${qs({ location_id: state.locationId })}`),
    api(`/sfbb/records${qs({ location_id: state.locationId })}`),
    api(`/sfbb/training${qs({ location_id: state.locationId })}`),
    api(`/sfbb/reviews${qs({ location_id: state.locationId })}`),
    api(`/safety/checklist${qs({ location_id: state.locationId })}`),
    api('/suppliers').catch(() => []),
    ...(withDiary ? weeks.map((w) => api(`/sfbb/diary${qs({ location_id: state.locationId, week: w })}`)) : []),
  ]);
  if (stale()) return;
  const m = pack.methods;
  const daily = checklist.tasks.filter((t) => t.frequency === 'daily');
  const opening = daily.filter((t) => /open/i.test(t.category));
  const closing = daily.filter((t) => /clos/i.test(t.category));
  const otherDaily = daily.filter((t) => !opening.includes(t) && !closing.includes(t));
  const weekly = checklist.tasks.filter((t) => t.frequency === 'weekly');
  const range = (t) => (t.requires_reading ? ` (${[t.min_value !== null ? `${t.min_value}${t.reading_unit ?? ''} or above` : null, t.max_value !== null ? `${t.max_value}${t.reading_unit ?? ''} or below` : null].filter(Boolean).join(', ')})` : '');
  const checkList = (title, tasks) => (tasks.length ? `<h3>${esc(title)}</h3><ul class="doc-ticks">${tasks.map((t) => `<li>${esc(t.title)}${esc(range(t))}</li>`).join('')}</ul>` : '');
  const answer = (q, i, a) => {
    if (!a || (!a.answer && !a.note)) return '<em class="doc-blank">Not answered</em>';
    return `${a.answer ? `<strong>${a.answer === 'yes' ? 'Yes' : 'No'}</strong>` : ''}${a.answer && a.note ? ' – ' : ''}${esc(a.note ?? '')}`;
  };
  const relevant = SFBB_METHODS.filter((x) => !m[x.key]?.not_relevant);
  const done = relevant.filter((x) => m[x.key]?.completed_at).length;
  const latest = new Map();
  for (const r of training.records) if (!latest.has(`${r.user_id}:${r.topic}`)) latest.set(`${r.user_id}:${r.topic}`, r);
  const topics = [...SFBB_TRAINING_EXTRAS, ...SFBB_METHODS.map((x) => [x.key, x.title])];
  const title = `Safer Food Better Business – ${loc.name ?? 'site'} – ${todayISO()}`;

  el.innerHTML = `
    <div class="sfbb-doc-bar">
      <p><a href="#/safety/sfbb">‹ Back to safe methods</a></p>
      <h1>Download the pack · ${esc(loc.name ?? '')}</h1>
      <p>Everything for this site in one document: the safe methods with your answers, the completion record, checks, ${withDiary ? 'the last 4 weeks of the diary, ' : ''}reviews, training and records.</p>
      <div class="actions sfbb-doc-actions">
        ${sitePicker(state)}
        <label class="sfbb-doc-opt"><input type="checkbox" id="with-diary" ${withDiary ? 'checked' : ''}> Include the last 4 weeks of the diary</label>
        <button class="btn btn-primary" id="save-pdf">⬇ Download as PDF</button>
      </div>
      <p class="muted small">In the window that opens, choose <strong>Save as PDF</strong> as the printer (on an iPhone, tap Share → Save to Files). Or pick a printer to print it.</p>
    </div>
    <article class="sfbb-doc">
      <section class="doc-cover">
        <p class="doc-kicker">Safer Food, Better Business for caterers</p>
        <h1>${esc(loc.name ?? '')}</h1>
        ${loc.address ? `<p>${esc(loc.address)}</p>` : ''}
        <table class="doc-table doc-facts"><tbody>
          <tr><th>Produced</th><td>${fmtWhen(todayISO())} by ${esc(state.user?.name ?? '')}</td></tr>
          <tr><th>Safe methods</th><td>${done} of ${relevant.length} worked through${SFBB_METHODS.length - relevant.length ? ` (${SFBB_METHODS.length - relevant.length} not relevant)` : ''}</td></tr>
          <tr><th>Last 4-weekly review</th><td>${pack.last_review ? `${fmtWhen(pack.last_review.date)} by ${esc(pack.last_review.signed_by_name ?? '')}` : 'Not done yet'}</td></tr>
        </tbody></table>
        <h2>Contents</h2>
        <ol class="doc-contents">
          <li>Safe method completion record</li>
          ${SFBB_SECTIONS.map((s) => `<li>${esc(s.title)}</li>`).join('')}
          <li>Opening, closing and extra checks</li>
          ${withDiary ? '<li>Diary – the last 4 weeks</li>' : ''}
          <li>4-weekly reviews</li><li>Staff training record</li><li>Suppliers’ list and contacts</li><li>Cleaning schedule</li><li>Prove it records</li>
        </ol>
        <p class="doc-credit">${esc(SFBB_CREDIT)}</p>
      </section>

      <section class="doc-page">
        <h2>Safe method completion record</h2>
        <table class="doc-table"><thead><tr><th>Safe method</th><th>Date</th><th>Signed by</th><th>Not relevant</th></tr></thead>
          <tbody>${SFBB_SECTIONS.map((s) => `<tr class="doc-group"><th colspan="4">${esc(s.title)}</th></tr>${s.methods.map((x) => {
            const r = m[x.key];
            return `<tr><td>${esc(x.title)}</td><td>${r?.completed_at && !r.not_relevant ? fmtWhen(r.completed_at) : ''}</td><td>${r?.completed_at ? esc(r.completed_by_name ?? '') : ''}</td><td>${r?.not_relevant ? '✓' : ''}</td></tr>`;
          }).join('')}`).join('')}</tbody></table>
      </section>

      ${SFBB_SECTIONS.map((s) => `<section class="doc-page">
        <h2>${esc(s.title)}</h2>
        <p class="doc-lead">${esc(s.intro)}</p>
        ${s.methods.map((x) => {
          const r = m[x.key];
          if (r?.not_relevant) return `<div class="doc-method"><h3>${esc(x.title)}</h3><p><em>Not relevant to this site${r.completed_by_name ? ` (${esc(r.completed_by_name)}, ${fmtWhen(r.completed_at)})` : ''}.</em></p></div>`;
          return `<div class="doc-method">
            <h3>${esc(x.title)}</h3>
            <p class="doc-lead">${esc(x.intro)}</p>
            ${x.points.length ? `<table class="doc-table"><thead><tr><th>What to do</th>${x.points.some(([, w]) => w) ? '<th>Why</th>' : ''}</tr></thead>
              <tbody>${x.points.map(([what, why]) => `<tr><td>${esc(what)}</td>${x.points.some(([, w]) => w) ? `<td>${esc(why)}</td>` : ''}</tr>`).join('')}</tbody></table>` : ''}
            ${(x.notes ?? []).map(([h, t]) => `<p class="doc-box"><strong>${esc(h)}:</strong> ${esc(t)}</p>`).join('')}
            ${x.checks ? `${checkList('Opening checks', opening)}${checkList('Closing checks', closing)}` : ''}
            ${x.questions.length ? `<h4>How do you do this?</h4><table class="doc-table doc-qa"><tbody>${x.questions.map(([q], i) => `<tr><th>${esc(q)}</th><td>${answer(q, i, r?.answers?.[i])}</td></tr>`).join('')}</tbody></table>` : ''}
            ${x.wrong.length ? `<h4>What to do if things go wrong</h4><ul>${x.wrong.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
            ${x.stop.length ? `<h4>How to stop this happening again</h4><ul>${x.stop.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
            <p class="doc-sign">${r?.completed_at ? `Signed off by ${esc(r.completed_by_name ?? '')} on ${fmtWhen(r.completed_at)}` : 'Not signed off yet'}</p>
          </div>`;
        }).join('')}
      </section>`).join('')}

      <section class="doc-page">
        <h2>Opening, closing and extra checks</h2>
        <p class="doc-lead">The checks done at this site, recorded each day in Atlas’s Food Safety Checks.</p>
        ${checkList('Opening checks', opening)}${checkList('During the day', otherDaily)}${checkList('Closing checks', closing)}${checkList('Weekly (extra) checks', weekly)}
      </section>

      ${withDiary ? `<section class="doc-page">
        <h2>Diary – the last 4 weeks</h2>
        ${diary.map((w) => `<h3>Week commencing ${fmtWhen(w.week_start)}</h3>
          <table class="doc-table doc-diary"><thead><tr><th>Day</th><th>Opening</th><th>Closing</th><th>Any problems or changes – what did you do?</th><th>Signed</th></tr></thead>
          <tbody>${w.days.filter((d) => d.date <= w.today).map((d) => `<tr>
            <td>${fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
            <td>${d.opening.total ? `${d.opening.done}/${d.opening.total}` : '–'}</td><td>${d.closing.total ? `${d.closing.done}/${d.closing.total}` : '–'}</td>
            <td>${[...d.problems.map((p) => `${esc(p.title)}: ${esc(p.corrective_action ?? '')}`), d.notes ? esc(d.notes) : null].filter(Boolean).join('<br>')}</td>
            <td>${d.signed_at ? esc(d.signed_by_name ?? '') : '<em class="doc-blank">Not signed</em>'}</td></tr>`).join('')}</tbody></table>
          <p class="doc-box"><strong>Extra checks:</strong> ${esc(w.extra_checks ?? 'None recorded')}</p>`).join('')}
        <p class="muted">Signing confirms: “Our safe methods were followed and effectively supervised today.”</p>
      </section>` : ''}

      <section class="doc-page">
        <h2>4-weekly reviews</h2>
        ${reviews.reviews.length ? reviews.reviews.slice(0, 6).map((r) => `<div class="doc-method">
          <h3>${fmtWhen(r.date)} – ${esc(r.signed_by_name ?? '')}</h3>
          <p><strong>Problems observed, or the same issue three times or more:</strong> ${r.problems ? 'Yes' : 'No'}</p>
          ${r.details ? `<p><strong>Details:</strong> ${esc(r.details)}</p>` : ''}
          ${r.action ? `<p><strong>What we did about it:</strong> ${esc(r.action)}</p>` : ''}
          <table class="doc-table doc-qa"><tbody>${SFBB_REVIEW_CHECKS.map((q, i) => `<tr><th>${esc(q)}</th><td>${r.checklist[i] === 'yes' ? 'Yes' : r.checklist[i] === 'no' ? 'No' : '–'}</td></tr>`).join('')}</tbody></table>
          ${r.additional ? `<p><strong>Additional details:</strong> ${esc(r.additional)}</p>` : ''}
        </div>`).join('') : '<p><em class="doc-blank">No reviews yet.</em></p>'}
      </section>

      <section class="doc-page">
        <h2>Staff training record</h2>
        ${training.people.map((p) => {
          const rows = topics.map(([k, l]) => [l, latest.get(`${p.id}:${k}`)]).filter(([, r]) => r);
          return `<div class="doc-method"><h3>${esc(p.name)}</h3>${rows.length ? `<table class="doc-table"><thead><tr><th>Safe method or training</th><th>Date</th><th>Recorded by</th></tr></thead>
            <tbody>${rows.map(([l, r]) => `<tr><td>${esc(l)}</td><td>${fmtWhen(r.date)}</td><td>${esc(r.recorded_by_name ?? '')}</td></tr>`).join('')}</tbody></table>` : '<p><em class="doc-blank">No training recorded yet.</em></p>'}</div>`;
        }).join('') || '<p><em class="doc-blank">Nobody works at this site yet.</em></p>'}
      </section>

      <section class="doc-page">
        <h2>Suppliers’ list</h2>
        ${suppliers.length ? `<table class="doc-table"><thead><tr><th>Business</th><th>Contact</th><th>Telephone</th><th>Email</th><th>Ordering</th></tr></thead>
          <tbody>${suppliers.filter((x) => x.active !== 0).map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.contact_name ?? '')}</td><td>${esc(x.phone ?? '')}</td><td>${esc(x.email ?? '')}</td><td>${esc([x.order_days, x.lead_time_days ? `${x.lead_time_days} day${x.lead_time_days === 1 ? '' : 's'} lead time` : null].filter(Boolean).join(' · '))}</td></tr>`).join('')}</tbody></table>`
          : '<p><em class="doc-blank">No suppliers recorded.</em></p>'}
        <h2>Contacts</h2>
        ${records.contacts.length ? `<table class="doc-table"><thead><tr><th>Who</th><th>Name</th><th>Telephone</th><th>Email</th><th>Notes</th></tr></thead>
          <tbody>${records.contacts.map((c) => `<tr><td>${esc(c.role)}</td><td>${esc(c.name ?? '')}</td><td>${esc(c.phone ?? '')}</td><td>${esc(c.email ?? '')}</td><td>${esc([c.address, c.notes].filter(Boolean).join(' · '))}</td></tr>`).join('')}</tbody></table>`
          : '<p><em class="doc-blank">No contacts recorded.</em></p>'}
      </section>

      <section class="doc-page">
        <h2>Cleaning schedule</h2>
        ${records.cleaning.length ? `<table class="doc-table"><thead><tr><th>Item</th><th>How often</th><th>Precautions</th><th>Method of cleaning</th></tr></thead>
          <tbody>${records.cleaning.map((c) => `<tr><td>${esc(c.item)}</td><td>${esc(c.frequency)}</td><td>${esc(c.precautions ?? '')}</td><td class="sfbb-method">${esc(c.method ?? '')}</td></tr>`).join('')}</tbody></table>`
          : '<p><em class="doc-blank">No cleaning schedule yet.</em></p>'}
        <h2>Prove it records</h2>
        ${records.prove_it.length ? `<table class="doc-table"><thead><tr><th>Date</th><th>Safe method</th><th>How did you prove it?</th><th>By</th></tr></thead>
          <tbody>${records.prove_it.map((p) => `<tr><td>${fmtWhen(p.date)}</td><td>${esc(methodByKey(p.method_key)?.title ?? p.method_key)}</td><td>${esc(p.how)}</td><td>${esc(p.recorded_by_name ?? '')}</td></tr>`).join('')}</tbody></table>`
          : '<p><em class="doc-blank">None recorded yet.</em></p>'}
        <p class="doc-credit">${esc(SFBB_CREDIT)}</p>
      </section>
    </article>`;

  // While this page is open, printing shows just the document (and the PDF is named after the site and date).
  document.body.classList.add('print-doc');
  const leave = () => { document.body.classList.remove('print-doc'); window.removeEventListener('hashchange', leave); };
  window.addEventListener('hashchange', leave);
  el.querySelector('#with-diary').addEventListener('change', (e) => ctx.navigate(`safety/sfbb/download${e.target.checked ? '' : '?diary=0'}`));
  el.querySelector('#save-pdf').addEventListener('click', () => {
    const before = document.title;
    document.title = title;
    window.addEventListener('afterprint', () => { document.title = before; }, { once: true });
    window.print();
  });
}
