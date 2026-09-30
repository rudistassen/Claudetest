import { hashPassword, verifyPassword } from './auth.js';
import { publishAllShifts, tx } from './db.js';
import { addDays, today, weekStart } from './util.js';

export const DEMO_PASSWORD = 'changeme123';

// Food-safety checks modelled on the FSA "Safer Food, Better Business" diary.
export const DEFAULT_SAFETY_TASKS = [
  // Daily – opening
  { title: 'Display fridge temperature (opening)', category: 'Opening checks', frequency: 'daily', reading: ['°C', null, 5] },
  { title: 'Kitchen fridge temperature (opening)', category: 'Opening checks', frequency: 'daily', reading: ['°C', null, 5] },
  { title: 'Freezer temperature (opening)', category: 'Opening checks', frequency: 'daily', reading: ['°C', null, -18] },
  { title: 'Hand-wash basins stocked (soap, paper towels, hot water)', category: 'Opening checks', frequency: 'daily' },
  { title: 'Food preparation surfaces cleaned and sanitised', category: 'Opening checks', frequency: 'daily' },
  { title: 'All staff fit for work – no sickness or diarrhoea reported', category: 'Opening checks', frequency: 'daily' },
  { title: 'Allergen information available at the till', category: 'Opening checks', frequency: 'daily' },
  // Daily – during service
  { title: 'Cooked food core temperature', category: 'During service', frequency: 'daily', reading: ['°C', 75, null], description: 'Probe the thickest part of the food. Must reach 75°C or above.' },
  { title: 'Hot holding temperature', category: 'During service', frequency: 'daily', reading: ['°C', 63, null] },
  { title: 'Dishwasher final rinse temperature', category: 'During service', frequency: 'daily', reading: ['°C', 82, null] },
  // Daily – closing
  { title: 'Display fridge temperature (closing)', category: 'Closing checks', frequency: 'daily', reading: ['°C', null, 5] },
  { title: 'Use-by dates checked and out-of-date food removed', category: 'Closing checks', frequency: 'daily' },
  { title: 'Food covered, labelled and stored correctly', category: 'Closing checks', frequency: 'daily' },
  { title: 'Daily cleaning schedule completed', category: 'Closing checks', frequency: 'daily' },
  { title: 'Bins emptied and bin area clean', category: 'Closing checks', frequency: 'daily' },
  // Weekly
  { title: 'Probe thermometer check – iced water', category: 'Equipment', frequency: 'weekly', reading: ['°C', -1, 1] },
  { title: 'Probe thermometer check – boiling water', category: 'Equipment', frequency: 'weekly', reading: ['°C', 99, 101] },
  { title: 'Deep clean fridges, freezers and door seals', category: 'Cleaning', frequency: 'weekly' },
  { title: 'Clean extraction canopy and filters', category: 'Cleaning', frequency: 'weekly' },
  { title: 'Pest control inspection (droppings, gnaw marks, insects)', category: 'Premises', frequency: 'weekly' },
  { title: 'Allergen matrix reviewed against current menu and recipes', category: 'Allergens', frequency: 'weekly' },
  { title: 'First aid kit checked and restocked', category: 'Premises', frequency: 'weekly' },
  { title: 'Staff food hygiene training records up to date', category: 'Management', frequency: 'weekly' },
];

const SUPPLIERS = [
  { name: 'Valley Dairy', contact_name: 'Orders desk', email: 'orders@valleydairy.example', phone: '01234 500100', order_days: 'Daily by 2pm', lead_time_days: 1, min_order: 50 },
  { name: 'Hearth Bakery', contact_name: 'Sam', email: 'orders@hearthbakery.example', phone: '01234 500200', order_days: 'Daily by 12pm', lead_time_days: 1, min_order: 30 },
  { name: 'Origin Coffee Roasters', contact_name: 'Account manager', email: 'trade@origincoffee.example', phone: '01234 500300', order_days: 'Mon, Thu', lead_time_days: 2, min_order: 100 },
  { name: 'Greenfield Produce', contact_name: 'Orders', email: 'orders@greenfield.example', phone: '01234 500400', order_days: 'Mon–Sat by 4pm', lead_time_days: 1, min_order: 40 },
  { name: 'Metro Wholesale', contact_name: 'Trade counter', email: 'trade@metrowholesale.example', phone: '01234 500500', order_days: 'Tue, Fri', lead_time_days: 2, min_order: 150 },
  { name: 'EcoPack Supplies', contact_name: 'Sales', email: 'sales@ecopack.example', phone: '01234 500600', order_days: 'Weekly (Wed)', lead_time_days: 3, min_order: 75 },
];

