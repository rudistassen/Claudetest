import { api, confirmDialog, esc, field, fmtDate, input, isDemo, openModal, showError, textarea, toast, todayISO } from '../lib.js';
import { hydrateMedia, shrinkImage, toBase64 } from './mybrew.js';

// Training courses built in Atlas (People → Learning & development): managers design them from pages and quiz
// questions and give them to people; everyone takes the ones given to them (or open to all) at #/learn.

const MAX_VIDEO_MB = 25;
const day = (d) => fmtDate(d, { day: 'numeric', month: 'short', year: 'numeric' });
const mediaUrl = (id) => `/api/training/media/${id}`;
// The standalone demo has no real server, so pictures are loaded through fetch (see hydrateMedia).
const srcAttr = (id) => (isDemo ? `data-src="${mediaUrl(id)}"` : `src="${mediaUrl(id)}"`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Page text: paragraphs, lines starting "- " as bullet points, **bold**, and web addresses as links.
export function formatLesson(text) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const bullet = /^\s*[-•*]\s+/;
  // Each block (split on blank lines) is paragraphs, with runs of bullet lines as lists.
  return String(text ?? '').trim().split(/\n{2,}/).map((block) => {
    const out = [];
    for (const line of block.split('\n')) {
      const isBullet = bullet.test(line);
      const last = out[out.length - 1];
      if (last && last.list === isBullet) last.lines.push(line);
      else out.push({ list: isBullet, lines: [line] });
    }
    return out.map((g) => (g.list ? `<ul>${g.lines.map((l) => `<li>${inline(l.replace(bullet, ''))}</li>`).join('')}</ul>` : `<p>${g.lines.map(inline).join('<br>')}</p>`)).join('');
  }).join('');
}

const media = (s) => `${s.media_id ? (s.media_kind === 'video'
  ? `<video class="lesson-media" controls playsinline preload="metadata" ${srcAttr(s.media_id)}></video>`
  : `<img class="lesson-media" ${srcAttr(s.media_id)} alt="">`) : ''}
  ${s.video_url ? `<div class="lesson-video"><iframe src="${esc(s.video_url)}" title="Video" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>` : ''}`;

// Where someone is with a course, as a short label and a colour.
export function courseStatus(c) {
  if (c.status === 'done') return ['✓ Done', 'is-done'];
  if (c.status === 'awaiting_signoff') return ['Waiting for sign-off', 'is-wait'];
  if (c.due_on && c.due_on < todayISO()) return [`Overdue · was due ${fmtDate(c.due_on, { day: 'numeric', month: 'short' })}`, 'is-late'];
  if (c.due_on) return [`Due ${fmtDate(c.due_on, { weekday: 'short', day: 'numeric', month: 'short' })}`, 'is-due'];
  if (c.completed_on) return ['Due again', 'is-due'];
  return [c.assigned ? 'To do' : 'Open to everyone', c.assigned ? 'is-due' : 'is-open'];
}

// Deletes a course after checking. Training people have already done is kept on their record.
async function deleteCourse(c) {
  const msg = `Delete “${c.name}”? Staff won’t see it any more${c.assigned ? ` and it comes off the ${plural(c.assigned, 'person').replace('persons', 'people')} it was given to` : ''}. Training people have already done is kept on their record.`;
  if (!(await confirmDialog(msg, { title: 'Delete this course?', confirmLabel: 'Delete course' }))) return false;
  await api(`/training/courses/${c.id}`, { method: 'DELETE' });
  toast('Course deleted');
  return true;
}

// ---- People → Learning & development: the courses, and who's waiting for a sign-off ----

