import { DatabaseSync } from 'node:sqlite';

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
];

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  for (const [table, column, sql] of MIGRATIONS) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(sql);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_square ON locations(square_location_id)');
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
