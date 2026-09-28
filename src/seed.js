import { hashPassword } from './auth.js';
import { tx } from './db.js';
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
    for (const [name, category, unit, sup, cost, par] of PRODUCTS) {
      db.prepare('INSERT INTO products (name, category, unit, supplier_id, unit_cost, par_level) VALUES (?, ?, ?, ?, ?, ?)')
        .run(name, category, unit, supplierIds[sup], cost, par);
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
}