export async function coursesPanel(root, { rerender }) {
  let data;
  try { data = await api('/training/designs'); } catch { root.innerHTML = ''; return; }
  root.classList.add('hip');
  root.innerHTML = `
    ${data.signoffs.length ? `<section class="card course-signoffs">
      <h2>Waiting for your sign-off <span class="badge">${data.signoffs.length}</span></h2>
      <p class="muted small">They’ve passed the course online. Sign it off once you’ve seen them do it in person.</p>
      <ul class="course-signoff-list">${data.signoffs.map((w) => `<li><div><strong>${esc(w.user_name)}</strong> · ${esc(w.course_name)}
        <small class="muted">Passed with ${w.score}% on ${day(w.created_at.slice(0, 10))}</small></div>
        <span class="course-signoff-actions"><button type="button" class="btn btn-small btn-primary" data-signoff="${w.id}">Sign off</button>
        <button type="button" class="btn btn-small" data-sendback="${w.id}">Not yet</button></span></li>`).join('')}</ul>
    </section>` : ''}
    <section class="card course-list-card">
      <div class="card-head"><h2>Online courses</h2><button type="button" class="btn btn-small" id="course-ready">📚 Ready-made courses</button></div>
      <p class="muted small">Build a course from pages and quiz questions, then give it to people or open it to everyone. Passing it records their training here automatically.</p>
      ${data.courses.length ? `<ul class="course-list">${data.courses.map((c) => `<li class="course-row">
        <div class="course-row-main"><strong>${esc(c.name)}</strong>
          <span class="course-tags">${c.published ? '<span class="course-tag is-live">Published</span>' : '<span class="course-tag">Draft</span>'}
            ${c.open_to_all ? '<span class="course-tag">Open to everyone</span>' : ''}${c.needs_signoff ? '<span class="course-tag">Sign-off in person</span>' : ''}</span>
          <small class="muted">${c.pages || c.questions ? `${plural(c.pages, 'page')} · ${plural(c.questions, 'question')}${c.questions ? ` · pass mark ${c.pass_mark}%` : ''}` : 'Nothing in it yet'}${c.assigned ? ` · given to ${plural(c.assigned, 'person').replace('persons', 'people')}` : ''}</small></div>
        <span class="course-row-actions"><a class="btn btn-small ${c.pages || c.questions ? '' : 'btn-primary'}" href="#/people/training/courses/${c.id}">${c.pages || c.questions ? 'Edit' : 'Design it'}</a>
          <button type="button" class="icon-btn course-del" data-delete-course="${c.id}" aria-label="Delete ${esc(c.name)}" title="Delete course">🗑</button></span>
      </li>`).join('')}</ul>` : '<p class="muted">Add a course with <strong>+ Course</strong> above, then design it here.</p>'}
    </section>`;
  const decide = (attemptId, approve) => openModal({
    title: approve ? 'Sign off training' : 'Not signed off yet',
    body: field(approve ? 'Notes (optional)' : 'What do they need to work on?', textarea('notes', '', `maxlength="1000" ${approve ? '' : 'required'} placeholder="${approve ? 'e.g. Watched them make three flat whites' : 'e.g. Practise steaming milk with Sam, then take it again'}"`)),
    submitLabel: approve ? 'Sign off' : 'Send back',
    onSubmit: async (v) => {
      await api(`/training/attempts/${attemptId}/decide`, { method: 'POST', body: { approve, notes: v.notes } });
      toast(approve ? 'Signed off – their training is recorded' : 'Sent back – they’ll take it again');
      rerender();
    },
  });
  root.querySelectorAll('[data-delete-course]').forEach((b) => b.addEventListener('click', async () => {
    try { if (await deleteCourse(data.courses.find((c) => c.id === Number(b.dataset.deleteCourse)))) rerender(); } catch (err) { showError(err); }
  }));
  root.querySelectorAll('[data-signoff]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.signoff, true)));
  root.querySelector('#course-ready').addEventListener('click', readyMade);
  root.querySelectorAll('[data-sendback]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.sendback, false)));
}

// Ready-made courses (e.g. a health & safety induction): one tap adds a draft copy to check, change and publish.
async function readyMade() {
  let list;
  try { ({ templates: list } = await api('/training/templates')); } catch (err) { showError(err); return; }
  const { close, form } = openModal({
    title: '📚 Ready-made courses',
    body: `<p class="muted small">Add one as a draft, then check it fits your sites (fire exits, first aiders, your own rules) and change anything you like before you publish it.</p>
      <ul class="course-ready-list">${list.map((t) => `<li><div><strong>${esc(t.name)}</strong><p class="small">${esc(t.description)}</p>
        <small class="muted">${plural(t.pages, 'page')} · ${plural(t.questions, 'question')}${t.renew_months ? ` · every ${t.renew_months} months` : ''}${t.needs_signoff ? ' · signed off in person' : ''}</small></div>
        <button type="button" class="btn btn-primary btn-small" data-template="${esc(t.key)}">Add</button></li>`).join('')}</ul>`,
  });
  form.querySelectorAll('[data-template]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api(`/training/templates/${encodeURIComponent(b.dataset.template)}`, { method: 'POST' });
      close();
      toast('Added as a draft – check it, then publish');
      location.hash = `#/people/training/courses/${r.id}`;
    } catch (err) { showError(err); b.disabled = false; }
  }));
}

