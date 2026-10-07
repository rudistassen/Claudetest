// People: recruitment (jobs and candidates), learning and development (training courses and who has done
// them), performance (one-to-ones, probation reviews and appraisals) and areas (where each person can work).
import { assertLocation, requirePerm } from '../auth.js';
import { cvType, declineTemplate, fillTemplate, MAX_CV_BYTES } from '../careers-inbox.js';
import { tx } from '../db.js';
import { fromBase64 } from './invoices.js';
import { badRequest, date, id, notFound, num, oneOf, str, today } from '../util.js';

const STAGES = ['applied', 'interview', 'trial', 'offer', 'hired', 'rejected'];
const KINDS = ['one_to_one', 'probation', 'appraisal'];
const LEVELS = ['learning', 'trained'];
// Training that runs out within this many days shows as due soon.
const DUE_SOON_DAYS = 30;

// For lists: everything about a candidate but their message (which can be long), plus how many files they have.
const CANDIDATE_LIST = `c.id, c.vacancy_id, c.location_id, c.name, c.email, c.phone, c.stage, c.next_step_on, c.notes, c.source, c.subject,
  substr(c.message, 1, 240) AS preview, c.received_at, c.declined_at, c.reply_drafted_at, c.to_review_at, c.created_at, c.updated_at,
  (SELECT COUNT(*) FROM candidate_files f WHERE f.candidate_id = c.id) AS files`;

