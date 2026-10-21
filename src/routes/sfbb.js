// Safer Food, Better Business (the Food Standards Agency's food safety pack for caterers), per site: each safe
// method's answers and sign-off, the diary (opening / closing checks, problems and the manager's daily sign-off,
// weekly extra checks), the 4-weekly review, the staff training record, and the records kept with the pack
// (cleaning schedule, 'Prove it' checks, contacts). The opening and closing checks themselves are the site's
// Food Safety Checks.
import { assertLocation, requirePerm, resolveLocation } from '../auth.js';
import { tasksAt } from '../dashboard.js';
import { tx } from '../db.js';
import { addDays, badRequest, bool, date, id, notFound, num, oneOf, str, today, weekStart } from '../util.js';
import { SFBB_CLOSING, SFBB_METHODS, SFBB_OPENING, SFBB_REVIEW_CHECKS, SFBB_TRAINING_EXTRAS } from '../../public/js/sfbb-content.js';

const METHOD_KEYS = new Set(SFBB_METHODS.map((m) => m.key));
const TOPICS = new Set([...METHOD_KEYS, ...SFBB_TRAINING_EXTRAS.map(([k]) => k)]);
const CLEANING_FREQUENCIES = ['After use', 'Every shift', 'Daily', 'Weekly', 'Monthly', 'Other'];
const REVIEW_DAYS = 28;
const isOpening = (t) => /open/i.test(t.category);
const isClosing = (t) => /clos/i.test(t.category);

// A starter cleaning schedule (the pack's own examples first), for a site to change to suit.
const STARTER_CLEANING = [
  ['Work surfaces', 'After use', 'Wear gloves', '1. Remove any obvious food and dirt. 2. Wash with hot soapy water (detergent diluted as the label says). 3. Rinse with clean water. 4. Apply disinfectant and leave it for the contact time on the label. 5. Rinse with clean water. 6. Leave to dry naturally or use a clean disposable cloth.'],
  ['Fridges', 'Weekly', 'Wear gloves', '1. Move all food somewhere cold (another fridge or a cool box). 2. Take out shelves and compartments, wash in hot soapy water, then disinfect and let them dry. 3. Wash and disinfect all inside surfaces and dry with a clean cloth. 4. Put the shelves and food back. 5. Clean the outside and door seals, and disinfect the handles.'],
  ['Chopping boards and knives', 'After use', null, 'Wash in the dishwasher, or in hot soapy water then disinfect, and leave to dry. Keep colour-coded boards for raw and ready-to-eat food.'],
  ['Frequently touched items (handles, taps, switches, till, scales, probes)', 'Every shift', null, 'Two-stage clean: clean with detergent or sanitiser, then disinfect and leave for the contact time.'],
  ['Sinks and hand wash basins', 'Daily', 'Wear gloves', 'Clear, clean with detergent, rinse, disinfect including taps and soap dispensers.'],
  ['Floors', 'Daily', null, 'Sweep, then mop with hot water and detergent, taking care not to splash food surfaces.'],
  ['Bins and waste area', 'Daily', 'Wear gloves', 'Empty, wash and disinfect bins and lids; sweep and wash down the waste area.'],
  ['Microwave, oven and hot holding', 'Daily', 'Let it cool first', 'Remove food debris, wash with detergent, rinse and dry. Degrease ovens as the manufacturer says.'],
  ['Extractor canopy and filters', 'Weekly', 'Wear gloves', 'Remove filters and soak in degreaser or put through the dishwasher; wipe down the canopy.'],
  ['Dishwasher', 'Daily', null, 'Empty and clean the filters and jets, wipe the door seals. Descale as the manufacturer says.'],
];

const STARTER_CONTACTS = ['Environmental Health team', 'Pest control contractor', 'Electrician', 'Plumber', 'Refrigeration engineer', 'Waste collection'];