// [name, category, unit, supplier index, unit cost, default par]
const PRODUCTS = [
  ['Whole milk 4L', 'Dairy', 'bottle', 0, 3.2, 12],
  ['Semi-skimmed milk 4L', 'Dairy', 'bottle', 0, 3.1, 8],
  ['Oat milk 1L (barista)', 'Dairy alternatives', 'carton', 0, 1.9, 24],
  ['Soya milk 1L (barista)', 'Dairy alternatives', 'carton', 0, 1.7, 12],
  ['Double cream 1L', 'Dairy', 'carton', 0, 4.1, 4],
  ['Salted butter 2kg', 'Dairy', 'block', 0, 14.5, 2],
  ['Mature cheddar 5kg', 'Dairy', 'block', 0, 32, 1],
  ['Sourdough loaf', 'Bakery', 'loaf', 1, 2.4, 10],
  ['Croissant', 'Bakery', 'each', 1, 0.65, 40],
  ['Pain au chocolat', 'Bakery', 'each', 1, 0.75, 30],
  ['Brownie tray (24)', 'Bakery', 'tray', 1, 18, 2],
  ['Sandwich bloomer', 'Bakery', 'loaf', 1, 2.1, 8],
  ['Espresso blend 1kg', 'Coffee & tea', 'bag', 2, 19.5, 10],
  ['Decaf blend 1kg', 'Coffee & tea', 'bag', 2, 21, 2],
  ['English breakfast tea (100)', 'Coffee & tea', 'box', 2, 6.5, 3],
  ['Hot chocolate powder 1kg', 'Coffee & tea', 'tub', 2, 9.8, 3],
  ['Avocado', 'Fresh produce', 'each', 3, 0.9, 30],
  ['Tomatoes 6kg', 'Fresh produce', 'box', 3, 11, 1],
  ['Mixed salad leaves 1kg', 'Fresh produce', 'bag', 3, 6.2, 3],
  ['Lemons', 'Fresh produce', 'each', 3, 0.3, 20],
  ['Free-range eggs (180)', 'Fresh produce', 'case', 3, 38, 1],
  ['Smoked back bacon 2kg', 'Chilled', 'pack', 4, 16.5, 3],
  ['Cooked ham 1kg', 'Chilled', 'pack', 4, 9.5, 3],
  ['Vanilla syrup 1L', 'Dry goods', 'bottle', 4, 5.8, 4],
  ['Caramel syrup 1L', 'Dry goods', 'bottle', 4, 5.8, 4],
  ['Granulated sugar sticks (1000)', 'Dry goods', 'box', 4, 12, 1],
  ['Bottled water 500ml (24)', 'Drinks', 'case', 4, 5.5, 4],
  ['Orange juice 1L', 'Drinks', 'carton', 4, 1.6, 12],
  ['8oz compostable cups (1000)', 'Packaging', 'case', 5, 48, 1],
  ['12oz compostable cups (1000)', 'Packaging', 'case', 5, 55, 1],
  ['Cup lids (1000)', 'Packaging', 'case', 5, 32, 1],
  ['Kraft takeaway bags (500)', 'Packaging', 'case', 5, 24, 1],
  ['Napkins (5000)', 'Packaging', 'case', 5, 29, 1],
];

// How each demo product is used in recipes: [recipe unit, units per pack, allergens].
const PRODUCT_RECIPE_INFO = {
  'Whole milk 4L': ['ml', 4000, 'milk'],
  'Semi-skimmed milk 4L': ['ml', 4000, 'milk'],
  'Oat milk 1L (barista)': ['ml', 1000, 'gluten'],
  'Soya milk 1L (barista)': ['ml', 1000, 'soya'],
  'Double cream 1L': ['ml', 1000, 'milk'],
  'Salted butter 2kg': ['g', 2000, 'milk'],
  'Mature cheddar 5kg': ['g', 5000, 'milk'],
  'Sourdough loaf': ['slice', 14, 'gluten'],
  'Croissant': ['each', 1, 'gluten,eggs,milk'],
  'Pain au chocolat': ['each', 1, 'gluten,eggs,milk,soya'],
  'Brownie tray (24)': ['slice', 24, 'gluten,eggs,milk,soya'],
  'Sandwich bloomer': ['slice', 16, 'gluten,sesame'],
  'Espresso blend 1kg': ['g', 1000, null],
  'Decaf blend 1kg': ['g', 1000, null],
  'English breakfast tea (100)': ['bag', 100, null],
  'Hot chocolate powder 1kg': ['g', 1000, 'milk,soya'],
  'Avocado': ['each', 1, null],
  'Tomatoes 6kg': ['g', 6000, null],
  'Mixed salad leaves 1kg': ['g', 1000, null],
  'Lemons': ['each', 1, null],
  'Free-range eggs (180)': ['each', 180, 'eggs'],
  'Smoked back bacon 2kg': ['g', 2000, null],
  'Cooked ham 1kg': ['g', 1000, null],
  'Vanilla syrup 1L': ['ml', 1000, null],
  'Caramel syrup 1L': ['ml', 1000, 'milk'],
  'Orange juice 1L': ['ml', 1000, null],
  '8oz compostable cups (1000)': ['each', 1000, null],
  '12oz compostable cups (1000)': ['each', 1000, null],
  'Cup lids (1000)': ['each', 1000, null],
  'Kraft takeaway bags (500)': ['each', 500, null],
  'Napkins (5000)': ['each', 5000, null],
};

