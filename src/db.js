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

-- Links emailed to staff to choose a password: an invite, or a reset when they've forgotten it (see invites.js).
-- Only a hash of each link's secret is kept.
CREATE TABLE IF NOT EXISTS password_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_password_tokens_user ON password_tokens(user_id);

-- Simple app-wide settings (key → value), e.g. the invoice inbox's default site.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Emails seen in the shared invoice inbox, so each is only imported once (see invoice-inbox.js).
CREATE TABLE IF NOT EXISTS invoice_emails (
  message_id TEXT PRIMARY KEY,
  received_at TEXT,
  from_address TEXT,
  from_name TEXT,
  subject TEXT,
  status TEXT NOT NULL,
  invoice_ids TEXT,
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Google reviews for each site (see google-reviews.js). Google only lets copies be kept for a while, so reviews
-- no longer shown on Google are dropped after 30 days, and so are old rating snapshots.
CREATE TABLE IF NOT EXISTS google_reviews (
  id TEXT PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  author TEXT,
  author_url TEXT,
  author_photo TEXT,
  rating INTEGER,
  text TEXT,
  published_at TEXT,
  review_url TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_google_reviews_location ON google_reviews(location_id, published_at);

-- Each site's Google rating once a day, to show whether it's going up or down.
CREATE TABLE IF NOT EXISTS google_ratings (
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  rating REAL,
  review_count INTEGER,
  PRIMARY KEY (location_id, date)
);

-- The rota's change log (Rota → Rota changes). Names are copied in as they were at the time.
CREATE TABLE IF NOT EXISTS rota_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  location_name TEXT,
  shift_id INTEGER,
  staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  staff_name TEXT,
  shift_date TEXT,
  hours REAL,
  details TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_rota_log_at ON rota_log(at);
CREATE INDEX IF NOT EXISTS idx_rota_log_shift ON rota_log(shift_id);

-- Breaks taken during a clock-in (from Square). A break still running has no end_at.
CREATE TABLE IF NOT EXISTS timecard_breaks (
  id INTEGER PRIMARY KEY,
  timecard_id TEXT NOT NULL REFERENCES timecards(id) ON DELETE CASCADE,
  start_at TEXT NOT NULL,
  end_at TEXT,
  is_paid INTEGER NOT NULL DEFAULT 0,
  name TEXT
);
CREATE INDEX IF NOT EXISTS idx_timecard_breaks_card ON timecard_breaks(timecard_id);

-- Shared food-safety checks switched off at one site (the site may have its own version instead).
CREATE TABLE IF NOT EXISTS safety_task_exclusions (
  task_id INTEGER NOT NULL REFERENCES safety_tasks(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, location_id)
);

-- Supplier invoices, read from an uploaded PDF or photo, checked by a person and then confirmed.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_name TEXT,
  supplier_details TEXT,
  invoice_number TEXT,
  invoice_date TEXT,
  due_date TEXT,
  subtotal REAL,
  vat REAL,
  total REAL,
  status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'confirmed')),
  file_name TEXT,
  file_type TEXT,
  file BLOB,
  extracted TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status, created_at);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  description TEXT NOT NULL,
  sku TEXT,
  quantity REAL,
  unit TEXT,
  unit_price REAL,
  line_total REAL,
  vat_rate REAL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  match TEXT,
  update_cost INTEGER NOT NULL DEFAULT 0
);

-- What a supplier calls a product on their invoices, learnt when someone matches a line by hand.
CREATE TABLE IF NOT EXISTS invoice_aliases (
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (supplier_id, text)
);

-- My Brew news feed: announcements and policy updates for staff, for every site or chosen sites.
CREATE TABLE IF NOT EXISTS news_posts (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'announcement' CHECK (category IN ('announcement', 'policy', 'event', 'reminder')),
  pinned INTEGER NOT NULL DEFAULT 0,
  requires_ack INTEGER NOT NULL DEFAULT 0,
  all_sites INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS news_post_sites (
  post_id INTEGER NOT NULL REFERENCES news_posts(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, location_id)
);
-- Photos and short videos on news posts. Uploaded first (post_id empty), then attached when the post is saved.
CREATE TABLE IF NOT EXISTS news_media (
  id INTEGER PRIMARY KEY,
  post_id INTEGER REFERENCES news_posts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  file_name TEXT,
  file_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_news_media_post ON news_media(post_id, position);
-- Who has confirmed they've read a post that asks them to.
CREATE TABLE IF NOT EXISTS news_reads (
  post_id INTEGER NOT NULL REFERENCES news_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (post_id, user_id)
);

-- Company documents on My Brew: handbooks, policies and forms, for every site or chosen sites.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'policy' CHECK (category IN ('handbook', 'policy', 'form', 'guide', 'other')),
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  all_sites INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS document_sites (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, location_id)
);

-- Emailed reports: the dashboard, sent to chosen people at a set time on chosen days.
CREATE TABLE IF NOT EXISTS report_schedules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  send_time TEXT NOT NULL,
  days TEXT NOT NULL DEFAULT '0123456',
  period TEXT NOT NULL DEFAULT 'today' CHECK (period IN ('today', 'yesterday')),
  active INTEGER NOT NULL DEFAULT 1,
  last_sent_date TEXT,
  last_result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS report_recipients (
  schedule_id INTEGER NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (schedule_id, user_id)
);

-- Extra sites someone can work with when they don't have access to every site (users.all_sites = 0).
CREATE TABLE IF NOT EXISTS user_sites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, location_id)
);

-- Holiday requests. Whole days from start_date to end_date; approved holidays block shifts on those days.
CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leave_user_dates ON leave_requests(user_id, start_date, end_date);