/** careers: the careers inbox (see mailbox.js), for drafting replies to candidates who emailed; or null. */
export function registerPeopleRoutes(router, db, { careers = null } = {}) {
  const perm = requirePerm('people.manage');

  // Active staff (not admins) at the sites this person can work with, or at one of them.
  const people = (req, locationId) => {
    if (locationId) assertLocation(req, locationId);
    const sites = locationId ? [locationId] : req.user.site_ids;
    if (!sites.length) return [];
    return db.prepare(`SELECT u.id, u.name, u.position, u.location_id, l.name AS location_name FROM users u
      LEFT JOIN locations l ON l.id = u.location_id
      WHERE u.active = 1 AND u.role != 'admin' AND u.location_id IN (${sites.map(() => '?').join(',')}) ORDER BY u.name`).all(...sites);
  };
  const site = (req) => id(req.query.location_id, 'location_id');
  // Someone this person can manage.
  const person = (req, userId) => {
    const u = db.prepare(`SELECT id, name, location_id FROM users WHERE id = ? AND role != 'admin'`).get(userId);
    if (!u || !req.user.site_ids.includes(u.location_id)) throw notFound('Person');
    return u;
  };

  // ---- Recruitment ----

  const vacancy = (req, vacancyId) => {
    const v = db.prepare('SELECT * FROM vacancies WHERE id = ?').get(vacancyId);
    if (!v || !req.user.site_ids.includes(v.location_id)) throw notFound('Job');
    return v;
  };

  router.get('/vacancies', perm, (req, res) => {
    const locationId = site(req);
    if (locationId) assertLocation(req, locationId);
    const sites = locationId ? [locationId] : req.user.site_ids;
    if (!sites.length) return res.json([]);
    const jobs = db.prepare(`SELECT v.*, l.name AS location_name FROM vacancies v JOIN locations l ON l.id = v.location_id
      WHERE v.location_id IN (${sites.map(() => '?').join(',')})
      ORDER BY CASE v.status WHEN 'open' THEN 0 ELSE 1 END, v.created_at DESC, v.id DESC`).all(...sites);
    const cands = db.prepare(`SELECT ${CANDIDATE_LIST} FROM candidates c WHERE c.vacancy_id = ? ORDER BY c.created_at, c.id`);
    res.json(jobs.map((j) => ({ ...j, candidates: cands.all(j.id) })));
  });

  const vacancyFields = (b) => ({
    title: str(b.title, 'Job title', { required: true, max: 100 }),
    hours: str(b.hours, 'Hours', { max: 100 }),
    notes: str(b.notes, 'Notes', { max: 2000 }),
  });

  router.post('/vacancies', perm, (req, res) => {
    const b = req.body ?? {};
    const locationId = id(b.location_id, 'location_id', { required: true });
    assertLocation(req, locationId);
    const f = vacancyFields(b);
    const r = db.prepare('INSERT INTO vacancies (location_id, title, hours, notes, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(locationId, f.title, f.hours, f.notes, req.user.id);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  router.put('/vacancies/:id', perm, (req, res) => {
    const v = vacancy(req, Number(req.params.id));
    const b = req.body ?? {};
    const f = vacancyFields({ ...v, ...b });
    const status = oneOf(b.status ?? v.status, 'status', ['open', 'filled', 'closed'], { required: true });
    db.prepare('UPDATE vacancies SET title = ?, hours = ?, notes = ?, status = ? WHERE id = ?').run(f.title, f.hours, f.notes, status, v.id);
    res.json({ ok: true });
  });

  // The job goes; its candidates stay (at the job's site), no longer for a particular job.
  router.delete('/vacancies/:id', perm, (req, res) => {
    const v = vacancy(req, Number(req.params.id));
    const kept = tx(db, () => {
      const r = db.prepare(`UPDATE candidates SET vacancy_id = NULL, location_id = COALESCE(location_id, ?), updated_at = datetime('now') WHERE vacancy_id = ?`).run(v.location_id, v.id);
      db.prepare('DELETE FROM vacancies WHERE id = ?').run(v.id);
      return Number(r.changes);
    });
    res.json({ ok: true, kept });
  });

  const candidateFields = (b) => ({
    name: str(b.name, 'Name', { required: true, max: 100 }),
    email: str(b.email, 'Email', { max: 200 }),
    phone: str(b.phone, 'Phone', { max: 50 }),
    stage: oneOf(b.stage ?? 'applied', 'stage', STAGES, { required: true }),
    next_step_on: date(b.next_step_on, 'Next step date'),
    notes: str(b.notes, 'Notes', { max: 4000 }),
  });

  // Someone not for a particular job (e.g. a CV handed in), at a site; with to_review they go on the To review list.
  router.post('/candidates', perm, (req, res) => {
    const b = req.body ?? {};
    const f = candidateFields(b);
    const site = id(b.location_id, 'location_id');
    if (site) assertLocation(req, site);
    const r = db.prepare(`INSERT INTO candidates (location_id, name, email, phone, stage, next_step_on, notes, to_review_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') END)`)
      .run(site, f.name, f.email, f.phone, f.stage, f.next_step_on, f.notes, b.to_review ? 1 : 0);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  router.post('/vacancies/:id/candidates', perm, (req, res) => {
    const v = vacancy(req, Number(req.params.id));
    const f = candidateFields(req.body ?? {});
    const r = db.prepare('INSERT INTO candidates (vacancy_id, name, email, phone, stage, next_step_on, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(v.id, f.name, f.email, f.phone, f.stage, f.next_step_on, f.notes);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  // Who can see a candidate: for a job, those who manage its site; not for a job, those who manage the site they
  // mentioned, or anyone using People if they didn't mention one.
  const canSee = (req, c) => {
    if (c.vacancy_id) {
      const v = db.prepare('SELECT location_id FROM vacancies WHERE id = ?').get(c.vacancy_id);
      return !!v && req.user.site_ids.includes(v.location_id);
    }
    return !c.location_id || req.user.site_ids.includes(c.location_id);
  };
  const candidate = (req, candidateId) => {
    const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
    if (!c || !canSee(req, c)) throw notFound('Candidate');
    return c;
  };

  // The careers inbox's new applications (not yet moved on or turned down), everyone being interviewed, on a trial
  // shift or offered a job (whatever it's for), and the rest of those who aren't for a job.
  router.get('/applications', perm, (req, res) => {
    const rows = db.prepare(`SELECT ${CANDIDATE_LIST}, v.title AS job_title, COALESCE(v.location_id, c.location_id) AS site_id, l.name AS site_name
      FROM candidates c LEFT JOIN vacancies v ON v.id = c.vacancy_id LEFT JOIN locations l ON l.id = COALESCE(v.location_id, c.location_id)
      WHERE (c.source = 'email' AND c.stage = 'applied') OR c.vacancy_id IS NULL OR c.stage IN ('interview', 'trial', 'offer') OR c.to_review_at IS NOT NULL
      ORDER BY COALESCE(c.received_at, c.created_at) DESC, c.id DESC`).all().filter((c) => canSee(req, c));
    const going = (c) => ['interview', 'trial', 'offer'].includes(c.stage);
    // Those on the To review list show there rather than with the new applications or those not for a job.
    const review = (c) => !!c.to_review_at && !going(c);
    res.json({
      // Oldest on the list first.
      to_review: rows.filter(review).sort((a, b) => a.to_review_at.localeCompare(b.to_review_at) || a.id - b.id),
      new: rows.filter((c) => !review(c) && c.source === 'email' && c.stage === 'applied'),
      // Soonest next step first; those without one after.
      in_progress: rows.filter(going).sort((a, b) => (a.next_step_on ?? '9999').localeCompare(b.next_step_on ?? '9999')),
      no_job: rows.filter((c) => !review(c) && !c.vacancy_id && !going(c) && !(c.source === 'email' && c.stage === 'applied')),
    });
  });

  // A candidate's profile: their details, the email they sent, and their files.
  router.get('/candidates/:id', perm, (req, res) => {
    const c = candidate(req, Number(req.params.id));
    const v = c.vacancy_id ? db.prepare('SELECT v.title, v.location_id, l.name AS site FROM vacancies v JOIN locations l ON l.id = v.location_id WHERE v.id = ?').get(c.vacancy_id) : null;
    res.json({
      ...c,
      job_title: v?.title ?? null,
      site_id: v?.location_id ?? c.location_id,
      site_name: v?.site ?? (c.location_id ? db.prepare('SELECT name FROM locations WHERE id = ?').get(c.location_id)?.name : null),
      files: db.prepare('SELECT id, file_name, file_type, size, created_at FROM candidate_files WHERE candidate_id = ? ORDER BY id').all(c.id),
      can_draft_reply: !!(careers && c.email_message_id),
      decline: (() => {
        const t = declineTemplate(db);
        const job = v?.title ?? null;
        return { subject: fillTemplate(t.subject, { name: c.name, job }), body: fillTemplate(t.body, { name: c.name, job }) };
      })(),
    });
  });

  router.put('/candidates/:id', perm, (req, res) => {
    const c = candidate(req, Number(req.params.id));
    const b = req.body ?? {};
    const f = candidateFields({ ...c, ...b });
    // Moving them to a job (or off one).
    let vacancyId = c.vacancy_id;
    let locationId = c.location_id;
    if (b.vacancy_id !== undefined) {
      vacancyId = id(b.vacancy_id, 'vacancy_id');
      if (vacancyId) locationId = vacancy(req, vacancyId).location_id;
    }
    // Moving them on (or turning them down) takes them off the To review list.
    db.prepare(`UPDATE candidates SET name = ?, email = ?, phone = ?, stage = ?, next_step_on = ?, notes = ?, vacancy_id = ?, location_id = ?,
      declined_at = CASE WHEN ? = 'rejected' THEN declined_at ELSE NULL END,
      to_review_at = CASE WHEN ? = stage THEN to_review_at END, updated_at = datetime('now') WHERE id = ?`)
      .run(f.name, f.email, f.phone, f.stage, f.next_step_on, f.notes, vacancyId, locationId, f.stage, f.stage, c.id);
    res.json({ ok: true });
  });

  // On or off the To review list: { to_review: true | false }.
  router.post('/candidates/:id/review', perm, (req, res) => {
    const c = candidate(req, Number(req.params.id));
    const on = !!req.body?.to_review;
    db.prepare(`UPDATE candidates SET to_review_at = CASE WHEN ? THEN COALESCE(to_review_at, datetime('now')) END, updated_at = datetime('now') WHERE id = ?`).run(on ? 1 : 0, c.id);
    res.json({ ok: true, to_review: on });
  });

  // Not taking them further. With draft: true (and the careers inbox connected), a reply is saved in the careers
  // inbox's Drafts to check and send from there; either way the wording comes back for copying or sending by hand.
  router.post('/candidates/:id/decline', perm, async (req, res) => {
    const c = candidate(req, Number(req.params.id));
    const subject = str(req.body?.subject, 'Subject', { required: true, max: 200 });
    const body = str(req.body?.body, 'Message', { required: true, max: 5000 });
    db.prepare(`UPDATE candidates SET stage = 'rejected', declined_at = datetime('now'), to_review_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(c.id);
    const out = { ok: true, to: c.email, subject, body, draft: 'none' };
    if (req.body?.draft && careers && c.email_message_id) {
      try {
        const d = await careers.replyDraft(c.email_message_id, body);
        db.prepare(`UPDATE candidates SET reply_drafted_at = datetime('now') WHERE id = ?`).run(c.id);
        Object.assign(out, { draft: 'created', web_link: d.webLink, mailbox: careers.address });
      } catch (err) {
        Object.assign(out, { draft: 'failed', error: err.message });
      }
    }
    res.json(out);
  });

  // Their CV and anything else they sent (or that was added).
  router.get('/candidates/:id/files/:fileId', perm, (req, res) => {
    const c = candidate(req, Number(req.params.id));
    const f = db.prepare('SELECT file_name, file_type, file FROM candidate_files WHERE id = ? AND candidate_id = ?').get(Number(req.params.fileId), c.id);
    if (!f) throw notFound('File');
    res.setHeader('Content-Type', f.file_type);
    res.setHeader('Content-Disposition', `${f.file_type === 'application/pdf' || f.file_type.startsWith('image/') ? 'inline' : 'attachment'}; filename="${f.file_name.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(globalThis.Buffer ? Buffer.from(f.file) : f.file);
  });

  // { file_name, data (base64) } – e.g. a CV handed in on paper and photographed.
  router.post('/candidates/:id/files', perm, (req, res) => {
    const c = candidate(req, Number(req.params.id));
    const name = str(req.body?.file_name, 'File name', { required: true, max: 200 });
    const type = cvType(name, req.body?.media_type);
    if (!type) throw badRequest('That type of file can’t be added – use a PDF, Word document or photo');
    const bytes = fromBase64(String(req.body?.data ?? ''));
    if (!bytes.length) throw badRequest('The file is empty');
    if (bytes.length > MAX_CV_BYTES) throw badRequest('Files can be up to 10 MB');
    const r = db.prepare('INSERT INTO candidate_files (candidate_id, file_name, file_type, size, file) VALUES (?, ?, ?, ?, ?)').run(c.id, name, type, bytes.length, bytes);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  router.delete('/candidates/:id/files/:fileId', perm, (req, res) => {
    const c = candidate(req, Number(req.params.id));
    db.prepare('DELETE FROM candidate_files WHERE id = ? AND candidate_id = ?').run(Number(req.params.fileId), c.id);
    res.json({ ok: true });
  });

  // Gone for good – e.g. junk from the careers inbox. The inbox keeps its note of the email (without the candidate),
  // so it isn't added again on the next check.
  router.delete('/candidates/:id', perm, (req, res) => {
    const c = candidate(req, Number(req.params.id));
    tx(db, () => {
      if (c.email_message_id) db.prepare(`UPDATE careers_emails SET detail = 'Deleted in Atlas' WHERE message_id = ?`).run(c.email_message_id);
      db.prepare('DELETE FROM candidates WHERE id = ?').run(c.id);
    });
    res.json({ ok: true });
  });

  // ---- Learning and development ----

  // Someone's latest record of each (current) course, and whether it's still in date: done, due_soon or expired.
  const latest = db.prepare(`SELECT r.id, r.course_id, r.user_id, r.completed_on, r.notes,
      CASE WHEN c.renew_months THEN date(r.completed_on, '+' || c.renew_months || ' months') END AS expires_on
    FROM training_records r JOIN training_courses c ON c.id = r.course_id
    WHERE r.user_id = ? AND c.active = 1 AND r.id = (SELECT r2.id FROM training_records r2 WHERE r2.user_id = r.user_id AND r2.course_id = r.course_id
      ORDER BY r2.completed_on DESC, r2.id DESC LIMIT 1)`);
  const latestFor = (userIds) => {
    const now = today();
    const soon = db.prepare(`SELECT date(?, '+${DUE_SOON_DAYS} days') AS d`).get(now).d;
    return userIds.flatMap((u) => latest.all(u)).map((r) => ({
      ...r,
      status: !r.expires_on ? 'done' : r.expires_on < now ? 'expired' : r.expires_on <= soon ? 'due_soon' : 'done',
    }));
  };
  const activeCourses = () => db.prepare('SELECT * FROM training_courses WHERE active = 1 ORDER BY name').all();

  // Each person's latest record of each course.
  router.get('/training', perm, (req, res) => {
    const staff = people(req, site(req));
    res.json({ courses: activeCourses(), people: staff, records: latestFor(staff.map((p) => p.id)) });
  });

  // My Atlas: the training the signed-in person has done (anyone can see their own), and the courses they haven't.
  router.get('/training/mine', (req, res) => {
    const records = latestFor([req.user.id]);
    const done = new Set(records.map((r) => r.course_id));
    const courses = activeCourses();
    const name = new Map(courses.map((c) => [c.id, c.name]));
    res.json({
      records: records.map((r) => ({ course_id: r.course_id, course_name: name.get(r.course_id), completed_on: r.completed_on, expires_on: r.expires_on, status: r.status }))
        .sort((a, b) => a.course_name.localeCompare(b.course_name)),
      not_done: courses.filter((c) => !done.has(c.id)).map((c) => ({ course_id: c.id, course_name: c.name })),
    });
  });

  // Everything someone has done (newest first).
  router.get('/training/people/:userId', perm, (req, res) => {
    const u = person(req, Number(req.params.userId));
    res.json({
      person: u,
      records: db.prepare(`SELECT r.id, r.course_id, c.name AS course_name, r.completed_on, r.notes, rb.name AS recorded_by_name
        FROM training_records r JOIN training_courses c ON c.id = r.course_id LEFT JOIN users rb ON rb.id = r.recorded_by
        WHERE r.user_id = ? ORDER BY r.completed_on DESC, r.id DESC`).all(u.id),
    });
  });

  const courseFields = (b) => ({
    name: str(b.name, 'Course name', { required: true, max: 100 }),
    description: str(b.description, 'Description', { max: 1000 }),
    renew_months: num(b.renew_months, 'Renew every (months)', { int: true, min: 1, max: 120 }),
  });

  router.post('/training/courses', perm, (req, res) => {
    const f = courseFields(req.body ?? {});
    const r = db.prepare('INSERT INTO training_courses (name, description, renew_months) VALUES (?, ?, ?)').run(f.name, f.description, f.renew_months);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  router.put('/training/courses/:id', perm, (req, res) => {
    const c = db.prepare('SELECT * FROM training_courses WHERE id = ? AND active = 1').get(Number(req.params.id));
    if (!c) throw notFound('Course');
    const f = courseFields({ ...c, ...(req.body ?? {}) });
    db.prepare('UPDATE training_courses SET name = ?, description = ?, renew_months = ? WHERE id = ?').run(f.name, f.description, f.renew_months, c.id);
    res.json({ ok: true });
  });

  // Courses are hidden rather than deleted, so nobody's training records are lost.
  router.delete('/training/courses/:id', perm, (req, res) => {
    db.prepare('UPDATE training_courses SET active = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // { course_id, user_ids: [...], completed_on, notes } – several people can be signed off at once.
  router.post('/training/records', perm, (req, res) => {
    const b = req.body ?? {};
    const course = db.prepare('SELECT id FROM training_courses WHERE id = ? AND active = 1').get(id(b.course_id, 'course_id', { required: true }));
    if (!course) throw notFound('Course');
    const userIds = (Array.isArray(b.user_ids) ? b.user_ids : [b.user_id]).map((u) => id(u, 'user_id', { required: true }));
    if (!userIds.length) throw badRequest('Choose who did the training');
    const done = date(b.completed_on, 'Date completed', { required: true });
    if (done > today()) throw badRequest('The date completed can’t be in the future');
    const notes = str(b.notes, 'Notes', { max: 1000 });
    for (const u of userIds) person(req, u);
    const insert = db.prepare('INSERT INTO training_records (course_id, user_id, completed_on, notes, recorded_by) VALUES (?, ?, ?, ?, ?)');
    for (const u of userIds) insert.run(course.id, u, done, notes, req.user.id);
    res.status(201).json({ ok: true, added: userIds.length });
  });

  router.delete('/training/records/:id', perm, (req, res) => {
    const r = db.prepare('SELECT id, user_id FROM training_records WHERE id = ?').get(Number(req.params.id));
    if (!r) throw notFound('Training record');
    person(req, r.user_id);
    db.prepare('DELETE FROM training_records WHERE id = ?').run(r.id);
    res.json({ ok: true });
  });

  // ---- Performance ----

  // Everyone with their last review and when the next is due.
  router.get('/performance', perm, (req, res) => {
    const last = db.prepare(`SELECT review_date, kind, rating, next_review_on FROM performance_reviews WHERE user_id = ?
      ORDER BY review_date DESC, id DESC LIMIT 1`);
    const count = db.prepare('SELECT COUNT(*) AS n FROM performance_reviews WHERE user_id = ?');
    const now = today();
    res.json(people(req, site(req)).map((p) => {
      const l = last.get(p.id) ?? null;
      return { ...p, last: l, reviews: count.get(p.id).n, overdue: !!(l?.next_review_on && l.next_review_on < now) };
    }));
  });

  router.get('/performance/people/:userId', perm, (req, res) => {
    const u = person(req, Number(req.params.userId));
    res.json({
      person: u,
      reviews: db.prepare(`SELECT r.*, rv.name AS reviewer_name FROM performance_reviews r LEFT JOIN users rv ON rv.id = r.reviewer_id
        WHERE r.user_id = ? ORDER BY r.review_date DESC, r.id DESC`).all(u.id),
    });
  });

  const reviewFields = (b) => {
    const f = {
      review_date: date(b.review_date, 'Date', { required: true }),
      kind: oneOf(b.kind ?? 'one_to_one', 'type', KINDS, { required: true }),
      rating: num(b.rating, 'Rating', { int: true, min: 1, max: 5 }),
      went_well: str(b.went_well, 'What went well', { max: 4000 }),
      to_improve: str(b.to_improve, 'What to work on', { max: 4000 }),
      goals: str(b.goals, 'Goals', { max: 4000 }),
      next_review_on: date(b.next_review_on, 'Next review'),
    };
    if (f.next_review_on && f.next_review_on < f.review_date) throw badRequest('The next review should be after this one');
    return f;
  };

  router.post('/performance/reviews', perm, (req, res) => {
    const b = req.body ?? {};
    const u = person(req, id(b.user_id, 'user_id', { required: true }));
    const f = reviewFields(b);
    const r = db.prepare(`INSERT INTO performance_reviews (user_id, review_date, kind, rating, went_well, to_improve, goals, next_review_on, reviewer_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(u.id, f.review_date, f.kind, f.rating, f.went_well, f.to_improve, f.goals, f.next_review_on, req.user.id);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  const review = (req, reviewId) => {
    const r = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(reviewId);
    if (!r) throw notFound('Review');
    person(req, r.user_id);
    return r;
  };

  router.put('/performance/reviews/:id', perm, (req, res) => {
    const r = review(req, Number(req.params.id));
    const f = reviewFields({ ...r, ...(req.body ?? {}) });
    db.prepare(`UPDATE performance_reviews SET review_date = ?, kind = ?, rating = ?, went_well = ?, to_improve = ?, goals = ?, next_review_on = ? WHERE id = ?`)
      .run(f.review_date, f.kind, f.rating, f.went_well, f.to_improve, f.goals, f.next_review_on, r.id);
    res.json({ ok: true });
  });

  router.delete('/performance/reviews/:id', perm, (req, res) => {
    db.prepare('DELETE FROM performance_reviews WHERE id = ?').run(review(req, Number(req.params.id)).id);
    res.json({ ok: true });
  });

  // ---- Areas ----

  router.get('/areas', perm, (req, res) => {
    const staff = people(req, site(req));
    const ids = new Set(staff.map((p) => p.id));
    res.json({
      areas: db.prepare('SELECT id, name FROM work_areas WHERE active = 1 ORDER BY name').all(),
      people: staff,
      links: db.prepare('SELECT ua.user_id, ua.area_id, ua.level FROM user_areas ua JOIN work_areas a ON a.id = ua.area_id WHERE a.active = 1')
        .all().filter((l) => ids.has(l.user_id)),
    });
  });

  router.post('/areas', perm, (req, res) => {
    const name = str(req.body?.name, 'Area name', { required: true, max: 60 });
    const old = db.prepare('SELECT id, active FROM work_areas WHERE name = ?').get(name);
    if (old?.active) throw badRequest(`There’s already an area called ${name}`);
    if (old) {
      db.prepare('UPDATE work_areas SET active = 1, name = ? WHERE id = ?').run(name, old.id);
      return res.status(201).json({ id: old.id });
    }
    res.status(201).json({ id: Number(db.prepare('INSERT INTO work_areas (name) VALUES (?)').run(name).lastInsertRowid) });
  });

  router.put('/areas/:id', perm, (req, res) => {
    const a = db.prepare('SELECT id FROM work_areas WHERE id = ? AND active = 1').get(Number(req.params.id));
    if (!a) throw notFound('Area');
    const name = str(req.body?.name, 'Area name', { required: true, max: 60 });
    if (db.prepare('SELECT 1 FROM work_areas WHERE name = ? AND id != ?').get(name, a.id)) throw badRequest(`There’s already an area called ${name}`);
    db.prepare('UPDATE work_areas SET name = ? WHERE id = ?').run(name, a.id);
    res.json({ ok: true });
  });

  // Hidden rather than deleted, so adding it back keeps who could work there.
  router.delete('/areas/:id', perm, (req, res) => {
    db.prepare('UPDATE work_areas SET active = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // { level: 'learning' | 'trained' | null }
  router.put('/areas/:id/people/:userId', perm, (req, res) => {
    const a = db.prepare('SELECT id FROM work_areas WHERE id = ? AND active = 1').get(Number(req.params.id));
    if (!a) throw notFound('Area');
    const u = person(req, Number(req.params.userId));
    const level = oneOf(req.body?.level || null, 'level', LEVELS);
    if (!level) db.prepare('DELETE FROM user_areas WHERE user_id = ? AND area_id = ?').run(u.id, a.id);
    else {
      db.prepare(`INSERT INTO user_areas (user_id, area_id, level) VALUES (?, ?, ?)
        ON CONFLICT (user_id, area_id) DO UPDATE SET level = excluded.level, updated_at = datetime('now')`).run(u.id, a.id, level);
    }
    res.json({ ok: true });
  });
}