// Demo menu. Ingredient quantities are per batch in recipe units; names match the demo Square items.
const RECIPES = [
  { name: 'Flat white', category: 'Hot drinks', price: 3.6, method: 'Double ristretto (18g in, 36g out, 25–30s).\nSteam 150ml whole milk to 60–65°C with a thin, glossy microfoam.\nPour into 8oz cup, finish with a small heart.', ing: [['Espresso blend 1kg', 18], ['Whole milk 4L', 150], ['8oz compostable cups (1000)', 1], ['Cup lids (1000)', 1]] },
  { name: 'Latte', category: 'Hot drinks', price: 3.7, method: 'Double espresso (18g in, 36g out).\nSteam 220ml whole milk to 60–65°C, pour into 12oz cup with a thicker foam top.', ing: [['Espresso blend 1kg', 18], ['Whole milk 4L', 220], ['12oz compostable cups (1000)', 1], ['Cup lids (1000)', 1]] },
  { name: 'Cappuccino', category: 'Hot drinks', price: 3.6, method: 'Double espresso. Steam 160ml whole milk with plenty of foam (about 1.5cm). Dust with chocolate if requested.', ing: [['Espresso blend 1kg', 18], ['Whole milk 4L', 160], ['8oz compostable cups (1000)', 1], ['Cup lids (1000)', 1]] },
  { name: 'Americano', category: 'Hot drinks', price: 3.0, method: 'Fill 12oz cup two-thirds with hot water, pull double espresso over the top.', ing: [['Espresso blend 1kg', 18], ['12oz compostable cups (1000)', 1], ['Cup lids (1000)', 1]] },
  { name: 'Oat latte', category: 'Hot drinks', price: 4.1, method: 'As latte, using barista oat milk. Steam to 55–60°C – oat milk scorches above 65°C.', ing: [['Espresso blend 1kg', 18], ['Oat milk 1L (barista)', 220], ['12oz compostable cups (1000)', 1], ['Cup lids (1000)', 1]] },
  { name: 'Hot chocolate', category: 'Hot drinks', price: 3.8, method: 'Whisk 28g powder into a splash of hot milk to a paste, then steam 250ml milk and combine.', ing: [['Hot chocolate powder 1kg', 28], ['Whole milk 4L', 250], ['12oz compostable cups (1000)', 1], ['Cup lids (1000)', 1]] },
  { name: 'Croissant', category: 'Bakery', price: 2.9, vat: false, method: 'Warm for 2 minutes at 160°C if requested. Serve on a plate or in a takeaway bag.', ing: [['Croissant', 1], ['Kraft takeaway bags (500)', 1]], shelf: 'Sell on day of delivery' },
  { name: 'Pain au chocolat', category: 'Bakery', price: 3.1, vat: false, method: 'Warm for 2 minutes at 160°C if requested.', ing: [['Pain au chocolat', 1], ['Kraft takeaway bags (500)', 1]], shelf: 'Sell on day of delivery' },
  { name: 'Brownie', category: 'Bakery', price: 3.25, vat: false, method: 'Cut tray into 24. Display under cover.', ing: [['Brownie tray (24)', 1], ['Kraft takeaway bags (500)', 1]], mayContain: 'nuts,peanuts', shelf: '3 days once cut' },
  { name: 'Bacon roll', category: 'Hot food', price: 5.5, method: 'Grill 3 rashers (90g) until core temperature reaches 75°C.\nButter 2 slices of bloomer, fill and serve hot.', ing: [['Smoked back bacon 2kg', 90], ['Sandwich bloomer', 2], ['Salted butter 2kg', 10]] },
  { name: 'Avocado sourdough', category: 'Hot food', price: 8.95, method: 'Toast 2 slices of sourdough. Smash 1 avocado with lemon juice and salt.\nSpread, top with salad leaves.', ing: [['Sourdough loaf', 2], ['Avocado', 1], ['Lemons', 0.25], ['Mixed salad leaves 1kg', 15], ['Salted butter 2kg', 10]] },
  { name: 'Ham & cheese toastie', category: 'Hot food', price: 6.75, method: 'Butter the outside of 2 bloomer slices. Fill with 60g ham and 50g grated cheddar.\nPress in the grill for 4 minutes until core reaches 75°C.', ing: [['Sandwich bloomer', 2], ['Cooked ham 1kg', 60], ['Mature cheddar 5kg', 50], ['Salted butter 2kg', 10]] },
  { name: 'Egg & cress sandwich', category: 'Sandwiches', price: 4.95, vat: false, portions: 4, method: 'Hard boil 6 eggs (10 min), cool in iced water, peel and mash with butter and seasoning.\nMakes 4 rounds: fill 8 slices of bloomer, top with leaves, cut into triangles, label with date and allergens.', ing: [['Free-range eggs (180)', 6], ['Sandwich bloomer', 8], ['Salted butter 2kg', 40], ['Mixed salad leaves 1kg', 40]], mayContain: 'mustard', shelf: 'Use by end of next day, keep below 5°C' },
  { name: 'Orange juice', category: 'Cold drinks', price: 2.8, method: 'Pour 250ml chilled juice into an 8oz cup.', ing: [['Orange juice 1L', 250], ['8oz compostable cups (1000)', 1], ['Cup lids (1000)', 1]] },
];

