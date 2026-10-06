// People: recruitment (jobs and candidates), learning and development (training courses and who has done
// them), performance (one-to-ones, probation reviews and appraisals) and areas (where each person can work).
import { assertLocation, requirePerm } from '../auth.js';
import { badRequest, date, id, notFound, num, oneOf, str, today } from '../util.js';

const STAGES = ['applied', 'interview', 'trial', 'offer', 'hired', 'rejected'];
const KINDS = ['one_to_one', 'probation', 'appraisal'];
const LEVELS = ['learning', 'trained'];
// Training that runs out within this many days shows as due soon.
const DUE_SOON_DAYS = 30;

export function registerPeopleRoutes(router, db) {
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
    const cands = db.prepare('SELECT * FROM candidates WHERE vacancy_id = ? ORDER BY created_at, id');
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

  router.delete('/vacancies/:id', perm, (req, res) => {
    db.prepare('DELETE FROM vacancies WHERE id = ?').run(vacancy(req, Number(req.params.id)).id);
    res.json({ ok: true });
  });

  const candidateFields = (b) => ({
    name: str(b.name, 'Name', { required: true, max: 100 }),
    email: str(b.email, 'Email', { max: 200 }),
    phone: str(b.phone, 'Phone', { max: 50 }),
    stage: oneOf(b.stage ?? 'applied', 'stage', STAGES, { required: true }),
    next_step_on: date(b.next_step_on, 'Next step date'),
    notes: str(b.notes, 'Notes', { max: 4000 }),
  });

  router.post('/vacancies/:id/candidates', perm, (req, res) => {
    const v = vacancy(req, Number(req.params.id));
    const f = candidateFields(req.body ?? {});
    const r = db.prepare('INSERT INTO candidates (vacancy_id, name, email, phone, stage, next_step_on, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(v.id, f.name, f.email, f.phone, f.stage, f.next_step_on, f.notes);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  const candidate = (req, candidateId) => {
    const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
    if (!c) throw notFound('Candidate');
    vacancy(req, c.vacancy_id);
    return c;
  };

  router.put('/candidates/:id', perm, (req, res) => {
    const c = candidate(req, Number(req.params.id));
    const f = candidateFields({ ...c, ...(req.body ?? {}) });
    db.prepare(`UPDATE candidates SET name = ?, email = ?, phone = ?, stage = ?, next_step_on = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(f.name, f.email, f.phone, f.stage, f.next_step_on, f.notes, c.id);
    res.json({ ok: true });
  });

  router.delete('/candidates/:id', perm, (req, res) => {
    db.prepare('DELETE FROM candidates WHERE id = ?').run(candidate(req, Number(req.params.id)).id);
    res.json({ ok: true });
  });

  // ---- Learning and development ----

  // Each person's latest record of each course, and whether it's still in date.
  router.get('/training', perm, (req, res) => {
    const staff = people(req, site(req));
    const courses = db.prepare('SELECT * FROM training_courses WHERE active = 1 ORDER BY name').all();
    const now = today();
    const soon = db.prepare(`SELECT date(?, '+${DUE_SOON_DAYS} days') AS d`).get(now).d;
    const latest = db.prepare(`SELECT r.id, r.course_id, r.user_id, r.completed_on, r.notes,
        CASE WHEN c.renew_months THEN date(r.completed_on, '+' || c.renew_months || ' months') END AS expires_on
      FROM training_records r JOIN training_courses c ON c.id = r.course_id
      WHERE r.user_id = ? AND r.id = (SELECT r2.id FROM training_records r2 WHERE r2.user_id = r.user_id AND r2.course_id = r.course_id
        ORDER BY r2.completed_on DESC, r2.id DESC LIMIT 1)`);
    const records = staff.flatMap((p) => latest.all(p.id)).map((r) => ({
      ...r,
      status: !r.expires_on ? 'done' : r.expires_on < now ? 'expired' : r.expires_on <= soon ? 'due_soon' : 'done',
    }));
    res.json({ courses, people: staff, records });
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