// ---- The designer ----

export async function renderDesigner(ctx) {
  const { el, params, stale, navigate } = ctx;
  const courseId = Number(params[0]);
  const [design, team] = await Promise.all([api(`/training/courses/${courseId}/design`), api('/training')]);
  if (stale()) return;
  const settings = { ...design.course, description: design.course.description ?? '', renew_months: design.course.renew_months ?? '' };
  const steps = design.steps.map((s) => ({ ...s, options: s.options ?? ['', ''] }));
  let dirty = false;
  let uploading = 0;

  const stepEditor = (s, i) => {
    const n = steps.slice(0, i + 1).filter((x) => x.kind === s.kind).length;
    const tools = `<span class="cd-step-tools">
      <button type="button" class="icon-btn" data-move="${i}|-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="icon-btn" data-move="${i}|1" aria-label="Move down" ${i === steps.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="icon-btn" data-remove="${i}" aria-label="Delete">✕</button></span>`;
    if (s.kind === 'question') {
      return `<li class="cd-step cd-question" data-i="${i}">
        <header><span class="cd-kind">❓ Question ${n}</span>${tools}</header>
        ${field('Question', `<input data-f="title" value="${esc(s.title)}" maxlength="300" placeholder="e.g. How many shots go in a flat white?">`)}
        <fieldset class="cd-options"><legend>Answers <small class="muted">– tick the right one</small></legend>
          ${s.options.map((o, oi) => `<div class="cd-option ${s.answer === oi ? 'is-right' : ''}">
            <input type="radio" name="right-${i}" data-right="${oi}" ${s.answer === oi ? 'checked' : ''} aria-label="Right answer">
            <input data-option="${oi}" value="${esc(o)}" maxlength="200" placeholder="Answer ${oi + 1}">
            ${s.options.length > 2 ? `<button type="button" class="icon-btn" data-drop-option="${oi}" aria-label="Remove answer">✕</button>` : ''}</div>`).join('')}
          ${s.options.length < 6 ? '<button type="button" class="link-btn" data-add-option>+ Add an answer</button>' : ''}
        </fieldset>
        ${field('Why it’s right (optional)', `<textarea data-f="body" rows="2" maxlength="1000" placeholder="Shown once they’ve passed">${esc(s.body)}</textarea>`)}
      </li>`;
    }
    return `<li class="cd-step cd-page" data-i="${i}">
      <header><span class="cd-kind">📄 Page ${n}</span>${tools}</header>
      ${field('Heading', `<input data-f="title" value="${esc(s.title)}" maxlength="150" placeholder="e.g. Steaming the milk">`)}
      ${field('Text', `<textarea data-f="body" rows="6" maxlength="10000" placeholder="Write the lesson. Leave a blank line between paragraphs.\n- Start lines with a dash for bullet points\n**Two stars** make text bold">${esc(s.body)}</textarea>`)}
      <div class="cd-media">
        ${s.pending ? '<p class="muted small">Uploading…</p>' : s.media_id ? `<div class="cd-thumb">${s.media_kind === 'video' ? `<video ${srcAttr(s.media_id)} preload="metadata" muted playsinline></video>` : `<img ${srcAttr(s.media_id)} alt="">`}
          <button type="button" class="btn btn-small" data-drop-media>Remove ${s.media_kind === 'video' ? 'video' : 'picture'}</button></div>`
          : `<label class="btn btn-small cd-upload">🖼️ Add a picture or video<input type="file" accept="image/*,video/mp4,video/webm,video/quicktime" data-upload hidden></label>`}
        ${field('YouTube link (optional)', `<input data-f="video_url" value="${esc(s.video_url ?? '')}" inputmode="url" placeholder="https://youtu.be/…">`)}
      </div>
    </li>`;
  };

  const draw = () => {
    const questions = steps.filter((s) => s.kind === 'question').length;
    el.innerHTML = `<div class="hip">
      <div class="page-head"><h1 class="hub-title">${esc(settings.name)}</h1>
        <div class="actions"><a class="btn" href="#/people/training">← Learning &amp; development</a>
          <button type="button" class="btn" id="cd-preview">Preview</button>
          ${settings.published ? '<button type="button" class="btn" id="cd-assign">Give to people</button>' : ''}
          <button type="button" class="btn btn-danger" id="cd-delete">Delete course</button></div></div>
      <div class="cd-layout">
        <section class="card cd-settings">
          <h2>Course details</h2>
          ${field('Course name', `<input data-s="name" value="${esc(settings.name)}" maxlength="100" required>`)}
          ${field('What it covers', `<textarea data-s="description" rows="2" maxlength="1000" placeholder="Shown before they start">${esc(settings.description)}</textarea>`)}
          <div class="cd-row">
            ${field('Pass mark', `<span class="cd-suffix"><input data-s="pass_mark" type="number" min="0" max="100" value="${settings.pass_mark}" ${questions ? '' : 'disabled'}>%</span>`, { hint: questions ? '' : 'Add questions to set a pass mark' })}
            ${field('Do it again every', `<span class="cd-suffix"><input data-s="renew_months" type="number" min="1" max="120" value="${esc(settings.renew_months)}" placeholder="–"> months</span>`, { hint: 'Leave blank if it’s once only' })}
          </div>
          <label class="check"><input type="checkbox" data-s="open_to_all" ${settings.open_to_all ? 'checked' : ''}> Open to everyone <small class="muted">– anyone can take it from their training list, as well as people you give it to</small></label>
          <label class="check"><input type="checkbox" data-s="needs_signoff" ${settings.needs_signoff ? 'checked' : ''}> Needs signing off in person <small class="muted">– after they pass, a manager watches them do it and signs it off before it counts</small></label>
        </section>
        <section class="cd-steps-wrap">
          <h2 class="cd-steps-title">Pages &amp; questions</h2>
          ${steps.length ? `<ol class="cd-steps">${steps.map(stepEditor).join('')}</ol>` : '<p class="card muted">Start with a page to teach something, then add questions to check they’ve got it.</p>'}
          <div class="cd-add"><button type="button" class="btn" data-add="page">+ Page</button><button type="button" class="btn" data-add="question">+ Question</button></div>
        </section>
        ${design.assigned.length ? `<section class="card cd-assigned"><h2>Given to</h2>
          <ul class="cd-people">${design.assigned.map((p) => {
            const [label, tone] = courseStatus(p);
            return `<li><span><strong>${esc(p.name)}</strong>${p.location_name ? `<small class="muted">${esc(p.location_name)}</small>` : ''}</span>
              <span class="course-status ${tone}">${esc(label)}${p.last_result === 'failed' && p.status === 'to_do' ? ` · last go ${p.last_score}%` : ''}</span>
              <button type="button" class="icon-btn" data-unassign="${p.user_id}" aria-label="Take ${esc(p.name)} off this course">✕</button></li>`;
          }).join('')}</ul></section>` : ''}
      </div>
      <div class="cd-savebar">
        <label class="check cd-publish"><input type="checkbox" data-s="published" ${settings.published ? 'checked' : ''}> <strong>Published</strong> <small class="muted">– staff can see it</small></label>
        <span class="spacer"></span>
        <span class="muted small" id="cd-dirty">${dirty ? 'Unsaved changes' : ''}</span>
        <button type="button" class="btn btn-primary" id="cd-save">Save course</button>
      </div></div>`;
    wire();
    hydrateMedia(el);
  };

  const markDirty = () => { dirty = true; const d = el.querySelector('#cd-dirty'); if (d) d.textContent = 'Unsaved changes'; };
  const body = () => ({
    name: settings.name, description: settings.description, renew_months: settings.renew_months === '' ? null : settings.renew_months,
    pass_mark: settings.pass_mark, open_to_all: settings.open_to_all, needs_signoff: settings.needs_signoff, published: settings.published,
    steps: steps.map((s) => ({ kind: s.kind, title: s.title, body: s.body, media_id: s.media_id, video_url: s.video_url, options: s.kind === 'question' ? s.options : undefined, answer: s.answer })),
  });
  const save = async () => {
    if (uploading) throw new Error('Wait for the upload to finish');
    const r = await api(`/training/courses/${courseId}/design`, { method: 'PUT', body: body() });
    Object.assign(settings, r.course, { description: r.course.description ?? '', renew_months: r.course.renew_months ?? '' });
    dirty = false;
    return r;
  };

  const wire = () => {
    el.querySelectorAll('[data-s]').forEach((inp) => inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', () => {
      settings[inp.dataset.s] = inp.type === 'checkbox' ? inp.checked : inp.value;
      markDirty();
    }));
    el.querySelectorAll('.cd-step').forEach((li) => {
      const s = steps[Number(li.dataset.i)];
      li.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('input', () => { s[inp.dataset.f] = inp.value; markDirty(); }));
      li.querySelectorAll('[data-option]').forEach((inp) => inp.addEventListener('input', () => { s.options[Number(inp.dataset.option)] = inp.value; markDirty(); }));
      li.querySelectorAll('[data-right]').forEach((r) => r.addEventListener('change', () => {
        s.answer = Number(r.dataset.right);
        li.querySelectorAll('.cd-option').forEach((o, oi) => o.classList.toggle('is-right', oi === s.answer));
        markDirty();
      }));
      li.querySelector('[data-add-option]')?.addEventListener('click', () => { s.options.push(''); markDirty(); draw(); });
      li.querySelectorAll('[data-drop-option]').forEach((b) => b.addEventListener('click', () => {
        const oi = Number(b.dataset.dropOption);
        s.options.splice(oi, 1);
        if (s.answer === oi) s.answer = null;
        else if (s.answer > oi) s.answer--;
        markDirty();
        draw();
      }));
      li.querySelector('[data-drop-media]')?.addEventListener('click', () => { s.media_id = null; s.media_kind = null; markDirty(); draw(); });
      li.querySelector('[data-upload]')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const isVideo = file.type.startsWith('video/');
        if (isVideo && file.size > MAX_VIDEO_MB * 1024 * 1024) { showError(new Error(`That video is over ${MAX_VIDEO_MB} MB – try a shorter clip, or put it on YouTube and paste the link`)); return; }
        s.pending = true;
        uploading++;
        draw();
        try {
          const ready = isVideo ? file : await shrinkImage(file);
          const saved = await api('/training/media', { method: 'POST', body: { file_name: ready.name, media_type: ready.type, data: await toBase64(ready) } });
          Object.assign(s, { media_id: saved.id, media_kind: saved.kind });
          markDirty();
        } catch (err) { showError(err); }
        s.pending = false;
        uploading--;
        draw();
      });
    });
    el.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
      const [i, d] = b.dataset.move.split('|').map(Number);
      [steps[i], steps[i + d]] = [steps[i + d], steps[i]];
      markDirty();
      draw();
    }));
    el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      const s = steps[Number(b.dataset.remove)];
      if ((s.title || s.body || s.media_id) && !(await confirmDialog(`Delete this ${s.kind}?`, { confirmLabel: 'Delete' }))) return;
      steps.splice(Number(b.dataset.remove), 1);
      markDirty();
      draw();
    }));
    el.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
      steps.push(b.dataset.add === 'question' ? { kind: 'question', title: '', body: '', options: ['', '', ''], answer: null } : { kind: 'page', title: '', body: '', media_id: null, video_url: '' });
      markDirty();
      draw();
      el.querySelector('.cd-step:last-child input')?.focus();
    }));
    el.querySelector('#cd-save').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await save();
        toast(settings.published ? 'Course saved – staff can take it' : 'Course saved as a draft');
        draw();
      } catch (err) { showError(err); }
      e.target.disabled = false;
    });
    el.querySelector('#cd-delete').addEventListener('click', async () => {
      try {
        if (await deleteCourse({ id: courseId, name: settings.name, assigned: design.assigned.length })) { dirty = false; navigate('people/training'); }
      } catch (err) { showError(err); }
    });
    el.querySelector('#cd-preview').addEventListener('click', async () => {
      try {
        if (dirty) await save();
        navigate(`learn/${courseId}`);
      } catch (err) { showError(err); }
    });
    el.querySelector('#cd-assign')?.addEventListener('click', async () => {
      try {
        if (dirty) await save();
        assignDialog();
      } catch (err) { showError(err); }
    });
    el.querySelectorAll('[data-unassign]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Take them off this course? Any training they’ve already done is kept.', { confirmLabel: 'Take off' }))) return;
      try {
        await api(`/training/courses/${courseId}/assign/${b.dataset.unassign}`, { method: 'DELETE' });
        toast('Taken off the course');
        ctx.rerender();
      } catch (err) { showError(err); }
    }));
  };

  // Give the course to people: tick names (or everyone at a site, or with a role) and an optional due date.
  const assignDialog = () => {
    const people = team.people;
    const already = new Set(design.assigned.map((p) => p.user_id));
    const sites = [...new Map(people.filter((p) => p.location_id).map((p) => [p.location_id, p.location_name])).entries()];
    const roles = [...new Set(people.map((p) => p.position).filter(Boolean))].sort();
    const { form } = openModal({
      title: `Give “${settings.name}” to people`,
      wide: true,
      body: `${field('Due by (optional)', input('due_on', '', `type="date" min="${todayISO()}"`))}
        <fieldset class="pp-pick"><legend>Who should do it <span class="muted small" data-picked></span></legend>
          <div class="pp-pick-tools"><input type="search" data-pick-search placeholder="Search names…" aria-label="Search names" autocomplete="off">
            <button type="button" class="btn btn-small" data-pick-all>Tick all shown</button><button type="button" class="btn btn-small btn-ghost" data-pick-none>Clear</button></div>
          ${sites.length > 1 ? `<div class="chips cd-pick-chips"><span class="muted small">Tick a site:</span>${sites.map(([id, name]) => `<button type="button" class="chip chip-btn" data-pick-site="${id}">${esc(name)}</button>`).join('')}</div>` : ''}
          ${roles.length ? `<div class="chips cd-pick-chips"><span class="muted small">Tick a role:</span>${roles.map((r) => `<button type="button" class="chip chip-btn" data-pick-role="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : ''}
          <div class="pp-pick-list">${people.map((p) => `<label class="pp-pick-item" data-name="${esc(p.name.toLowerCase())}" data-site="${p.location_id ?? ''}" data-role="${esc(p.position ?? '')}">
            <input type="checkbox" data-who="${p.id}"><span>${esc(p.name)}${already.has(p.id) ? ' <small class="muted">· already given it</small>' : ''}<small class="muted">${esc([p.position, p.location_name].filter(Boolean).join(' · '))}</small></span></label>`).join('')}</div>
        </fieldset>
        <p class="muted small">They’ll see it in My tasks on My Atlas and get a notification. Giving it to someone who’s done it before asks them to do it again.</p>`,
      submitLabel: 'Give course',
      onSubmit: async (v, f) => {
        const ids = [...f.querySelectorAll('[data-who]:checked')].map((b) => Number(b.dataset.who));
        if (!ids.length) throw new Error('Tick who should do the course');
        await api(`/training/courses/${courseId}/assign`, { method: 'POST', body: { user_ids: ids, due_on: v.due_on || null } });
        toast(`Given to ${ids.length === 1 ? '1 person' : `${ids.length} people`}`);
        ctx.rerender();
      },
    });
    const items = [...form.querySelectorAll('.pp-pick-item')];
    const count = () => {
      const n = form.querySelectorAll('[data-who]:checked').length;
      form.querySelector('[data-picked]').textContent = n ? `· ${n} ticked` : '';
    };
    const tick = (pred) => { items.filter(pred).forEach((i) => { i.querySelector('input').checked = true; }); count(); };
    form.querySelector('[data-pick-search]').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      items.forEach((i) => { i.hidden = !!q && !i.dataset.name.includes(q); });
    });
    form.querySelector('[data-pick-search]').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    form.querySelector('[data-pick-all]').addEventListener('click', () => tick((i) => !i.hidden));
    form.querySelector('[data-pick-none]').addEventListener('click', () => { items.forEach((i) => { i.querySelector('input').checked = false; }); count(); });
    form.querySelectorAll('[data-pick-site]').forEach((b) => b.addEventListener('click', () => tick((i) => i.dataset.site === b.dataset.pickSite)));
    form.querySelectorAll('[data-pick-role]').forEach((b) => b.addEventListener('click', () => tick((i) => i.dataset.role === b.dataset.pickRole)));
    form.addEventListener('change', count);
  };

  draw();
}

