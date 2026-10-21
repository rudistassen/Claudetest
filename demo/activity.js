// Two weeks of believable history for the demo: completed safety checks (with a few failures and the
// action taken), wastage, stock takes and supplier orders at every site.
import { addDays, today, weekStart } from '../src/util.js';

const REASONS = ['Out of date', 'Out of date', 'Over-production', 'Over-production', 'Spoiled / quality', 'Dropped / spilled', 'Damaged', 'Preparation error'];
const FAILS = {
  'Display fridge temperature (opening)': [7.4, 'Door seal not closing. Moved high-risk items to kitchen fridge, reported to maintenance.'],
  'Hot holding temperature': [58, 'Soup reheated to 75°C before returning to hot hold; bain-marie thermostat turned up.'],
  'Freezer temperature (opening)': [-14, 'Freezer left ajar overnight. Checked food still frozen solid, door alarm tested.'],
  'Pest control inspection (droppings, gnaw marks, insects)': [null, 'Droppings found behind dry store shelving. Area cleaned and pest contractor called out.'],
};

export function seedActivity(db) {
  const d0 = today();
  let seed = 42;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const stamp = (date, hh, mm) => `${date} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;

  const locations = db.prepare('SELECT id FROM locations ORDER BY id').all();
  const tasks = db.prepare('SELECT * FROM safety_tasks WHERE active = 1').all();
  const products = db.prepare('SELECT * FROM products').all();
  const staffAt = (loc) => db.prepare(`SELECT id, role FROM users WHERE location_id = ? ORDER BY id`).all(loc);
  const insCheck = db.prepare(`INSERT INTO safety_checks (task_id, location_id, period, status, reading, notes, corrective_action, completed_by, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insWaste = db.prepare(`INSERT INTO wastage (location_id, product_id, item_name, quantity, unit, unit_cost, total_cost, reason, notes, date, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const reading = (t) => {
    if (t.max_value !== null && t.min_value !== null) return Math.round((t.min_value + r() * (t.max_value - t.min_value)) * 10) / 10;
    if (t.max_value !== null) return Math.round((t.max_value - 1 - r() * 2.5) * 10) / 10;
    return Math.round((t.min_value + 2 + r() * 8) * 10) / 10;
  };

  db.exec('BEGIN');
  // Rota history: repeat this week's pattern for the previous three weeks.
  for (const weeksBack of [1, 2, 3]) {
    db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes, position, notes)
      SELECT location_id, user_id, date(date, ?), start_time, end_time, break_minutes, position, notes FROM shifts WHERE date >= ?`)
      .run(`-${weeksBack * 7} days`, weekStart(d0));
  }
  locations.forEach(({ id: loc }, li) => {
    const people = staffAt(loc);
    const who = () => people[Math.floor(r() * people.length)].id;
    const manager = people.find((p) => p.role === 'manager').id;

    // Daily checks: the last 13 days mostly done; today, opening checks done at most sites.
    for (let back = 13; back >= 0; back--) {
      const date = addDays(d0, -back);
      const rate = back === 0 ? (li % 3 === 0 ? 0.35 : 0.5) : 0.9 + r() * 0.1 - (li === 4 ? 0.12 : 0);
      for (const t of tasks.filter((x) => x.frequency === 'daily')) {
        if (back === 0 && !/opening|Opening/.test(`${t.title}${t.category}`) && r() > 0.2) continue;
        if (r() > rate) continue;
        const fail = FAILS[t.title] && r() < 0.06;
        insCheck.run(t.id, loc, date, fail ? 'fail' : 'pass', t.requires_reading ? (fail ? FAILS[t.title][0] : reading(t)) : null,
          null, fail ? FAILS[t.title][1] : null, who(), stamp(date, 6 + Math.floor(r() * 9), Math.floor(r() * 60)));
      }
    }
    // Weekly checks for the previous two weeks, and some of this week.
    for (const w of [addDays(weekStart(d0), -14), addDays(weekStart(d0), -7), weekStart(d0)]) {
      for (const t of tasks.filter((x) => x.frequency === 'weekly')) {
        if (w === weekStart(d0) ? r() > 0.3 : r() > 0.93) continue;
        const fail = FAILS[t.title] && r() < 0.15;
        insCheck.run(t.id, loc, w, fail ? 'fail' : 'pass', t.requires_reading ? reading(t) : null, null, fail ? FAILS[t.title][1] : null,
          manager, stamp(w, 15, Math.floor(r() * 60)));
      }
    }

    // Wastage: a few entries most days.
    for (let back = 13; back >= 0; back--) {
      const date = addDays(d0, -back);
      const n = back === 0 ? Math.floor(r() * 2) : 1 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) {
        const p = products[Math.floor(r() * 16)];
        const qty = p.unit === 'each' ? 1 + Math.floor(r() * 6) : 1;
        insWaste.run(loc, p.id, p.name, qty, p.unit, p.unit_cost, Math.round(qty * p.unit_cost * 100) / 100,
          REASONS[Math.floor(r() * REASONS.length)], null, date, who(), stamp(date, 16, Math.floor(r() * 60)));
      }
      if (r() < 0.35) {
        insWaste.run(loc, null, 'Ham & cheese toastie', 2 + Math.floor(r() * 3), 'each', 1.45, 0, 'Over-production', 'End of day', date, who(), stamp(date, 17, 5));
      }
    }
    db.exec('UPDATE wastage SET total_cost = ROUND(quantity * unit_cost, 2) WHERE total_cost = 0');

    // Last week's completed stock take, counted around par.
    const takeDate = addDays(d0, -6);
    const take = db.prepare(`INSERT INTO stock_takes (location_id, status, started_by, started_at, completed_by, completed_at) VALUES (?, 'completed', ?, ?, ?, ?)`)
      .run(loc, manager, stamp(takeDate, 15, 30), manager, stamp(takeDate, 16, 40)).lastInsertRowid;
    for (const p of products) {
      const counted = Math.max(0, Math.round(p.par_level * (0.3 + r() * 0.9) * (p.par_level > 5 ? 1 : 10)) / (p.par_level > 5 ? 1 : 10));
      db.prepare('INSERT INTO stock_take_lines (stock_take_id, product_id, counted_quantity, unit_cost) VALUES (?, ?, ?, ?)').run(take, p.id, counted, p.unit_cost);
    }

    // Supplier orders: one received, one on its way, and a draft at some sites.
    const order = (supplierId, status, daysAgo) => {
      const created = addDays(d0, -daysAgo);
      const o = db.prepare(`INSERT INTO purchase_orders (location_id, supplier_id, status, delivery_date, created_by, created_at, sent_at, received_at, received_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(loc, supplierId, status, addDays(created, 1), manager, stamp(created, 13, 10),
        status === 'draft' ? null : stamp(created, 13, 20), status === 'received' ? stamp(addDays(created, 1), 7, 45) : null,
        status === 'received' ? manager : null).lastInsertRowid;
      for (const p of products.filter((x) => x.supplier_id === supplierId).slice(0, 5)) {
        const q = Math.max(1, Math.round(p.par_level * (0.4 + r() * 0.5)));
        db.prepare('INSERT INTO purchase_order_lines (order_id, product_id, quantity, unit_cost, received_quantity) VALUES (?, ?, ?, ?, ?)')
          .run(o, p.id, q, p.unit_cost, status === 'received' ? (r() < 0.2 ? q - 1 : q) : null);
      }
    };
    order(1 + (li % 6), 'received', 4);
    order(1 + ((li + 2) % 6), 'sent', 1);
    if (li % 2 === 0) order(1 + ((li + 4) % 6), 'draft', 0);
  });
  db.exec('COMMIT');
}

// A sample online training course, given to the first member of staff at the first site and open to everyone.
export function seedCourse(db) {
  const course = Number(db.prepare(`INSERT INTO training_courses (name, description, renew_months, published, open_to_all, pass_mark)
    VALUES ('Barista basics', 'How we pull a great espresso and steam milk for our flat whites.', 12, 1, 1, 80)`).run().lastInsertRowid);
  const step = db.prepare(`INSERT INTO training_steps (course_id, position, kind, title, body, options, answer) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const steps = [
    ['page', 'Welcome to the bar ☕', 'Every coffee we serve should taste the same, whichever site you’re at and whoever makes it.\n\nThis short course covers the two things that matter most:\n- Pulling a **double espresso** in 25–30 seconds\n- Steaming silky milk to **60–65°C**', null, null],
    ['page', 'Pulling the shot', 'Grind fresh for every shot and dose **18g** into the basket. Level it, tamp firmly and evenly, then lock in and start straight away.\n\nYou’re aiming for about **36g** of espresso in **25–30 seconds**.\n- Too fast and sour? Grind finer.\n- Too slow and bitter? Grind coarser.', null, null],
    ['page', 'Steaming the milk', 'Purge the wand, then put the tip just under the surface to stretch the milk for 2–3 seconds – you’ll hear a gentle tearing sound.\n\nThen sink the tip a little deeper to spin the milk until the jug is too hot to hold (60–65°C). Tap, swirl and pour straight away.', null, null],
    ['question', 'How much espresso should a double shot give you?', null, JSON.stringify(['About 18g', 'About 36g', 'About 60g']), 1],
    ['question', 'Your shot ran in 18 seconds and tastes sour. What do you change?', 'A fast, sour shot means the water is getting through too easily.', JSON.stringify(['Grind finer', 'Grind coarser', 'Use less coffee']), 0],
    ['question', 'What temperature should milk be steamed to?', null, JSON.stringify(['40–45°C', '60–65°C', '80–85°C']), 1],
  ];
  steps.forEach(([kind, title, body, options, answer], i) => step.run(course, i, kind, title, body, options, answer));
  const who = db.prepare(`SELECT id FROM users WHERE email = 'staff1@cafe.local'`).get();
  if (who) db.prepare(`INSERT INTO training_assignments (course_id, user_id, due_on) VALUES (?, ?, date('now', '+5 days'))`).run(course, who.id);
}

// Sample checklists for every site, a few tasks and a couple of to-dos for Checklists & Tasks.
export function seedChecklists(db) {
  const list = db.prepare('INSERT INTO checklists (name, description, location_id, days, position) VALUES (?, ?, NULL, ?, ?)');
  const item = db.prepare('INSERT INTO checklist_items (checklist_id, position, text) VALUES (?, ?, ?)');
  [
    ['Opening checklist', 'Before the doors open', ['Coffee machine on; flush the group heads', 'Dial in the espresso and taste a shot', 'Tills open and float counted', 'Cake display filled and labelled', 'Tables and outside seating out', 'Toilets checked and stocked']],
    ['Closing checklist', 'After the last customer leaves', ['Back-flush and clean the coffee machine', 'Food covered, labelled or thrown away', 'Surfaces cleaned and sanitised', 'Floors swept and mopped', 'Tills cashed up and safe locked', 'Doors locked and alarm set']],
  ].forEach(([name, description, items], i) => {
    const id = Number(list.run(name, description, '1234567', i).lastInsertRowid);
    items.forEach((t, p) => item.run(id, p, t));
  });
  const site = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get();
  const staff = db.prepare(`SELECT id FROM users WHERE email = 'staff1@cafe.local'`).get();
  const admin = db.prepare(`SELECT id FROM users WHERE email = 'admin@cafe.local'`).get();
  if (!site) return;
  const firstItems = db.prepare('SELECT id FROM checklist_items WHERE checklist_id = (SELECT MIN(id) FROM checklists) ORDER BY position LIMIT 3').all();
  for (const it of firstItems) db.prepare(`INSERT INTO checklist_ticks (item_id, location_id, date, done_by) VALUES (?, ?, date('now'), ?)`).run(it.id, site.id, staff?.id ?? null);
  const task = db.prepare(`INSERT INTO tasks (title, notes, location_id, assign_to, user_id, role, due_on, repeat, created_by) VALUES (?, ?, ?, ?, ?, ?, date('now', ?), ?, ?)`);
  if (staff) task.run('Clean the coffee grinder burrs', 'Use the grinder brush and tablets in the stockroom.', site.id, 'person', staff.id, null, '+2 days', 'weekly', admin?.id ?? null);
  task.run('Check fire extinguishers are in date', null, site.id, 'site', null, null, '-1 days', 'monthly', admin?.id ?? null);
  task.run('Order new loyalty cards', 'We’re down to the last box.', site.id, 'site', null, null, '+5 days', 'none', admin?.id ?? null);
  if (admin) {
    const todo = db.prepare(`INSERT INTO todos (user_id, text, due_on) VALUES (?, ?, date('now', ?))`);
    todo.run(admin.id, 'Ring the landlord about the boiler service', '+1 days');
    todo.run(admin.id, 'Sign off the new summer menu', '+7 days');
  }
}

// Sample chats: the first site's team (everyone based there), and the managers of every site.
export function seedChat(db) {
  const site = db.prepare('SELECT id, name FROM locations ORDER BY id LIMIT 1').get();
  const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get().id;
  const person = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email)?.id;
  const chat = (name, description, by) => Number(db.prepare(`INSERT INTO chat_groups (name, description, created_by, created_at) VALUES (?, ?, ?, datetime('now', '-2 days'))`)
    .run(name, description, by).lastInsertRowid);
  const say = (group, who, minutesAgo, body) => db.prepare(`INSERT INTO chat_messages (group_id, user_id, body, created_at) VALUES (?, ?, ?, datetime('now', ?))`)
    .run(group, who, body, `-${minutesAgo} minutes`);

  const team = chat(`${site.name} team`, 'Day-to-day chat for everyone at the site', person('manager1@cafe.local'));
  db.prepare('INSERT INTO chat_group_sites (group_id, location_id) VALUES (?, ?)').run(team, site.id);
  db.prepare('INSERT INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(team, admin);
  say(team, person('manager1@cafe.local'), 1500, 'Morning all! Reminder the window cleaner is in at 10, so keep the front tables clear for half an hour 🙏');
  say(team, person('staff1@cafe.local'), 1490, 'No problem 👍');
  say(team, person('staff1-2@cafe.local'), 95, 'Is anyone able to swap my Saturday close? Happy to take a Sunday in return');
  say(team, person('staff1-3@cafe.local'), 80, 'I can do it – I’ll ask on the rota so it gets approved');
  say(team, person('manager1@cafe.local'), 42, 'Thanks both. Oat milk delivery is late today, so use the backup in the dry store until it arrives.');

  const managers = chat('Managers', 'All the site managers', admin);
  for (const m of db.prepare(`SELECT id FROM users WHERE role = 'manager' AND active = 1`).all()) db.prepare('INSERT INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(managers, m.id);
  db.prepare('INSERT INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(managers, admin);
  say(managers, admin, 300, 'Next week’s rotas need publishing by Thursday please, so everyone has them before the weekend.');
  say(managers, person('manager2@cafe.local'), 240, 'Will do. We’re short a barista on Friday – can anyone lend someone?');
  say(managers, person('manager1@cafe.local'), 200, 'I can send one of mine from 11 till close 👍');

  const dm = Number(db.prepare(`INSERT INTO chat_groups (kind, name, created_by, created_at) VALUES ('direct', '', ?, datetime('now', '-1 day'))`).run(person('staff1-2@cafe.local')).lastInsertRowid);
  for (const u of [person('staff1@cafe.local'), person('staff1-2@cafe.local')]) db.prepare('INSERT INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(dm, u);
  say(dm, person('staff1-2@cafe.local'), 70, 'Hey, did I leave my black jumper in the staff room yesterday?');
  say(dm, person('staff1@cafe.local'), 65, 'Yes! It’s on the hook by the lockers 🙂');
  say(dm, person('staff1-2@cafe.local'), 20, 'Amazing, thank you!');
}

// Sample skills areas and rota roles: who is trained (or learning) in what, shown under names on the rota.
export function seedSkills(db) {
  const area = (name) => Number(db.prepare('INSERT INTO work_areas (name) VALUES (?)').run(name).lastInsertRowid);
  const ids = Object.fromEntries(['Barista', 'Till', 'Floor', 'Kitchen', 'Bakery'].map((n) => [n, area(n)]));
  const roleFor = { Manager: 'Management', Barista: 'Front of house', 'Front of house': 'Front of house', Kitchen: 'Kitchen' };
  const skillsFor = {
    Manager: [['Barista', 'trained'], ['Till', 'trained'], ['Floor', 'trained']],
    Barista: [['Barista', 'trained'], ['Till', 'trained'], ['Floor', 'learning']],
    'Front of house': [['Till', 'trained'], ['Floor', 'trained'], ['Barista', 'learning']],
    Kitchen: [['Kitchen', 'trained'], ['Bakery', 'learning']],
  };
  db.prepare(`SELECT id, position FROM users WHERE role != 'admin' AND active = 1`).all().forEach((u, i) => {
    db.prepare('UPDATE users SET rota_group = ? WHERE id = ?').run(roleFor[u.position] ?? null, u.id);
    for (const [name, level] of skillsFor[u.position] ?? []) {
      // A few people are further along than others.
      const lv = level === 'learning' && i % 3 === 0 ? 'trained' : level;
      db.prepare('INSERT INTO user_areas (user_id, area_id, level) VALUES (?, ?, ?)').run(u.id, ids[name], lv);
    }
  });
}

// Sample risk assessments, incidents and compliance documents.
export function seedCompliance(db) {
  const site = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
  const manager = db.prepare(`SELECT id FROM users WHERE email = 'manager1@cafe.local'`).get()?.id ?? null;
  const staff = db.prepare(`SELECT id FROM users WHERE email = 'staff1@cafe.local'`).get()?.id ?? null;
  const day = (n) => db.prepare(`SELECT date('now', ?) AS d`).get(`${n} days`).d;
  const risk = db.prepare(`INSERT INTO risk_assessments (location_id, title, category, hazards, who_at_risk, controls, further_action, likelihood, severity, owner_id, review_on, created_by, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-200 days'))`);
  risk.run(null, 'Fire – the whole building', 'Fire', 'Cooking equipment, electrics, deep fat fryer, rubbish build-up.', 'Staff and customers – smoke inhalation, burns.',
    'Fire alarm tested weekly, extinguishers serviced yearly, fire exits kept clear and checked daily, staff fire training on induction.', 'Fire drill every 6 months.', 2, 5, manager, day(160), manager);
  risk.run(site, 'Hot drinks and the espresso machine', 'Health & safety', 'Steam wands, hot water, hot drinks carried through the café.', 'Baristas – scalds; customers – spilt drinks.',
    'Training before using the machine, steam wand purged away from the body, lids offered on takeaways, trays for carrying.', null, 3, 2, manager, day(90), manager);
  risk.run(site, 'Cleaning chemicals', 'COSHH (chemicals)', 'Sanitiser, oven cleaner and descaler – skin and eye irritation, fumes.', 'Staff cleaning.',
    'Safety data sheets kept, gloves and goggles provided, chemicals stored away from food, never mixed.', 'Swap oven cleaner for a milder product.', 3, 3, staff, day(-5), manager);
  risk.run(site, 'Allergens', 'Food safety', 'Undeclared allergens, cross-contact during prep.', 'Customers with allergies – serious reaction.',
    'Allergen matrix kept up to date in Atlas, separate prep boards, staff ask about allergies at the till.', null, 2, 5, manager, day(200), manager);
  risk.run(site, 'Slips, trips and falls', 'Health & safety', 'Wet floors, spills, cables, steps at the back door.', 'Staff and customers.',
    'Spills cleaned straight away, wet floor signs, non-slip shoes for staff, back step marked.', null, 3, 3, manager, day(40), manager);

  const inc = db.prepare(`INSERT INTO incidents (location_id, kind, occurred_on, occurred_at, title, description, people_involved, injury, action_taken, status, outcome, reported_by, closed_by, closed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`);
  inc.run(site, 'accident', day(-1), '11:20', 'Barista burnt hand on steam wand', 'Steam wand was knocked on while the jug was being moved.', 'Sam (barista)', 'Small burn on the back of the right hand – cooled under running water for 20 minutes, plaster applied.', 'First aid given, wand checked.', 'investigating', null, staff, null, null, '-1 days');
  inc.run(site, 'near_miss', day(-3), '14:05', 'Wet floor by the toilets with no sign', 'A customer nearly slipped on water by the toilets. No sign was out.', null, null, 'Floor dried and sign put out.', 'open', null, staff, null, null, '-3 days');
  inc.run(site, 'complaint', day(-12), '09:40', 'Customer found hair in a sandwich', 'Customer brought back a ham sandwich with a hair in it.', 'Customer – refunded, no contact details left.', null, 'Refunded and apologised.', 'closed', 'Reminded the kitchen team about hair nets; checked at the next two opening checks.', staff, manager, day(-10), '-12 days');
  const id = db.prepare('SELECT id FROM incidents ORDER BY id LIMIT 1').get().id;
  db.prepare('INSERT INTO incident_notes (incident_id, user_id, body) VALUES (?, ?, ?)').run(id, manager, 'Spoke to Sam – fine to carry on working. Looking at moving the milk jugs away from the wand.');

  const doc = db.prepare(`INSERT INTO compliance_documents (location_id, title, category, file_name, file_type, size, data, issued_on, expires_on, notes, uploaded_by)
    VALUES (?, ?, ?, ?, 'text/plain', ?, ?, ?, ?, ?, ?)`);
  const file = (text) => { const b = new TextEncoder().encode(text); return [b.length, b]; };
  doc.run(site, 'Gas safety certificate', 'certificate', 'gas-safety.txt', ...file('Gas safety certificate (sample)'), day(-340), day(25), 'Engineer: J Smith, Gas Safe 123456', manager);
  doc.run(site, 'Food hygiene inspection report', 'inspection', 'fhrs.txt', ...file('Food hygiene rating 5 (sample)'), day(-200), null, 'Rating 5', manager);
  doc.run(site, 'PAT testing certificate', 'certificate', 'pat.txt', ...file('PAT test (sample)'), day(-380), day(-15), null, manager);
  doc.run(null, 'Public and employer’s liability insurance', 'insurance', 'insurance.txt', ...file('Insurance schedule (sample)'), day(-100), day(265), 'Policy no. ABC123', manager);
}

// Safer Food, Better Business at the first site: most of the pack worked through, the diary signed most days,
// a 4-weekly review, training records and the records kept with the pack.
export function seedSfbb(db) {
  const site = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
  const manager = db.prepare(`SELECT id FROM users WHERE email = 'manager1@cafe.local'`).get()?.id ?? null;
  const people = db.prepare('SELECT id FROM users WHERE location_id = ? AND active = 1 ORDER BY id').all(site).map((u) => u.id);
  const d0 = today();
  const at = (n) => `${addDays(d0, n)}T16:30:00.000Z`;

  const method = db.prepare(`INSERT INTO sfbb_methods (location_id, method_key, answers, not_relevant, completed_by, completed_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const yes = (n) => JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [i, { answer: 'yes', note: null }])));
  [['personal-hygiene', 13], ['cloths', 4], ['separating-foods', 11], ['food-allergies', 3], ['contamination', 1], ['pest-control', 4], ['maintenance', 1],
    ['handwashing', 5], ['cleaning-effectively', 8], ['clear-and-clean', 6], ['cleaning-schedule', 1], ['chilled-storage', 5], ['chilling-down', 1],
    ['defrosting', 4], ['freezing', 3], ['cooking-safely', 1], ['reheating', 1], ['ready-to-eat', 5], ['opening-closing', 0], ['extra-checks', 1], ['prove-it', 1],
    ['allergen-info', 14], ['training', 1]].forEach(([key, n], i) => method.run(site, key, yes(n), 0, manager, at(-40 + i), manager));
  method.run(site, 'acrylamide', '{}', 1, manager, at(-20), manager);
  method.run(site, 'hot-holding', yes(2), 0, null, null, manager);

  const diary = db.prepare('INSERT INTO sfbb_diary (location_id, date, notes, signed_by, signed_at) VALUES (?, ?, ?, ?, ?)');
  const NOTES = { 3: 'Dairy delivery arrived at 9°C – rejected and supplier called. Replacement came at 2pm.', 6: 'New starter Mo trained on handwashing and personal hygiene.', 9: 'Display fridge seal replaced by engineer.' };
  for (let back = 27; back >= 1; back--) {
    if (back === 2 || back === 11) continue;
    diary.run(site, addDays(d0, -back), NOTES[back] ?? null, manager, at(-back));
  }
  db.prepare('INSERT INTO sfbb_weeks (location_id, week_start, extra_checks, updated_by) VALUES (?, ?, ?, ?)')
    .run(site, addDays(weekStart(d0), -7), 'Probe checked in iced water (0.2°C) and boiling water (99.8°C). Deep cleaned behind the fridges. Dishwasher filters cleaned.', manager);
  db.prepare(`INSERT INTO sfbb_reviews (location_id, date, problems, details, action, checklist, signed_by) VALUES (?, ?, 1, ?, ?, ?, ?)`)
    .run(site, addDays(d0, -24), 'Display fridge over 8°C three mornings in a row.', 'Engineer replaced the door seal; added a mid-morning temperature check for two weeks.',
      JSON.stringify(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, i === 4 ? 'no' : 'yes']))), manager);

  const train = db.prepare('INSERT OR IGNORE INTO sfbb_training (user_id, topic, date, recorded_by) VALUES (?, ?, ?, ?)');
  people.forEach((u, i) => {
    for (const t of ['factsheet', 'opening-closing', 'personal-hygiene', 'handwashing', 'food-allergies', 'cleaning-effectively', 'chilled-storage'].slice(0, 7 - (i % 4))) train.run(u, t, addDays(d0, -60 + i * 3), manager);
    if (i % 2 === 0) train.run(u, 'level2', addDays(d0, -200 + i), manager);
  });

  const prove = db.prepare('INSERT INTO sfbb_prove_it (location_id, method_key, how, date, recorded_by) VALUES (?, ?, ?, ?, ?)');
  prove.run(site, 'cooking-safely', 'Toasted ham and cheese sandwich probed at 12:35 – 82.7°C in the centre', addDays(d0, -2), manager);
  prove.run(site, 'chilled-storage', 'Probed between packs in the display fridge – 4.1°C', addDays(d0, -5), manager);
  prove.run(site, 'prove-it', 'Probe check: iced water 0.2°C, boiling water 99.8°C', addDays(d0, -8), manager);

  const clean = db.prepare('INSERT INTO sfbb_cleaning (location_id, item, frequency, precautions, method, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  [['Work surfaces', 'After use', 'Wear gloves', 'Remove food and dirt, wash with hot soapy water, rinse, apply sanitiser for 30 seconds, rinse and air dry.'],
    ['Coffee machine and steam wands', 'Every shift', null, 'Purge and wipe wands after every drink; back-flush with cleaner at close and soak the wand tips.'],
    ['Display fridge', 'Weekly', 'Wear gloves', 'Move food to the kitchen fridge, wash shelves and inside, sanitise, dry and restock. Clean the door seals.'],
    ['Floors', 'Daily', null, 'Sweep, then mop with hot water and floor cleaner. Wet floor sign out.']].forEach((c, i) => clean.run(site, ...c, i));

  const contact = db.prepare('INSERT INTO sfbb_contacts (location_id, role, name, phone, email, notes) VALUES (?, ?, ?, ?, ?, ?)');
  contact.run(site, 'Environmental Health team', 'Lambeth Council – Food Safety', '020 7926 6000', null, 'Food hygiene, pest control, drainage, recalls');
  contact.run(site, 'Pest control contractor', 'Pestaway Ltd', '0800 000 111', 'service@pestaway.example', 'Visits monthly');
  contact.run(site, 'Refrigeration engineer', 'CoolFix', '020 7000 2222', null, null);
}
