// Training courses built in Atlas (People → Learning & development): a manager designs a course from pages (text, a
// picture or video, a YouTube link) and multiple-choice questions, then gives it to people with a due date and/or opens
// it to everyone. Staff work through it on their phone; passing records the training (or, for courses that need it,
// waits for a manager to sign it off in person first).
import { can, requirePerm } from '../auth.js';
import { tx } from '../db.js';
import { notify, peopleWith } from '../push.js';
import { badRequest, bool, date, forbidden, id, notFound, num, str, today } from '../util.js';
import { COURSE_TEMPLATES, templateSummaries } from '../course-templates.js';
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from './news.js';

const MEDIA_TYPES = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image',
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
};
const MAX_STEPS = 60;
const MAX_OPTIONS = 6;

const realBuffer = typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function';
const fromBase64 = (b64) => (realBuffer ? Buffer.from(b64, 'base64') : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const asBody = (bytes) => (realBuffer ? Buffer.from(bytes) : bytes);

/** A YouTube link (watch, youtu.be, shorts or embed) as a privacy-friendly embed address, or null if it isn't one. */
export function youtubeEmbed(url) {
  const m = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/|youtube-nocookie\.com\/embed\/)([\w-]{11})/i.exec(String(url ?? '').trim());
  return m ? `https://www.youtube-nocookie.com/embed/${m[1]}` : null;
}