// ---- Taking courses ----

// Everyone's list of courses: the ones given to them, then ones open to everyone.
export async function renderLearnList(ctx) {
  const { el, stale } = ctx;
  const courses = await api('/learn');
  if (stale()) return;
  const order = { to_do: 0, awaiting_signoff: 1, done: 2 };
  courses.sort((a, b) => (order[a.status] - order[b.status]) || (b.assigned - a.assigned) || (a.due_on ?? '9').localeCompare(b.due_on ?? '9'));
  el.innerHTML = `<div class="hip">
    <div class="page-head"><h1 class="hub-title">Training</h1></div>
    ${courses.length ? `<ul class="learn-list">${courses.map((c) => {
      const [label, tone] = courseStatus(c);
      return `<li><a class="learn-card" href="#/learn/${c.id}">
        <span class="learn-card-icon" aria-hidden="true">🎓</span>
        <span class="learn-card-text"><strong>${esc(c.name)}</strong>
          ${c.description ? `<small>${esc(c.description)}</small>` : ''}
          <small class="muted">${[c.pages ? plural(c.pages, 'page') : '', c.questions ? plural(c.questions, 'question') : ''].filter(Boolean).join(' · ')}${c.completed_on ? ` · last done ${day(c.completed_on)}` : ''}</small></span>
        <span class="course-status ${tone}">${esc(label)}</span></a></li>`;
    }).join('')}</ul>` : '<div class="card empty">No training courses for you yet. When your manager gives you one, it’ll be here and in My tasks.</div>'}</div>`;
}