const POSITIONS = ['Barista', 'Barista', 'Kitchen', 'Front of house'];
const FIRST_NAMES = ['Alex', 'Jordan', 'Sam', 'Charlie', 'Riley', 'Jamie', 'Morgan', 'Taylor', 'Casey', 'Robin', 'Avery', 'Quinn', 'Rowan', 'Sky', 'Drew', 'Frankie', 'Harper', 'Jesse', 'Kai', 'Logan', 'Max', 'Nico', 'Parker', 'Reese', 'Sasha', 'Toni', 'Eden', 'Ellis', 'Finley', 'Hayden', 'Indy', 'Jude', 'Lee', 'Marley', 'Noel'];

export function isEmpty(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
}

export function seedSafetyTasks(db) {
  const insert = db.prepare(`INSERT INTO safety_tasks (title, description, category, frequency, requires_reading, reading_unit, min_value, max_value, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  DEFAULT_SAFETY_TASKS.forEach((t, i) => {
    const [unit, min, max] = t.reading ?? [null, null, null];
    insert.run(t.title, t.description ?? null, t.category, t.frequency, t.reading ? 1 : 0, unit, min, max, i);
  });
}

export function seedAdmin(db, { email, password, name = 'Owner' }) {
  db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')`).run(name, email, hashPassword(password));
}