export function registerSfbbRoutes(router, db) {
  const VIEW = requirePerm('safety.complete', 'safety.manage', 'safety.report');
  const MANAGE = requirePerm('safety.manage');
  const methodKey = (k) => {
    if (!METHOD_KEYS.has(k)) throw notFound('Safe method');
    return k;
  };
  const lastReview = (locationId) => db.prepare(`SELECT r.*, u.name AS signed_by_name FROM sfbb_reviews r LEFT JOIN users u ON u.id = r.signed_by
    WHERE r.location_id = ? ORDER BY r.date DESC, r.id DESC LIMIT 1`).get(locationId) ?? null;

  // --- The pack: every safe method's state at a site ---

  router.get('/sfbb/pack', VIEW, (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    const rows = db.prepare(`SELECT m.*, u.name AS completed_by_name FROM sfbb_methods m LEFT JOIN users u ON u.id = m.completed_by
      WHERE m.location_id = ?`).all(locationId);
    const methods = Object.fromEntries(rows.map((r) => [r.method_key, { ...r, answers: JSON.parse(r.answers || '{}') }]));
    const review = lastReview(locationId);
    // Days in the last week (not counting today) the diary wasn't signed.
    const days = Array.from({ length: 7 }, (_, i) => addDays(today(), -(i + 1)));
    const signed = new Set(db.prepare(`SELECT date FROM sfbb_diary WHERE location_id = ? AND signed_at IS NOT NULL AND date >= ?`)
      .all(locationId, days[6]).map((r) => r.date));
    res.json({
      location_id: locationId, methods,
      last_review: review, review_due: review ? addDays(review.date, REVIEW_DAYS) : today(),
      unsigned_days: days.filter((d) => !signed.has(d)).length,
    });
  });

  // Saves a safe method's answers; complete: true signs it off, not_relevant: true marks it as not relevant here.
  router.put('/sfbb/methods/:key', MANAGE, (req, res) => {
    const key = methodKey(req.params.key);
    const locationId = resolveLocation(req, req.body.location_id);
    const raw = req.body.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    const answers = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!/^\d{1,2}$/.test(k) || !v || typeof v !== 'object') continue;
      answers[k] = { answer: ['yes', 'no'].includes(v.answer) ? v.answer : null, note: str(v.note, 'note', { max: 2000 }) };
    }
    const notRelevant = bool(req.body.not_relevant);
    const complete = req.body.complete === undefined ? undefined : bool(req.body.complete);
    const existing = db.prepare('SELECT * FROM sfbb_methods WHERE location_id = ? AND method_key = ?').get(locationId, key);
    // Signing off (or marking not relevant) records who and when; un-ticking clears it; otherwise it's left as it was.
    const signed = complete === 1 || notRelevant ? [req.user.id, new Date().toISOString()]
      : complete === 0 ? [null, null] : [existing?.completed_by ?? null, existing?.completed_at ?? null];
    db.prepare(`INSERT INTO sfbb_methods (location_id, method_key, answers, not_relevant, completed_by, completed_at, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (location_id, method_key) DO UPDATE SET answers = excluded.answers, not_relevant = excluded.not_relevant,
        completed_by = excluded.completed_by, completed_at = excluded.completed_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(locationId, key, JSON.stringify(answers), notRelevant, ...signed, req.user.id);
    res.json({ ok: true });
  });

  // The pack's opening and closing checks: which a site's Food Safety Checks already have, and adding the rest.
  const sfbbChecks = (locationId) => {
    const have = new Set(tasksAt(db, locationId).map((t) => t.title.trim().toLowerCase()));
    return [...SFBB_OPENING.map((title) => ({ title, category: 'Opening checks' })), ...SFBB_CLOSING.map((title) => ({ title, category: 'Closing checks' }))]
      .map((c) => ({ ...c, added: have.has(c.title.toLowerCase()) }));
  };
  router.get('/sfbb/checks', VIEW, (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    res.json({ location_id: locationId, checks: sfbbChecks(locationId) });
  });
  router.post('/sfbb/checks', MANAGE, (req, res) => {
    const locationId = resolveLocation(req, req.body.location_id);
    const missing = sfbbChecks(locationId).filter((c) => !c.added);
    const insert = db.prepare(`INSERT INTO safety_tasks (title, category, frequency, location_id, sort_order) VALUES (?, ?, 'daily', ?, ?)`);
    tx(db, () => missing.forEach((c, i) => insert.run(c.title, c.category, locationId, 100 + i)));
    res.status(201).json({ added: missing.length });
  });

  // --- The diary ---

  router.get('/sfbb/diary', VIEW, (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    const ws = weekStart(date(req.query.week, 'week') ?? today());
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const tasks = tasksAt(db, locationId).filter((t) => t.frequency === 'daily');
    const checks = db.prepare(`SELECT c.*, t.title, u.name AS completed_by_name FROM safety_checks c JOIN safety_tasks t ON t.id = c.task_id
      LEFT JOIN users u ON u.id = c.completed_by WHERE c.location_id = ? AND c.period BETWEEN ? AND ?`).all(locationId, days[0], days[6]);
    const entries = new Map(db.prepare(`SELECT d.*, u.name AS signed_by_name FROM sfbb_diary d LEFT JOIN users u ON u.id = d.signed_by
      WHERE d.location_id = ? AND d.date BETWEEN ? AND ?`).all(locationId, days[0], days[6]).map((r) => [r.date, r]));
    const tally = (list, d) => ({ total: list.length, done: list.filter((t) => checks.some((c) => c.task_id === t.id && c.period === d)).length });
    const week = db.prepare('SELECT w.*, u.name AS updated_by_name FROM sfbb_weeks w LEFT JOIN users u ON u.id = w.updated_by WHERE w.location_id = ? AND w.week_start = ?').get(locationId, ws);
    res.json({
      location_id: locationId, week_start: ws, today: today(),
      days: days.map((d) => {
        const e = entries.get(d);
        return {
          date: d, opening: tally(tasks.filter(isOpening), d), closing: tally(tasks.filter(isClosing), d),
          all: tally(tasks, d),
          problems: checks.filter((c) => c.period === d && c.status === 'fail')
            .map((c) => ({ title: c.title, reading: c.reading, corrective_action: c.corrective_action, by: c.completed_by_name })),
          notes: e?.notes ?? null, signed_by_name: e?.signed_at ? e.signed_by_name : null, signed_at: e?.signed_at ?? null,
        };
      }),
      extra_checks: week?.extra_checks ?? null, extra_checks_by: week?.updated_by_name ?? null,
      last_review: lastReview(locationId),
    });
  });

  const diaryDate = (raw) => {
    const d = date(raw, 'date', { required: true });
    if (d > today()) throw badRequest('The diary can’t be filled in for a future day');
    return d;
  };
  router.put('/sfbb/diary/:date', requirePerm('safety.complete', 'safety.manage'), (req, res) => {
    const d = diaryDate(req.params.date);
    const locationId = resolveLocation(req, req.body.location_id);
    db.prepare(`INSERT INTO sfbb_diary (location_id, date, notes) VALUES (?, ?, ?)
      ON CONFLICT (location_id, date) DO UPDATE SET notes = excluded.notes`).run(locationId, d, str(req.body.notes, 'notes', { max: 4000 }));
    res.json({ ok: true });
  });
  // Signing confirms the opening and closing checks were done and the safe methods were followed and supervised.
  router.post('/sfbb/diary/:date/sign', MANAGE, (req, res) => {
    const d = diaryDate(req.params.date);
    const locationId = resolveLocation(req, req.body.location_id);
    const signing = req.body.signed === undefined ? true : !!bool(req.body.signed);
    db.prepare(`INSERT INTO sfbb_diary (location_id, date, signed_by, signed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (location_id, date) DO UPDATE SET signed_by = excluded.signed_by, signed_at = excluded.signed_at`)
      .run(locationId, d, signing ? req.user.id : null, signing ? new Date().toISOString() : null);
    res.json({ ok: true });
  });
  router.put('/sfbb/weeks/:week', requirePerm('safety.complete', 'safety.manage'), (req, res) => {
    const ws = weekStart(date(req.params.week, 'week', { required: true }));
    const locationId = resolveLocation(req, req.body.location_id);
    db.prepare(`INSERT INTO sfbb_weeks (location_id, week_start, extra_checks, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (location_id, week_start) DO UPDATE SET extra_checks = excluded.extra_checks, updated_by = excluded.updated_by, updated_at = datetime('now')`)
      .run(locationId, ws, str(req.body.extra_checks, 'extra_checks', { max: 4000 }), req.user.id);
    res.json({ ok: true });
  });

  // --- The 4-weekly review ---

  router.get('/sfbb/reviews', VIEW, (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    const from = addDays(today(), -REVIEW_DAYS);
    const reviews = db.prepare(`SELECT r.*, u.name AS signed_by_name FROM sfbb_reviews r LEFT JOIN users u ON u.id = r.signed_by
      WHERE r.location_id = ? ORDER BY r.date DESC, r.id DESC LIMIT 26`).all(locationId).map((r) => ({ ...r, checklist: JSON.parse(r.checklist || '{}') }));
    // To help: the last 4 weeks' failed checks (those that went wrong three times or more first) and diary notes.
    const repeats = db.prepare(`SELECT t.title, COUNT(*) AS times FROM safety_checks c JOIN safety_tasks t ON t.id = c.task_id
      WHERE c.location_id = ? AND c.status = 'fail' AND c.period >= ? GROUP BY t.id ORDER BY times DESC, t.title`).all(locationId, from);
    const notes = db.prepare(`SELECT date, notes FROM sfbb_diary WHERE location_id = ? AND date >= ? AND notes IS NOT NULL AND notes != '' ORDER BY date DESC`).all(locationId, from);
    const signed = db.prepare(`SELECT COUNT(*) AS n FROM sfbb_diary WHERE location_id = ? AND date >= ? AND date < ? AND signed_at IS NOT NULL`).get(locationId, from, today()).n;
    res.json({ location_id: locationId, reviews, since: from, repeats, notes, unsigned_days: REVIEW_DAYS - signed });
  });
  router.post('/sfbb/reviews', MANAGE, (req, res) => {
    const b = req.body;
    const locationId = resolveLocation(req, b.location_id);
    const checklist = {};
    SFBB_REVIEW_CHECKS.forEach((_, i) => {
      const v = b.checklist?.[i];
      if (v === 'yes' || v === 'no') checklist[i] = v;
    });
    const problems = bool(b.problems);
    const details = str(b.details, 'details', { max: 4000 });
    const action = str(b.action, 'action', { max: 4000 });
    if (problems && (!details || !action)) throw badRequest('Say what the problems were and what you did about them');
    const r = db.prepare(`INSERT INTO sfbb_reviews (location_id, date, problems, details, action, checklist, additional, signed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(locationId, date(b.date, 'date') ?? today(), problems, details, action, JSON.stringify(checklist), str(b.additional, 'additional', { max: 4000 }), req.user.id);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  // --- Staff training record ---

  // Everyone who works at the site (their home site, or a site they've been given), with what they've been trained on.
  router.get('/sfbb/training', VIEW, (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    const people = db.prepare(`SELECT id, name FROM users WHERE active = 1 AND (location_id = ? OR id IN (SELECT user_id FROM user_sites WHERE location_id = ?))
      ORDER BY name`).all(locationId, locationId);
    const ids = people.map((p) => p.id);
    const records = ids.length ? db.prepare(`SELECT t.*, u.name AS recorded_by_name FROM sfbb_training t LEFT JOIN users u ON u.id = t.recorded_by
      WHERE t.user_id IN (${ids.map(() => '?').join(',')}) ORDER BY t.date DESC`).all(...ids) : [];
    res.json({ location_id: locationId, people, records });
  });
  router.post('/sfbb/training', MANAGE, (req, res) => {
    const userIds = (Array.isArray(req.body.user_ids) ? req.body.user_ids : []).map((v) => id(v, 'user_ids', { required: true }));
    const topics = (Array.isArray(req.body.topics) ? req.body.topics : []).filter((t) => TOPICS.has(t));
    if (!userIds.length || !topics.length) throw badRequest('Choose who was trained and what on');
    const d = date(req.body.date, 'date') ?? today();
    const locationId = resolveLocation(req, req.body.location_id);
    const insert = db.prepare('INSERT OR IGNORE INTO sfbb_training (user_id, topic, date, recorded_by) VALUES (?, ?, ?, ?)');
    let added = 0;
    tx(db, () => {
      for (const u of userIds) {
        const ok = db.prepare(`SELECT 1 FROM users WHERE id = ? AND (location_id = ? OR id IN (SELECT user_id FROM user_sites WHERE location_id = ?))`).get(u, locationId, locationId);
        if (!ok) throw notFound('Person');
        for (const t of topics) added += insert.run(u, t, d, req.user.id).changes;
      }
    });
    res.status(201).json({ added });
  });
  router.delete('/sfbb/training/:id', MANAGE, (req, res) => {
    const r = db.prepare('SELECT t.*, u.location_id FROM sfbb_training t JOIN users u ON u.id = t.user_id WHERE t.id = ?').get(Number(req.params.id));
    if (!r) throw notFound('Training record');
    if (r.location_id) assertLocation(req, r.location_id);
    db.prepare('DELETE FROM sfbb_training WHERE id = ?').run(r.id);
    res.json({ ok: true });
  });

  // --- Records: cleaning schedule, 'Prove it' checks and contacts ---

  router.get('/sfbb/records', VIEW, (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    res.json({
      location_id: locationId,
      cleaning: db.prepare('SELECT * FROM sfbb_cleaning WHERE location_id = ? ORDER BY sort_order, id').all(locationId),
      prove_it: db.prepare(`SELECT p.*, u.name AS recorded_by_name FROM sfbb_prove_it p LEFT JOIN users u ON u.id = p.recorded_by
        WHERE p.location_id = ? ORDER BY p.date DESC, p.id DESC LIMIT 200`).all(locationId),
      contacts: db.prepare('SELECT * FROM sfbb_contacts WHERE location_id = ? ORDER BY id').all(locationId),
      frequencies: CLEANING_FREQUENCIES,
    });
  });

  // Each kind of record, by path: [table, permission to add one, request body → row].
  const KINDS = {
    cleaning: ['sfbb_cleaning', MANAGE, (b) => ({
      item: str(b.item, 'item', { required: true, max: 200 }),
      frequency: oneOf(b.frequency, 'frequency', CLEANING_FREQUENCIES, { required: true }),
      precautions: str(b.precautions, 'precautions', { max: 300 }),
      method: str(b.method, 'method', { max: 3000 }),
      sort_order: num(b.sort_order, 'sort_order', { int: true }) ?? 0,
    })],
    'prove-it': ['sfbb_prove_it', requirePerm('safety.complete', 'safety.manage'), (b, req) => ({
      method_key: methodKey(b.method_key),
      how: str(b.how, 'how', { required: true, max: 2000 }),
      date: date(b.date, 'date') ?? today(),
      recorded_by: req.user.id,
    })],
    contacts: ['sfbb_contacts', MANAGE, (b) => ({
      role: str(b.role, 'role', { required: true, max: 120 }),
      name: str(b.name, 'name', { max: 200 }),
      phone: str(b.phone, 'phone', { max: 60 }),
      email: str(b.email, 'email', { max: 200 }),
      address: str(b.address, 'address', { max: 500 }),
      notes: str(b.notes, 'notes', { max: 1000 }),
    })],
  };
  for (const [path, [table, perm, body]] of Object.entries(KINDS)) {
    const load = (req) => {
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(req.params.id));
      if (!row) throw notFound('Record');
      assertLocation(req, row.location_id);
      return row;
    };
    router.post(`/sfbb/${path}`, perm, (req, res) => {
      const locationId = resolveLocation(req, req.body.location_id);
      const row = body(req.body, req);
      const cols = Object.keys(row);
      const r = db.prepare(`INSERT INTO ${table} (location_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(locationId, ...Object.values(row));
      res.status(201).json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(r.lastInsertRowid));
    });
    router.put(`/sfbb/${path}/:id`, MANAGE, (req, res) => {
      const existing = load(req);
      const row = body(req.body, req);
      delete row.recorded_by;
      db.prepare(`UPDATE ${table} SET ${Object.keys(row).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(row), existing.id);
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(existing.id));
    });
    router.delete(`/sfbb/${path}/:id`, MANAGE, (req, res) => {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(load(req).id);
      res.json({ ok: true });
    });
  }

  // Fills an empty cleaning schedule or contacts list with a starting point to change.
  router.post('/sfbb/starter/:what', MANAGE, (req, res) => {
    const what = oneOf(req.params.what, 'what', ['cleaning', 'contacts'], { required: true });
    const locationId = resolveLocation(req, req.body.location_id);
    const table = what === 'cleaning' ? 'sfbb_cleaning' : 'sfbb_contacts';
    if (db.prepare(`SELECT 1 FROM ${table} WHERE location_id = ?`).get(locationId)) throw badRequest('This list already has entries');
    tx(db, () => {
      if (what === 'cleaning') {
        const insert = db.prepare('INSERT INTO sfbb_cleaning (location_id, item, frequency, precautions, method, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
        STARTER_CLEANING.forEach(([item, freq, pre, method], i) => insert.run(locationId, item, freq, pre, method, i));
      } else {
        const insert = db.prepare('INSERT INTO sfbb_contacts (location_id, role) VALUES (?, ?)');
        STARTER_CONTACTS.forEach((role) => insert.run(locationId, role));
      }
    });
    res.status(201).json({ ok: true });
  });
}