export function registerCourseRoutes(router, db) {
  const perm = requirePerm('people.manage');
  const course = (courseId) => {
    const c = db.prepare('SELECT * FROM training_courses WHERE id = ? AND active = 1').get(Number(courseId));
    if (!c) throw notFound('Course');
    return c;
  };
  const stepsOf = (courseId) => db.prepare('SELECT * FROM training_steps WHERE course_id = ? ORDER BY position, id').all(courseId)
    .map((s) => ({ ...s, options: s.options ? JSON.parse(s.options) : null }));
  const mediaKind = (mediaId) => (mediaId ? db.prepare('SELECT kind FROM training_media WHERE id = ?').get(mediaId)?.kind ?? null : null);
  // A manager works with staff at their own sites (admins and all-site managers with everyone).
  const managed = (req, userId) => {
    const u = db.prepare('SELECT id, name, location_id, role FROM users WHERE id = ? AND active = 1').get(userId);
    if (!u) throw notFound('Person');
    if (req.user.role !== 'admin' && u.location_id && !req.user.site_ids.includes(u.location_id)) throw forbidden('That person works at a site you don’t manage');
    return u;
  };
  // The latest record of a course for someone, and whether it's still in date.
  const latestRecord = (courseId, userId) => db.prepare(`SELECT r.completed_on,
      CASE WHEN c.renew_months THEN date(r.completed_on, '+' || c.renew_months || ' months') END AS expires_on
    FROM training_records r JOIN training_courses c ON c.id = r.course_id WHERE r.course_id = ? AND r.user_id = ?
    ORDER BY r.completed_on DESC, r.id DESC LIMIT 1`).get(courseId, userId);
  const lastAttempt = (courseId, userId) => db.prepare(`SELECT id, status, score, created_at FROM training_attempts
    WHERE course_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`).get(courseId, userId);
  const assignment = (courseId, userId) => db.prepare('SELECT * FROM training_assignments WHERE course_id = ? AND user_id = ?').get(courseId, userId);

  // Where someone is with a course: done (and in date), waiting for sign-off, or to do (with how their last go went).
  const progress = (c, userId) => {
    const rec = latestRecord(c.id, userId);
    const att = lastAttempt(c.id, userId);
    const a = assignment(c.id, userId);
    const inDate = rec && (!rec.expires_on || rec.expires_on >= today());
    // An assignment made after the last time they did it means "do it again".
    const doneSinceAssigned = rec && (!a || rec.completed_on >= a.created_at.slice(0, 10));
    let status = 'to_do';
    if (att?.status === 'awaiting_signoff') status = 'awaiting_signoff';
    else if (inDate && doneSinceAssigned) status = 'done';
    return {
      status,
      completed_on: rec?.completed_on ?? null,
      expires_on: rec?.expires_on ?? null,
      last_score: att?.score ?? null,
      last_result: att?.status ?? null,
      assigned: !!a,
      due_on: a?.due_on ?? null,
    };
  };

  // Whether someone can open a course to take it: it's published and given to them or open to everyone.
  const canTake = (c, user) => c.published && (c.open_to_all || !!assignment(c.id, user.id));

  const summary = (c) => {
    const steps = db.prepare(`SELECT kind, COUNT(*) AS n FROM training_steps WHERE course_id = ? GROUP BY kind`).all(c.id);
    const count = (k) => steps.find((s) => s.kind === k)?.n ?? 0;
    return {
      id: c.id, name: c.name, description: c.description, renew_months: c.renew_months,
      published: !!c.published, open_to_all: !!c.open_to_all, pass_mark: c.pass_mark, needs_signoff: !!c.needs_signoff,
      pages: count('page'), questions: count('question'),
    };
  };

  // ---- Designing (managers) ----

  // Every course with how far each is built and who it's been given to.
  router.get('/training/designs', perm, (req, res) => {
    const courses = db.prepare('SELECT * FROM training_courses WHERE active = 1 ORDER BY name').all();
    const assigned = db.prepare('SELECT course_id, COUNT(*) AS n FROM training_assignments GROUP BY course_id').all();
    const waiting = db.prepare(`SELECT a.id, a.course_id, a.score, a.created_at, u.id AS user_id, u.name AS user_name, u.location_id, c.name AS course_name
      FROM training_attempts a JOIN users u ON u.id = a.user_id JOIN training_courses c ON c.id = a.course_id
      WHERE a.status = 'awaiting_signoff' AND c.active = 1 ORDER BY a.created_at`).all()
      .filter((w) => req.user.role === 'admin' || !w.location_id || req.user.site_ids.includes(w.location_id));
    res.json({
      courses: courses.map((c) => ({ ...summary(c), assigned: assigned.find((a) => a.course_id === c.id)?.n ?? 0 })),
      signoffs: waiting,
    });
  });

  // Ready-made courses (e.g. a health & safety induction) to start from.
  router.get('/training/templates', perm, (req, res) => {
    res.json({ templates: templateSummaries() });
  });

  // Adds a ready-made course as a draft, to check and change in the designer before publishing.
  router.post('/training/templates/:key', perm, (req, res) => {
    const t = COURSE_TEMPLATES.find((x) => x.key === req.params.key);
    if (!t) throw notFound('Ready-made course');
    const courseId = tx(db, () => {
      const cid = Number(db.prepare(`INSERT INTO training_courses (name, description, renew_months, pass_mark, needs_signoff, published, open_to_all)
        VALUES (?, ?, ?, ?, ?, 0, 0)`).run(t.name, t.description, t.renew_months, t.pass_mark, t.needs_signoff ? 1 : 0).lastInsertRowid);
      const add = db.prepare('INSERT INTO training_steps (course_id, position, kind, title, body, options, answer) VALUES (?, ?, ?, ?, ?, ?, ?)');
      t.steps.forEach((s, i) => add.run(cid, i, s.kind, s.title, s.body || null, s.options ? JSON.stringify(s.options) : null, s.answer ?? null));
      return cid;
    });
    res.status(201).json({ id: courseId });
  });

  // A course to design: its settings, every step (with the right answers) and who it's been given to.
  router.get('/training/courses/:id/design', perm, (req, res) => {
    const c = course(req.params.id);
    const people = db.prepare(`SELECT a.user_id, a.due_on, a.created_at, u.name, u.location_id, l.name AS location_name
      FROM training_assignments a JOIN users u ON u.id = a.user_id LEFT JOIN locations l ON l.id = u.location_id
      WHERE a.course_id = ? AND u.active = 1 ORDER BY u.name`).all(c.id)
      .filter((p) => req.user.role === 'admin' || !p.location_id || req.user.site_ids.includes(p.location_id));
    res.json({
      course: summary(c),
      steps: stepsOf(c.id).map((s) => ({ ...s, media_kind: mediaKind(s.media_id) })),
      assigned: people.map((p) => ({ ...p, ...progress(c, p.user_id) })),
    });
  });

  // Saves the course settings and all its steps at once (the designer sends the whole course).
  router.put('/training/courses/:id/design', perm, (req, res) => {
    const c = course(req.params.id);
    const b = req.body ?? {};
    const name = str(b.name ?? c.name, 'Course name', { required: true, max: 100 });
    const description = str(b.description, 'Description', { max: 1000 });
    const renew = num(b.renew_months, 'Renew every (months)', { int: true, min: 1, max: 120 });
    const passMark = num(b.pass_mark ?? c.pass_mark, 'Pass mark', { int: true, min: 0, max: 100 }) ?? 80;
    const raw = Array.isArray(b.steps) ? b.steps : [];
    if (raw.length > MAX_STEPS) throw badRequest(`A course can have at most ${MAX_STEPS} pages and questions`);
    const steps = raw.map((s, i) => {
      const n = i + 1;
      if (s?.kind === 'question') {
        const question = str(s.title, `Question ${n}`, { required: true, max: 300 });
        const options = (Array.isArray(s.options) ? s.options : []).map((o) => String(o ?? '').trim()).filter(Boolean);
        if (options.length < 2) throw badRequest(`Question ${n} (“${question}”) needs at least two answers`);
        if (options.length > MAX_OPTIONS) throw badRequest(`Question ${n} can have at most ${MAX_OPTIONS} answers`);
        if (options.some((o) => o.length > 200)) throw badRequest(`Answers to question ${n} can be up to 200 characters`);
        const answer = Number(s.answer);
        if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) throw badRequest(`Choose the right answer to question ${n} (“${question}”)`);
        return { kind: 'question', title: question, body: str(s.body, 'Explanation', { max: 1000 }), options, answer, media_id: null, video_url: null };
      }
      const title = str(s?.title, `Page ${n} title`, { max: 150 });
      const body = str(s?.body, `Page ${n} text`, { max: 10000 });
      let videoUrl = null;
      if (String(s?.video_url ?? '').trim()) {
        videoUrl = youtubeEmbed(s.video_url);
        if (!videoUrl) throw badRequest(`The video link on page ${n} isn’t a YouTube link – upload the video instead, or paste a YouTube address`);
      }
      const mediaId = s?.media_id ? id(s.media_id, 'media_id') : null;
      if (!title && !body && !mediaId && !videoUrl) throw badRequest(`Page ${n} is empty – add some text, a picture or a video, or delete it`);
      return { kind: 'page', title, body, media_id: mediaId, video_url: videoUrl, options: null, answer: null };
    });
    // Pictures and videos must be this course's own, or ones this person has just uploaded.
    for (const s of steps.filter((x) => x.media_id)) {
      const m = db.prepare('SELECT course_id, created_by FROM training_media WHERE id = ?').get(s.media_id);
      if (!m || (m.course_id && m.course_id !== c.id) || (!m.course_id && m.created_by !== req.user.id && req.user.role !== 'admin')) throw notFound('Picture or video');
    }
    const publish = b.published === undefined ? c.published : bool(b.published);
    if (publish && !steps.length) throw badRequest('Add at least one page or question before publishing the course');
    tx(db, () => {
      db.prepare(`UPDATE training_courses SET name = ?, description = ?, renew_months = ?, pass_mark = ?, open_to_all = ?, needs_signoff = ?, published = ?
        WHERE id = ?`).run(name, description, renew, passMark, bool(b.open_to_all ?? c.open_to_all), bool(b.needs_signoff ?? c.needs_signoff), publish, c.id);
      db.prepare('DELETE FROM training_steps WHERE course_id = ?').run(c.id);
      const add = db.prepare(`INSERT INTO training_steps (course_id, position, kind, title, body, media_id, video_url, options, answer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      steps.forEach((s, i) => add.run(c.id, i, s.kind, s.title, s.body, s.media_id, s.video_url, s.options ? JSON.stringify(s.options) : null, s.answer));
      const used = steps.map((s) => s.media_id).filter(Boolean);
      if (used.length) db.prepare(`UPDATE training_media SET course_id = ? WHERE id IN (${used.map(() => '?').join(',')})`).run(c.id, ...used);
      // Pictures and videos taken off the course are deleted.
      db.prepare(`DELETE FROM training_media WHERE course_id = ? ${used.length ? `AND id NOT IN (${used.map(() => '?').join(',')})` : ''}`).run(c.id, ...used);
    });
    res.json({ ok: true, course: summary(course(c.id)) });
  });

  // Upload one picture or video for a page: { file_name, media_type, data (base64) }. It's kept when the course is saved.
  router.post('/training/media', perm, (req, res) => {
    const type = String(req.body?.media_type ?? '');
    const kind = MEDIA_TYPES[type];
    if (!kind) throw badRequest('Add a picture (JPEG, PNG) or a video (MP4, MOV, WebM)');
    const data = String(req.body.data ?? '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    let bytes;
    try { bytes = fromBase64(data); } catch { throw badRequest('The file couldn’t be read'); }
    if (!bytes.length) throw badRequest('The file is empty');
    const max = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (bytes.length > max) throw badRequest(kind === 'video' ? 'Videos can be up to 25 MB – try a shorter clip, or put it on YouTube and paste the link' : 'Pictures can be up to 8 MB');
    db.prepare(`DELETE FROM training_media WHERE course_id IS NULL AND created_at < datetime('now', '-1 day')`).run();
    const r = db.prepare('INSERT INTO training_media (kind, file_name, file_type, size, data, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(kind, str(req.body.file_name, 'file_name', { max: 200 }), type, bytes.length, bytes, req.user.id);
    res.status(201).json({ id: Number(r.lastInsertRowid), kind });
  });

  // The picture or video itself, for anyone who can take the course (or design it). Videos support byte ranges.
  router.get('/training/media/:id', (req, res) => {
    const m = db.prepare('SELECT id, course_id, file_type, size, created_by FROM training_media WHERE id = ?').get(Number(req.params.id));
    if (!m) throw notFound('Picture or video');
    const manager = can(req.user, 'people.manage');
    if (m.course_id) {
      const c = db.prepare('SELECT * FROM training_courses WHERE id = ?').get(m.course_id);
      if (!manager && !canTake(c, req.user)) throw notFound('Picture or video');
    } else if (!manager) throw notFound('Picture or video');
    const data = db.prepare('SELECT data FROM training_media WHERE id = ?').get(m.id).data;
    res.setHeader('Content-Type', m.file_type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, m.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), m.size - 1) : m.size - 1;
      if (start >= m.size || start > end) {
        res.setHeader('Content-Range', `bytes */${m.size}`);
        return res.status(416).end();
      }
      res.setHeader('Content-Range', `bytes ${start}-${end}/${m.size}`);
      return res.status(206).send(asBody(data.subarray(start, end + 1)));
    }
    res.send(asBody(data));
  });

  // Gives a course to people: { user_ids, due_on }. Giving it again changes the due date and asks them to redo it.
  router.post('/training/courses/:id/assign', perm, (req, res) => {
    const c = course(req.params.id);
    if (!c.published) throw badRequest('Publish the course before giving it to people');
    const b = req.body ?? {};
    const ids = [...new Set((Array.isArray(b.user_ids) ? b.user_ids : []).map((u) => id(u, 'user_id', { required: true })))];
    if (!ids.length) throw badRequest('Tick who should do the course');
    const due = date(b.due_on, 'Due date');
    if (due && due < today()) throw badRequest('The due date can’t be in the past');
    for (const u of ids) managed(req, u);
    tx(db, () => {
      const put = db.prepare(`INSERT INTO training_assignments (course_id, user_id, due_on, assigned_by) VALUES (?, ?, ?, ?)
        ON CONFLICT (course_id, user_id) DO UPDATE SET due_on = excluded.due_on, assigned_by = excluded.assigned_by, created_at = datetime('now')`);
      for (const u of ids) put.run(c.id, u, due, req.user.id);
    });
    notify(db, ids, 'training', {
      title: `Training: ${c.name}`,
      body: due ? `You’ve been given a course to do by ${due.split('-').reverse().join('/')}` : 'You’ve been given a course to do',
      url: `/#/learn/${c.id}`,
    });
    res.json({ ok: true, assigned: ids.length });
  });

  router.delete('/training/courses/:id/assign/:userId', perm, (req, res) => {
    const c = course(req.params.id);
    managed(req, Number(req.params.userId));
    db.prepare('DELETE FROM training_assignments WHERE course_id = ? AND user_id = ?').run(c.id, Number(req.params.userId));
    res.json({ ok: true });
  });

  // A manager signs off (or sends back) someone's course after seeing them do it in person.
  router.post('/training/attempts/:id/decide', perm, (req, res) => {
    const a = db.prepare(`SELECT a.*, c.name AS course_name FROM training_attempts a JOIN training_courses c ON c.id = a.course_id WHERE a.id = ?`).get(Number(req.params.id));
    if (!a || a.status !== 'awaiting_signoff') throw notFound('Sign-off');
    managed(req, a.user_id);
    const approve = !!req.body?.approve;
    const note = str(req.body?.notes, 'Notes', { max: 1000 });
    tx(db, () => {
      let recordId = null;
      if (approve) {
        recordId = Number(db.prepare('INSERT INTO training_records (course_id, user_id, completed_on, notes, recorded_by) VALUES (?, ?, ?, ?, ?)')
          .run(a.course_id, a.user_id, today(), [`Online course passed (${a.score}%) and signed off`, note].filter(Boolean).join(' – '), req.user.id).lastInsertRowid);
      }
      db.prepare(`UPDATE training_attempts SET status = ?, record_id = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?`)
        .run(approve ? 'signed_off' : 'sent_back', recordId, req.user.id, a.id);
    });
    notify(db, [a.user_id], 'training', {
      title: approve ? `✓ ${a.course_name} signed off` : `${a.course_name}: not signed off yet`,
      body: approve ? 'Your training is recorded – nice work!' : (note || 'Have a word with your manager, then take the course again.'),
      url: approve ? '/#/mybrew' : `/#/learn/${a.course_id}`,
    });
    res.json({ ok: true });
  });

  // ---- Taking a course (everyone) ----

  // The courses someone can take: the ones given to them, and ones open to everyone.
  router.get('/learn', (req, res) => {
    const courses = db.prepare(`SELECT c.* FROM training_courses c WHERE c.active = 1 AND c.published = 1
      AND (c.open_to_all = 1 OR EXISTS (SELECT 1 FROM training_assignments a WHERE a.course_id = c.id AND a.user_id = ?)) ORDER BY c.name`).all(req.user.id);
    res.json(courses.map((c) => ({ ...summary(c), ...progress(c, req.user.id) })));
  });

  // A course to take, without the answers. Managers can preview any course, published or not.
  router.get('/learn/:id', (req, res) => {
    const c = course(req.params.id);
    const preview = can(req.user, 'people.manage');
    if (!canTake(c, req.user) && !preview) throw notFound('Course');
    res.json({
      course: summary(c),
      preview: !canTake(c, req.user),
      progress: progress(c, req.user.id),
      steps: stepsOf(c.id).map((s) => ({
        id: s.id, kind: s.kind, title: s.title, body: s.kind === 'page' ? s.body : null,
        media_id: s.media_id, media_kind: mediaKind(s.media_id), video_url: s.video_url, options: s.options,
      })),
    });
  });

  // Hands in the answers: { answers: { stepId: optionIndex } }. Marks them, and records the training on a pass.
  router.post('/learn/:id/submit', (req, res) => {
    const c = course(req.params.id);
    if (!canTake(c, req.user)) throw notFound('Course');
    if (progress(c, req.user.id).status === 'awaiting_signoff') throw badRequest('You’ve already passed – a manager just needs to sign it off');
    const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    const questions = stepsOf(c.id).filter((s) => s.kind === 'question');
    const marked = questions.map((q) => {
      const given = answers[q.id];
      const chosen = given === undefined || given === null || given === '' ? null : Number(given);
      return { step_id: q.id, title: q.title, chosen, correct: chosen === q.answer, answer: q.answer, options: q.options, explanation: q.body };
    });
    if (marked.some((m) => m.chosen === null)) throw badRequest('Answer every question before handing it in');
    const right = marked.filter((m) => m.correct).length;
    const score = questions.length ? Math.round((right / questions.length) * 100) : 100;
    const passed = score >= c.pass_mark;
    const status = !passed ? 'failed' : c.needs_signoff ? 'awaiting_signoff' : 'passed';
    tx(db, () => {
      let recordId = null;
      if (status === 'passed') {
        recordId = Number(db.prepare('INSERT INTO training_records (course_id, user_id, completed_on, notes, recorded_by) VALUES (?, ?, ?, ?, ?)')
          .run(c.id, req.user.id, today(), questions.length ? `Online course passed (${score}%)` : 'Online course completed', null).lastInsertRowid);
      }
      db.prepare('INSERT INTO training_attempts (course_id, user_id, score, status, answers, record_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(c.id, req.user.id, score, status, JSON.stringify(answers), recordId);
    });
    if (status === 'awaiting_signoff') {
      const me = db.prepare('SELECT location_id FROM users WHERE id = ?').get(req.user.id);
      notify(db, peopleWith(db, ['people.manage'], me?.location_id ?? null).filter((u) => u !== req.user.id), 'training_signoff', {
        title: `${req.user.name} passed ${c.name}`,
        body: 'They’re ready for you to sign it off in person',
        url: '/#/people/training',
      });
    }
    // Wrong answers show the right one only once they've passed, so a fail can't just be copied next time.
    res.json({
      score, passed, status, pass_mark: c.pass_mark, right, total: questions.length,
      results: marked.map((m) => ({ step_id: m.step_id, title: m.title, correct: m.correct, chosen: m.chosen, options: m.options,
        answer: passed ? m.answer : null, explanation: passed ? m.explanation : null })),
    });
  });
}
