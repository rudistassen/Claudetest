import { DatabaseSync } from 'node:sqlite';
import { ensureDefaultSets } from './permissions.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  address TEXT,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
  location_id INTEGER REFERENCES locations(id),
  position TEXT,
  hourly_rate REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  position TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_shifts_location_date ON shifts(location_id, date);
CREATE INDEX IF NOT EXISTS idx_shifts_user_date ON shifts(user_id, date);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  order_days TEXT,
  lead_time_days INTEGER NOT NULL DEFAULT 1,
  min_order REAL NOT NULL DEFAULT 0,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'each',
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  par_level REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_pars (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  par_level REAL NOT NULL,
  PRIMARY KEY (product_id, location_id)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
  delivery_date TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  received_at TEXT,
  received_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  received_quantity REAL
);

CREATE TABLE IF NOT EXISTS stock_takes (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  notes TEXT,
  started_by INTEGER REFERENCES users(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS stock_take_lines (
  stock_take_id INTEGER NOT NULL REFERENCES stock_takes(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  counted_quantity REAL,
  unit_cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (stock_take_id, product_id)
);

CREATE TABLE IF NOT EXISTS wastage (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT,
  unit_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  notes TEXT,
  date TEXT NOT NULL,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wastage_location_date ON wastage(location_id, date);

CREATE TABLE IF NOT EXISTS safety_tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'General',
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly')),
  location_id INTEGER REFERENCES locations(id) ON DELETE CASCADE,
  requires_reading INTEGER NOT NULL DEFAULT 0,
  reading_unit TEXT,
  min_value REAL,
  max_value REAL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS safety_checks (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES safety_tasks(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail')),
  reading REAL,
  notes TEXT,
  corrective_action TEXT,
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (task_id, location_id, period)
);
CREATE INDEX IF NOT EXISTS idx_safety_checks_location_period ON safety_checks(location_id, period);

-- Square POS sales, summarised per site per business day (net = after discounts, excluding VAT and tips).
CREATE TABLE IF NOT EXISTS sales_daily (
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  net_sales REAL NOT NULL DEFAULT 0,
  gross_sales REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  discounts REAL NOT NULL DEFAULT 0,
  tips REAL NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (location_id, date)
);

CREATE TABLE IF NOT EXISTS sales_items (
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  item_key TEXT NOT NULL,
  catalog_object_id TEXT,
  name TEXT NOT NULL,
  variation_name TEXT,
  quantity REAL NOT NULL DEFAULT 0,
  net_sales REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, date, item_key)
);

-- Recipes are shared by every site. Ingredient quantities are for the whole batch, in each product's recipe unit.
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  method TEXT,
  portions REAL NOT NULL DEFAULT 1,
  selling_price REAL NOT NULL DEFAULT 0,
  vat_rated INTEGER NOT NULL DEFAULT 1,
  extra_allergens TEXT,
  may_contain TEXT,
  shelf_life TEXT,
  square_catalog_object_id TEXT,
  square_item_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);

-- Square sales per site per business day and local hour, for the trading dashboard's hour-of-day view.
CREATE TABLE IF NOT EXISTS sales_hourly (
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  hour INTEGER NOT NULL,
  net_sales REAL NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, date, hour)
);

-- Square Team members, matched to app users by email (or name) so clock-ins line up with the rota.
CREATE TABLE IF NOT EXISTS square_team_members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Square Labor clock-ins (timecards). date is the business day the timecard started on; an open timecard
-- (still clocked in) has no end_at. paid_hours excludes unpaid breaks.
CREATE TABLE IF NOT EXISTS timecards (
  id TEXT PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  team_member_id TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT,
  unpaid_break_minutes REAL NOT NULL DEFAULT 0,
  hourly_rate REAL,
  status TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_timecards_location_date ON timecards(location_id, date);

-- Named groups of permissions staff are assigned to. built_in marks the default Manager and Staff sets
-- ('manager' / 'staff'), which people without a set fall back to by role.
CREATE TABLE IF NOT EXISTS permission_sets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  permissions TEXT NOT NULL DEFAULT '[]',
  built_in TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS square_sync_log (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  date_from TEXT,
  date_to TEXT,
  orders INTEGER,
  message TEXT,
  triggered_by TEXT
);
`;

// Columns added after the first release; ALTER TABLE for databases created before them.
const MIGRATIONS = [
  ['locations', 'square_location_id', 'ALTER TABLE locations ADD COLUMN square_location_id TEXT'],
  // How a product is measured in recipes, e.g. a 4L bottle of milk = 4000 ml.
  ['products', 'recipe_unit', 'ALTER TABLE products ADD COLUMN recipe_unit TEXT'],
  ['products', 'units_per_pack', 'ALTER TABLE products ADD COLUMN units_per_pack REAL NOT NULL DEFAULT 1'],
  ['products', 'allergens', 'ALTER TABLE products ADD COLUMN allergens TEXT'],
  ['users', 'permission_set_id', 'ALTER TABLE users ADD COLUMN permission_set_id INTEGER REFERENCES permission_sets(id) ON DELETE SET NULL'],
  ['square_sync_log', 'timecards', 'ALTER TABLE square_sync_log ADD COLUMN timecards INTEGER'],
  ['wastage', 'recipe_id', 'ALTER TABLE wastage ADD COLUMN recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL'],
  // Rota publishing: the pub_* columns hold what staff can see (null = never published); the other columns are the
  // draft editors work on, and removed marks a published shift deleted in the draft. Shifts that existed before
  // publishing was added count as published, and whoever could edit the rota can now also publish it.
  ['shifts', 'pub_date', (db) => {
    db.exec(`ALTER TABLE shifts ADD COLUMN pub_location_id INTEGER;
      ALTER TABLE shifts ADD COLUMN pub_user_id INTEGER;
      ALTER TABLE shifts ADD COLUMN pub_date TEXT;
      ALTER TABLE shifts ADD COLUMN pub_start_time TEXT;
      ALTER TABLE shifts ADD COLUMN pub_end_time TEXT;
      ALTER TABLE shifts ADD COLUMN pub_break_minutes INTEGER;
      ALTER TABLE shifts ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;`);
    publishAllShifts(db);
    for (const ps of db.prepare('SELECT id, permissions FROM permission_sets').all()) {
      const perms = JSON.parse(ps.permissions || '[]');
      if (perms.includes('rota.edit') && !perms.includes('rota.publish')) {
        db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(JSON.stringify([...perms, 'rota.publish']), ps.id);
      }
    }
  }],
];

const PUBLISH_COLUMNS = `pub_location_id = location_id, pub_user_id = user_id, pub_date = date,
  pub_start_time = start_time, pub_end_time = end_time, pub_break_minutes = break_minutes`;

/** Marks every shift as published (demo data, and shifts from before publishing existed). */
export function publishAllShifts(db) {
  db.exec(`DELETE FROM shifts WHERE removed = 1; UPDATE shifts SET ${PUBLISH_COLUMNS};`);
}

/**
 * Publishes the draft rota for the sites and dates given: removed shifts are deleted and every other shift's
 * published copy is brought up to date. Returns how many changes were published.
 */
export function publishShifts(db, locationIds, from, to) {
  const where = `location_id IN (${locationIds.map(() => '?').join(', ')}) AND date BETWEEN ? AND ?`;
  const args = [...locationIds, from, to];
  const changes = db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE ${where} AND (${UNPUBLISHED})`).get(...args).n;
  tx(db, () => {
    db.prepare(`DELETE FROM shifts WHERE ${where} AND removed = 1`).run(...args);
    db.prepare(`UPDATE shifts SET ${PUBLISH_COLUMNS} WHERE ${where}`).run(...args);
  });
  return changes;
}

/** SQL condition for a shift whose draft differs from what staff can see. */
export const UNPUBLISHED = `removed = 1 OR pub_date IS NULL OR pub_location_id != location_id OR pub_user_id != user_id OR pub_date != date
  OR pub_start_time != start_time OR pub_end_time != end_time OR pub_break_minutes != break_minutes`;

// What staff see (published_shifts) and what editors see (draft_shifts), with the usual shift columns.
const VIEWS = `
CREATE VIEW IF NOT EXISTS published_shifts AS
  SELECT id, pub_location_id AS location_id, pub_user_id AS user_id, pub_date AS date, pub_start_time AS start_time,
    pub_end_time AS end_time, pub_break_minutes AS break_minutes, position, notes
  FROM shifts WHERE pub_date IS NOT NULL;
CREATE VIEW IF NOT EXISTS draft_shifts AS
  SELECT id, location_id, user_id, date, start_time, end_time, break_minutes, position, notes FROM shifts WHERE removed = 0;
`;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  for (const [table, column, change] of MIGRATIONS) {
    if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) continue;
    if (typeof change === 'function') change(db);
    else db.exec(change);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_square ON locations(square_location_id)');
  db.exec(VIEWS);
  ensureDefaultSets(db);
  return db;
}

// Runs fn inside a transaction, rolling back if it throws.
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
