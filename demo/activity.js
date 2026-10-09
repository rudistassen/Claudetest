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