// Environment values pasted with surrounding quotes or spaces (easy to do in a hosting dashboard) are cleaned up.
export const cleanEnv = (v) => (v ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim() || null;

/**
 * Makes sure the ADMIN_EMAIL account exists and can sign in, even if the database was first created before
 * ADMIN_EMAIL was set (e.g. a hosting platform started the app before its settings were added). An existing
 * active account is left alone; a missing one is created and a deactivated one is switched back on.
 */
export function ensureAdmin(db, { email, password }) {
  if (!email || !password) return null;
  const existing = db.prepare('SELECT id, active FROM users WHERE email = ?').get(email);
  if (existing?.active) return null;
  if (existing) {
    db.prepare(`UPDATE users SET active = 1, role = 'admin', location_id = NULL, password_hash = ? WHERE id = ?`).run(hashPassword(password), existing.id);
    return 'reactivated';
  }
  seedAdmin(db, { email, password });
  return 'created';
}

/** Switches off every account still using the demo password, apart from keepEmail. Returns how many. */
export function lockDemoAccounts(db, { keepEmail } = {}) {
  const users = db.prepare('SELECT id, email, password_hash FROM users WHERE active = 1').all();
  let n = 0;
  for (const u of users) {
    if (keepEmail && u.email.toLowerCase() === keepEmail.toLowerCase()) continue;
    if (!verifyPassword(DEMO_PASSWORD, u.password_hash)) continue;
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    n++;
  }
  return n;
}

// Seven sites with staff, suppliers, products and this week's rota so every screen has something in it.
export function seedDemo(db, { locationCount = 7 } = {}) {
  const streets = ['High Street', 'Market Square', 'Station Road', 'Riverside', 'Old Town', 'University Quarter', 'Harbour'];
  const hash = hashPassword(DEMO_PASSWORD);
  tx(db, () => {
    const locIds = [];
    for (let i = 0; i < locationCount; i++) {
      const r = db.prepare('INSERT INTO locations (name, address) VALUES (?, ?)').run(`${streets[i % streets.length]}`, `${10 + i} ${streets[i % streets.length]}`);
      locIds.push(Number(r.lastInsertRowid));
    }

    const supplierIds = SUPPLIERS.map((s) => Number(db.prepare(`INSERT INTO suppliers (name, contact_name, email, phone, order_days, lead_time_days, min_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(s.name, s.contact_name, s.email, s.phone, s.order_days, s.lead_time_days, s.min_order).lastInsertRowid));
    const productIds = {};
    for (const [name, category, unit, sup, cost, par] of PRODUCTS) {
      const [recipeUnit, perPack, allergens] = PRODUCT_RECIPE_INFO[name] ?? [unit, 1, null];
      productIds[name] = Number(db.prepare(`INSERT INTO products (name, category, unit, supplier_id, unit_cost, par_level, recipe_unit, units_per_pack, allergens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, category, unit, supplierIds[sup], cost, par, recipeUnit, perPack, allergens).lastInsertRowid);
    }
    for (const r of RECIPES) {
      const recipeId = db.prepare(`INSERT INTO recipes (name, category, method, portions, selling_price, vat_rated, may_contain, shelf_life, square_catalog_object_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.name, r.category, r.method, r.portions ?? 1, r.price, r.vat === false ? 0 : 1,
        r.mayContain ?? null, r.shelf ?? null, `CAT_${r.name.replace(/\W/g, '').toUpperCase()}`).lastInsertRowid;
      r.ing.forEach(([product, qty], i) => {
        db.prepare('INSERT INTO recipe_ingredients (recipe_id, product_id, quantity, sort_order) VALUES (?, ?, ?, ?)').run(recipeId, productIds[product], qty, i);
      });
    }

    seedSafetyTasks(db);

    const ws = weekStart(today());
    const insertUser = db.prepare(`INSERT INTO users (name, email, password_hash, role, location_id, position, hourly_rate) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertShift = db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes, position) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    let n = 0;
    locIds.forEach((locId, li) => {
      const site = li + 1;
      const managerId = Number(insertUser.run(`${FIRST_NAMES[n++ % FIRST_NAMES.length]} (Manager)`, `manager${site}@cafe.local`, hash, 'manager', locId, 'Manager', 14.5).lastInsertRowid);
      const staffIds = POSITIONS.map((pos, pi) => Number(insertUser.run(
        FIRST_NAMES[n++ % FIRST_NAMES.length], pi === 0 ? `staff${site}@cafe.local` : `staff${site}-${pi + 1}@cafe.local`,
        hash, 'staff', locId, pos, 12.21,
      ).lastInsertRowid));
      for (let d = 0; d < 7; d++) {
        const day = addDays(ws, d);
        insertShift.run(locId, managerId, day, d < 5 ? '07:00' : '08:00', d < 5 ? '15:30' : '14:00', 30, 'Manager');
        staffIds.forEach((uid, si) => {
          if ((d + si) % 5 === 4) return; // two days off each
          const early = si % 2 === 0;
          insertShift.run(locId, uid, day, early ? '06:45' : '10:00', early ? '14:00' : '17:00', 30, POSITIONS[si]);
        });
      }
    });
  });
  publishAllShifts(db); // the demo rota is already published
  // Each demo manager and member of staff works at one site (real staff get every site unless you limit them).
  db.exec(`UPDATE users SET all_sites = 0 WHERE role != 'admin'`);
  // A few posts for the My Brew news feed.
  const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get()?.id ?? null;
  const post = db.prepare(`INSERT INTO news_posts (title, body, category, pinned, requires_ack, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`);
  post.run('Updated allergen policy', 'We’ve updated how we label allergens on the counter.\n\n• Every cake and pastry label now lists all 14 allergens it contains.\n• If a customer asks about allergens, always check the recipe in Brewly – never guess.\n• Report any labelling mistakes to your manager straight away.\n\nPlease read the full policy and tap “I’ve read this” below.', 'policy', 1, 1, admin, '-2 days');
  post.run('Christmas rota requests', 'Holiday requests for 20 December – 2 January need to be in by 31 October. Use Time off → Request holiday.', 'reminder', 0, 0, admin, '-5 days');
  post.run('Welcome to Brewly', 'This is your My Brew page: your shifts, your holiday and news from the team, all in one place.', 'announcement', 0, 0, admin, '-9 days');
}