// One course, a step at a time, then the quiz marked.
export async function renderLearn(ctx) {
  const { el, params, stale } = ctx;
  const courseId = Number(params[0]);
  const data = await api(`/learn/${courseId}`);
  if (stale()) return;
  const { course, steps, preview } = data;
  const answers = {};
  let at = -1; // -1 is the course's front page
  let result = null;

  const progressBar = () => {
    const pct = steps.length ? Math.round(((at + 1) / steps.length) * 100) : 0;
    return `<div class="learn-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>`;
  };

  const front = () => {
    const [label, tone] = courseStatus(data.progress);
    return `<section class="card learn-front">
      <span class="learn-badge" aria-hidden="true">🎓</span>
      <h2>${esc(course.name)}</h2>
      ${course.description ? `<p>${esc(course.description)}</p>` : ''}
      <ul class="learn-facts">
        ${course.pages ? `<li>📄 ${plural(course.pages, 'page')} to read</li>` : ''}
        ${course.questions ? `<li>❓ ${plural(course.questions, 'question')} – you need ${course.pass_mark}% to pass</li>` : ''}
        ${course.needs_signoff ? '<li>👀 A manager signs it off once they’ve seen you do it</li>' : ''}
        ${course.renew_months ? `<li>↻ Done again every ${plural(course.renew_months, 'month')}</li>` : ''}
      </ul>
      ${preview ? '<p class="notice">Preview – this is how staff see the course. Your answers aren’t marked or recorded.</p>' : `<p><span class="course-status ${tone}">${esc(label)}</span></p>`}
      ${data.progress.status === 'awaiting_signoff' ? '<p class="muted">You’ve passed – a manager just needs to sign it off.</p>'
        : `<button type="button" class="btn btn-primary learn-go" data-go="0" ${steps.length ? '' : 'disabled'}>${data.progress.status === 'done' ? 'Go through it again' : 'Start'} →</button>`}
    </section>`;
  };

  const stepView = (s, i) => {
    const qNo = steps.slice(0, i + 1).filter((x) => x.kind === 'question').length;
    const last = i === steps.length - 1;
    const canNext = s.kind !== 'question' || answers[s.id] !== undefined;
    return `${progressBar()}
      <p class="learn-count">${i + 1} of ${steps.length}</p>
      <section class="card learn-step ${s.kind === 'question' ? 'is-question' : ''}">
        ${s.kind === 'question' ? `<p class="learn-q-no">Question ${qNo}</p><h2>${esc(s.title)}</h2>
          <div class="learn-options" role="radiogroup">${s.options.map((o, oi) => `<button type="button" class="learn-option ${answers[s.id] === oi ? 'is-on' : ''}" role="radio" aria-checked="${answers[s.id] === oi}" data-pick="${oi}">
            <span class="learn-option-mark" aria-hidden="true">${String.fromCharCode(65 + oi)}</span>${esc(o)}</button>`).join('')}</div>`
          : `${s.title ? `<h2>${esc(s.title)}</h2>` : ''}${media(s)}<div class="lesson-text">${formatLesson(s.body)}</div>`}
      </section>
      <div class="learn-nav">
        <button type="button" class="btn" data-go="${i - 1}">← Back</button>
        ${last ? `<button type="button" class="btn btn-primary" id="learn-finish" ${canNext ? '' : 'disabled'}>${course.questions ? 'Hand it in' : 'Finish'}</button>`
          : `<button type="button" class="btn btn-primary" data-go="${i + 1}" ${canNext ? '' : 'disabled'}>Next →</button>`}
      </div>`;
  };

  const resultView = () => {
    const r = result;
    const good = r.passed;
    return `<section class="card learn-result ${good ? 'is-pass' : 'is-fail'}">
      <span class="learn-score">${r.total ? `${r.score}%` : '✓'}</span>
      <h2>${good ? (r.status === 'awaiting_signoff' ? 'Passed – nearly there!' : 'You passed! 🎉') : 'Not quite this time'}</h2>
      <p>${good ? (r.status === 'awaiting_signoff' ? 'A manager will sign it off once they’ve seen you do it in person.' : 'Your training is recorded. Nice work.')
        : `You got ${r.right} of ${r.total} right – you need ${r.pass_mark}% to pass. Have another look through and try again.`}</p>
      ${r.total ? `<ol class="learn-review">${r.results.map((q) => `<li class="${q.correct ? 'is-right' : 'is-wrong'}">
        <span class="learn-review-mark" aria-hidden="true">${q.correct ? '✓' : '✕'}</span>
        <div><strong>${esc(q.title)}</strong>
          <small>Your answer: ${esc(q.options[q.chosen])}</small>
          ${!q.correct && q.answer !== null ? `<small class="learn-right">Right answer: ${esc(q.options[q.answer])}</small>` : ''}
          ${q.explanation ? `<small class="muted">${esc(q.explanation)}</small>` : ''}</div></li>`).join('')}</ol>` : ''}
      <div class="learn-nav">${good ? '<a class="btn btn-primary" href="#/mybrew">Back to My Atlas</a>' : '<button type="button" class="btn btn-primary" data-go="0">Try again</button>'}
        <a class="btn" href="#/learn">All my training</a></div>
    </section>`;
  };

  const previewEnd = () => `<section class="card learn-result is-pass"><span class="learn-score">👀</span><h2>End of the preview</h2>
    <p>Staff hand in their answers here and see their score.</p>
    <div class="learn-nav"><a class="btn btn-primary" href="#/people/training/courses/${courseId}">Back to the designer</a></div></section>`;

  const draw = () => {
    el.innerHTML = `<div class="learn hip">
      <div class="page-head"><h1 class="hub-title">${esc(course.name)}</h1>
        <div class="actions">${preview ? `<a class="btn" href="#/people/training/courses/${courseId}">← Designer</a>` : '<a class="btn" href="#/learn">← My training</a>'}</div></div>
      ${result === 'preview' ? previewEnd() : result ? resultView() : at < 0 ? front() : stepView(steps[at], at)}</div>`;
    el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
      const to = Number(b.dataset.go);
      if (result && result !== 'preview') { result = null; Object.keys(answers).forEach((k) => delete answers[k]); }
      at = Math.max(-1, Math.min(steps.length - 1, to));
      draw();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
    el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      answers[steps[at].id] = Number(b.dataset.pick);
      draw();
    }));
    el.querySelector('#learn-finish')?.addEventListener('click', async (e) => {
      if (preview) { result = 'preview'; draw(); return; }
      e.target.disabled = true;
      try {
        result = await api(`/learn/${courseId}/submit`, { method: 'POST', body: { answers } });
        if (result.passed) data.progress.status = result.status === 'awaiting_signoff' ? 'awaiting_signoff' : 'done';
        draw();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) { showError(err); e.target.disabled = false; }
    });
    hydrateMedia(el);
  };
  draw();
}