-- Someone's usual weekly availability (weekday 0 = Monday). No row for a day means available any time.
CREATE TABLE IF NOT EXISTS availability (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  status TEXT NOT NULL CHECK (status IN ('some', 'none')),
  from_time TEXT,
  to_time TEXT,
  PRIMARY KEY (user_id, weekday)
);

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
  // Gross sales per hour too (for the dashboard's hourly chart). Hours synced before this only have net.
  ['sales_hourly', 'gross_sales', 'ALTER TABLE sales_hourly ADD COLUMN gross_sales REAL'],
  // When each person last signed in (for the Staff page's "who's joined" status). People already signed in on
  // a device count as signed in.
  ['users', 'last_login_at', (db) => {
    db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
    db.exec(`UPDATE users SET last_login_at = (SELECT datetime(MAX(expires_at), '-30 days') FROM sessions s WHERE s.user_id = users.id)`);
  }],
  // When they were last sent an invite to Brewly.
  ['users', 'invited_at', 'ALTER TABLE users ADD COLUMN invited_at TEXT'],
  // The site's place on Google Maps, for its reviews.
  ['locations', 'google_place_id', 'ALTER TABLE locations ADD COLUMN google_place_id TEXT'],
  ['locations', 'square_location_id', 'ALTER TABLE locations ADD COLUMN square_location_id TEXT'],
  // How a product is measured in recipes, e.g. a 4L bottle of milk = 4000 ml.
  ['products', 'recipe_unit', 'ALTER TABLE products ADD COLUMN recipe_unit TEXT'],
  ['products', 'units_per_pack', 'ALTER TABLE products ADD COLUMN units_per_pack REAL NOT NULL DEFAULT 1'],
  ['products', 'allergens', 'ALTER TABLE products ADD COLUMN allergens TEXT'],
  // The group someone is in on the rota (e.g. Kitchen, Front of house), for grouping the rota.
  ['users', 'rota_group', 'ALTER TABLE users ADD COLUMN rota_group TEXT'],
  ['users', 'permission_set_id', 'ALTER TABLE users ADD COLUMN permission_set_id INTEGER REFERENCES permission_sets(id) ON DELETE SET NULL'],
  ['square_sync_log', 'timecards', 'ALTER TABLE square_sync_log ADD COLUMN timecards INTEGER'],
  // Whether the clock-in's breaks were saved (clock-ins synced before breaks were kept don't have them).
  ['timecards', 'breaks_synced', 'ALTER TABLE timecards ADD COLUMN breaks_synced INTEGER NOT NULL DEFAULT 0'],
  // Invoices that arrived by email (see invoice-inbox.js): who sent them and the subject.
  ['invoices', 'source', "ALTER TABLE invoices ADD COLUMN source TEXT NOT NULL DEFAULT 'upload'"],
  ['invoices', 'email_from', 'ALTER TABLE invoices ADD COLUMN email_from TEXT'],
  ['invoices', 'email_subject', 'ALTER TABLE invoices ADD COLUMN email_subject TEXT'],
  ['wastage', 'recipe_id', 'ALTER TABLE wastage ADD COLUMN recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL'],
  // Which sites someone can work with: every site (the default), or their home site plus those in user_sites.
  ['users', 'all_sites', 'ALTER TABLE users ADD COLUMN all_sites INTEGER NOT NULL DEFAULT 1'],
  // A site's own version of a shared check points at the check it replaces there.
  ['safety_tasks', 'replaces_task_id', 'ALTER TABLE safety_tasks ADD COLUMN replaces_task_id INTEGER REFERENCES safety_tasks(id) ON DELETE SET NULL'],
  ['users', 'availability_note', 'ALTER TABLE users ADD COLUMN availability_note TEXT'],
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

export const PUBLISH_COLUMNS = `pub_location_id = location_id, pub_user_id = user_id, pub_date = date,
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
  // One-off data changes, tracked with SQLite's user_version.
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 1) {
    // Holiday approval was added: whoever could manage staff can approve holiday.
    for (const ps of db.prepare('SELECT id, permissions FROM permission_sets').all()) {
      const perms = JSON.parse(ps.permissions || '[]');
      if (perms.includes('staff.manage') && !perms.includes('leave.manage')) {
        db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(JSON.stringify([...perms, 'leave.manage']), ps.id);
      }
    }
    db.exec('PRAGMA user_version = 1');
  }
  if (version < 2) {
    // The My Brew news feed was added: whoever could manage staff can post news.
    for (const ps of db.prepare('SELECT id, permissions FROM permission_sets').all()) {
      const perms = JSON.parse(ps.permissions || '[]');
      if (perms.includes('staff.manage') && !perms.includes('news.manage')) {
        db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(JSON.stringify([...perms, 'news.manage']), ps.id);
      }
    }
    db.exec('PRAGMA user_version = 2');
  }
  if (version < 3) {
    // Moving clock-ins between sites was added: only the built-in Manager set gets it (admins can do everything).
    for (const ps of db.prepare(`SELECT id, permissions FROM permission_sets WHERE built_in = 'manager'`).all()) {
      const perms = JSON.parse(ps.permissions || '[]');
      if (!perms.includes('timecards.move')) {
        db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(JSON.stringify([...perms, 'timecards.move']), ps.id);
      }
    }
    db.exec('PRAGMA user_version = 3');
  }
  if (version < 4) {
    // Editing clock-in breaks was added: only the built-in Manager set gets it.
    for (const ps of db.prepare(`SELECT id, permissions FROM permission_sets WHERE built_in = 'manager'`).all()) {
      const perms = JSON.parse(ps.permissions || '[]');
      if (!perms.includes('timecards.breaks')) {
        db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(JSON.stringify([...perms, 'timecards.breaks']), ps.id);
      }
    }
    db.exec('PRAGMA user_version = 4');
  }
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
