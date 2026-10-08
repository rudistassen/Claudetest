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

-- Prepped recipes counted in a stock take (e.g. 1500 g of tomato sauce), in their yield unit, valued at their
-- cost per unit when the count started.
CREATE TABLE IF NOT EXISTS stock_take_prep_lines (
  stock_take_id INTEGER NOT NULL REFERENCES stock_takes(id) ON DELETE CASCADE,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  counted_quantity REAL,
  unit_cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (stock_take_id, recipe_id)
);

-- Orders from a site to the prep kitchen for prepped recipes (sauces, fillings, bakes), for a day.
CREATE TABLE IF NOT EXISTS prep_orders (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  needed_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'sent')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_prep_orders_day ON prep_orders(needed_on);
CREATE TABLE IF NOT EXISTS prep_order_lines (
  order_id INTEGER NOT NULL REFERENCES prep_orders(id) ON DELETE CASCADE,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  quantity REAL NOT NULL,
  PRIMARY KEY (order_id, recipe_id)
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

-- Each line is a product, or a prepped recipe (sub_recipe_id) measured in that recipe's yield unit.
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  sub_recipe_id INTEGER REFERENCES recipes(id),
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

-- The Square catalogue: each item variation (what a till line's catalog_object_id points at) with its item and
-- category, so item sales can be grouped by category.
CREATE TABLE IF NOT EXISTS square_catalog (
  variation_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  variation_name TEXT,
  category_id TEXT,
  category_name TEXT
);

-- Saved par level reports (Reporting → Par levels): named, for one Square category at one site, with the par level
-- budgeted for each item on each weekday (0 = Monday). Only the budgeted levels are kept.
CREATE TABLE IF NOT EXISTS par_reports (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS par_report_lines (
  report_id INTEGER NOT NULL REFERENCES par_reports(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  item_name TEXT NOT NULL,
  weekday INTEGER NOT NULL,
  par REAL NOT NULL,
  PRIMARY KEY (report_id, item_key, weekday)
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

-- Clock-ins counted at a site that isn't in Square (e.g. an HQ): the timecard stays at its Square location
-- (square_site_id, the Atlas site linked to it), but Atlas counts its hours and cost at location_id. Kept apart
-- from timecards so each sync from Square (which rebuilds timecards) can put it back.
CREATE TABLE IF NOT EXISTS timecard_allocations (
  timecard_id TEXT PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  square_site_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  moved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  moved_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

-- Payment links sent from Atlas (Setup → Payment links), each a Square Checkout link for a set amount.
CREATE TABLE IF NOT EXISTS payment_links (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  square_link_id TEXT NOT NULL,
  square_order_id TEXT,
  url TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT NOT NULL,
  customer_name TEXT,
  customer_email TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  emailed_at TEXT,
  paid_at TEXT,
  checked_at TEXT
);

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

-- Each rota editor's last unpublished change, so it can be undone until they do something else or publish:
-- the shifts it touched as they were before (before), as they were after (after, to check nobody has changed them
-- since) and the ids of shifts it created. All JSON.
CREATE TABLE IF NOT EXISTS rota_undo (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  location_id INTEGER,
  before TEXT NOT NULL,
  after TEXT NOT NULL,
  created TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dropped shifts: someone asks to drop a published shift; a manager approves (it comes off their rota and becomes
-- an open shift at that site) or declines; anyone (from any site) can then claim it. The shift's details are copied
-- in, as they were when it was dropped. status: pending, open, claimed, declined, cancelled, withdrawn, deleted
-- (approved, but the shift was deleted rather than offered to others).
CREATE TABLE IF NOT EXISTS shift_drops (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  position TEXT,
  notes TEXT,
  dropped_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  decision_note TEXT,
  claimed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TEXT,
  claimed_shift_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shift_drops_status ON shift_drops(status, location_id, date);

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

-- The connection to Xero (one organisation), and how bills are coded there. Tokens never leave the server.
-- site_options: JSON { locationId: tracking option name }.
CREATE TABLE IF NOT EXISTS xero_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_id TEXT,
  tenant_name TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  connected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  connected_at TEXT,
  last_error TEXT,
  account_code TEXT,
  tracking_category_id TEXT,
  tracking_category_name TEXT,
  site_options TEXT,
  auto_send INTEGER NOT NULL DEFAULT 0
);

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

-- My Atlas news feed: announcements and policy updates for staff, for every site or chosen sites.
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

-- Company documents on My Atlas: handbooks, policies and forms, for every site or chosen sites.
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

-- Availability on a particular day: unavailable or available, all day or between two times (one row per time range).
-- Anything set for a day replaces the person's repeating pattern for that day.
CREATE TABLE IF NOT EXISTS availability_days (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unavailable', 'available')),
  all_day INTEGER NOT NULL DEFAULT 0,
  from_time TEXT,
  to_time TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_availability_days_user ON availability_days(user_id, date);
-- Repeating availability: from a date (to an end date, or for good), repeating every 1, 2 or 4 weeks. Each slot is
-- a day in the pattern (week 0 = the week it starts in; weekday 0 = Monday).
CREATE TABLE IF NOT EXISTS availability_patterns (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT,
  weeks INTEGER NOT NULL DEFAULT 1 CHECK (weeks IN (1, 2, 4)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS availability_pattern_slots (
  id INTEGER PRIMARY KEY,
  pattern_id INTEGER NOT NULL REFERENCES availability_patterns(id) ON DELETE CASCADE,
  week INTEGER NOT NULL DEFAULT 0,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  kind TEXT NOT NULL CHECK (kind IN ('unavailable', 'available')),
  all_day INTEGER NOT NULL DEFAULT 0,
  from_time TEXT,
  to_time TEXT
);

-- Phone (and browser) notifications: each device someone turned them on for, which kinds they've turned off, and
-- alerts already sent (so the same one isn't sent twice).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_sent_at TEXT
);
CREATE TABLE IF NOT EXISTS push_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, kind)
);
CREATE TABLE IF NOT EXISTS push_sent (
  key TEXT PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Everything someone has been notified about, for their Notifications page (kept 60 days). url is the page it's about.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);

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

-- Events: enquiries (from the events inbox, or added by hand) that become events on the calendar, with the
-- conversation about each one – emails in and out, and notes.
CREATE TABLE IF NOT EXISTS event_enquiries (
  id INTEGER PRIMARY KEY,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  title TEXT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  event_type TEXT,
  event_date TEXT,
  start_time TEXT,
  end_time TEXT,
  guests INTEGER,
  budget REAL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'replied', 'provisional', 'confirmed', 'completed', 'lost')),
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'email')),
  conversation_id TEXT,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_event_enquiries_date ON event_enquiries(event_date);
CREATE INDEX IF NOT EXISTS idx_event_enquiries_email ON event_enquiries(email);
CREATE TABLE IF NOT EXISTS enquiry_messages (
  id INTEGER PRIMARY KEY,
  enquiry_id INTEGER NOT NULL REFERENCES event_enquiries(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'note')),
  from_address TEXT,
  from_name TEXT,
  to_address TEXT,
  subject TEXT,
  body TEXT,
  email_message_id TEXT,
  sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'logged', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_enquiry_messages ON enquiry_messages(enquiry_id, created_at);
CREATE TABLE IF NOT EXISTS enquiry_files (
  id INTEGER PRIMARY KEY,
  enquiry_id INTEGER NOT NULL REFERENCES event_enquiries(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES enquiry_messages(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  file BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_enquiry_files ON enquiry_files(enquiry_id);
-- Senders whose emails were filed as marketing: their later emails are filed straight away.
CREATE TABLE IF NOT EXISTS events_marketing_senders (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  filed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Each email in the events inbox, handled once.
CREATE TABLE IF NOT EXISTS events_emails (
  message_id TEXT PRIMARY KEY,
  received_at TEXT,
  from_address TEXT,
  subject TEXT,
  status TEXT NOT NULL CHECK (status IN ('added', 'skipped', 'failed')),
  enquiry_id INTEGER REFERENCES event_enquiries(id) ON DELETE SET NULL,
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A supplier's references for each site – e.g. the account number they print on that site's invoices – so an
-- invoice from them is put against the right site automatically.
CREATE TABLE IF NOT EXISTS supplier_site_refs (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  reference TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_site_refs ON supplier_site_refs(supplier_id);

-- Product categories (Stock & Ordering → Product categories): every product is in one (products.category holds its
-- name), and each can have the Xero account code its lines go to on a bill.
CREATE TABLE IF NOT EXISTS product_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  xero_account_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- People → Recruitment: jobs being hired for at each site, and the candidates for each.
CREATE TABLE IF NOT EXISTS vacancies (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  title TEXT NOT NULL,
  hours TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'closed')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Candidates are added by hand under a job, or arrive by email in the careers inbox (see careers-inbox.js), where
-- they may not be for a particular job (vacancy_id empty) – location_id is then the site they mentioned, if any.
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY,
  vacancy_id INTEGER REFERENCES vacancies(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  stage TEXT NOT NULL DEFAULT 'applied' CHECK (stage IN ('applied', 'interview', 'trial', 'offer', 'hired', 'rejected')),
  next_step_on TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'email')),
  subject TEXT,
  message TEXT,
  email_message_id TEXT,
  received_at TEXT,
  declined_at TEXT,
  reply_drafted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_candidates_vacancy ON candidates(vacancy_id);
CREATE TABLE IF NOT EXISTS candidate_files (
  id INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  file BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_candidate_files ON candidate_files(candidate_id);
-- Each email in the careers inbox, handled once.
CREATE TABLE IF NOT EXISTS careers_emails (
  message_id TEXT PRIMARY KEY,
  received_at TEXT,
  from_address TEXT,
  subject TEXT,
  status TEXT NOT NULL CHECK (status IN ('added', 'skipped', 'failed')),
  candidate_id INTEGER REFERENCES candidates(id) ON DELETE SET NULL,
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- People → Learning and development: training courses (some need doing again every so many months) and who has
-- done them.
CREATE TABLE IF NOT EXISTS training_courses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  renew_months INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS training_records (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_on TEXT NOT NULL,
  notes TEXT,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_training_records_user ON training_records(user_id, course_id);

-- People → Performance: one-to-ones, probation reviews and appraisals.
CREATE TABLE IF NOT EXISTS performance_reviews (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'one_to_one' CHECK (kind IN ('one_to_one', 'probation', 'appraisal')),
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  went_well TEXT,
  to_improve TEXT,
  goals TEXT,
  next_review_on TEXT,
  reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_performance_reviews_user ON performance_reviews(user_id, review_date);

-- People → Areas: the areas of work (e.g. Bar, Kitchen, Floor) and who is learning or trained in each.
CREATE TABLE IF NOT EXISTS work_areas (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS user_areas (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area_id INTEGER NOT NULL REFERENCES work_areas(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('learning', 'trained')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, area_id)
);
`;

// Columns added after the first release; ALTER TABLE for databases created before them.
const MIGRATIONS = [
  // The sales dates a par level report's averages came from.
  ['par_reports', 'sales_from', 'ALTER TABLE par_reports ADD COLUMN sales_from TEXT'],
  ['par_reports', 'sales_to', 'ALTER TABLE par_reports ADD COLUMN sales_to TEXT'],
  // How much of a day's sales is open orders (tabs and tickets not paid yet, counted until they're paid).
  ['sales_daily', 'open_gross', 'ALTER TABLE sales_daily ADD COLUMN open_gross REAL NOT NULL DEFAULT 0'],
  ['sales_daily', 'open_orders', 'ALTER TABLE sales_daily ADD COLUMN open_orders INTEGER NOT NULL DEFAULT 0'],
  // Gross sales per hour too (for the dashboard's hourly chart). Hours synced before this only have net.
  ['sales_hourly', 'gross_sales', 'ALTER TABLE sales_hourly ADD COLUMN gross_sales REAL'],
  ['sales_hourly', 'open_gross', 'ALTER TABLE sales_hourly ADD COLUMN open_gross REAL NOT NULL DEFAULT 0'],
  // When each person last signed in (for the Staff page's "who's joined" status). People already signed in on
  // a device count as signed in.
  ['users', 'last_login_at', (db) => {
    db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
    db.exec(`UPDATE users SET last_login_at = (SELECT datetime(MAX(expires_at), '-30 days') FROM sessions s WHERE s.user_id = users.id)`);
  }],
  // When they were last sent an invite to Atlas.
  ['users', 'invited_at', 'ALTER TABLE users ADD COLUMN invited_at TEXT'],
  // The site's place on Google Maps, for its reviews.
  ['locations', 'google_place_id', 'ALTER TABLE locations ADD COLUMN google_place_id TEXT'],
  ['locations', 'square_location_id', 'ALTER TABLE locations ADD COLUMN square_location_id TEXT'],
  // Opening hours for each day of the week, Monday first: a JSON list of { open, close } or null when closed.
  ['locations', 'opening_hours', 'ALTER TABLE locations ADD COLUMN opening_hours TEXT'],
  // How a product is measured in recipes, e.g. a 4L bottle of milk = 4000 ml.
  ['products', 'recipe_unit', 'ALTER TABLE products ADD COLUMN recipe_unit TEXT'],
  ['products', 'units_per_pack', 'ALTER TABLE products ADD COLUMN units_per_pack REAL NOT NULL DEFAULT 1'],
  ['products', 'allergens', 'ALTER TABLE products ADD COLUMN allergens TEXT'],
  // How much is in one pack, in its unit (e.g. 1.5 for a 1.5 kg bag of flour).
  ['products', 'pack_quantity', 'ALTER TABLE products ADD COLUMN pack_quantity REAL'],
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
  // Sent to Xero as a draft bill (its id there), when, and the last problem sending it.
  ['invoices', 'xero_invoice_id', `ALTER TABLE invoices ADD COLUMN xero_invoice_id TEXT;
    ALTER TABLE invoices ADD COLUMN xero_sent_at TEXT;
    ALTER TABLE invoices ADD COLUMN xero_error TEXT;`],
  ['suppliers', 'xero_contact_id', 'ALTER TABLE suppliers ADD COLUMN xero_contact_id TEXT'],
  // The supplier's tabs: their address; where orders go (and who's copied in), when they deliver and the cut-off
  // for each delivery day (JSON: [{ day, cutoff_day, cutoff_time }], days 1 = Monday … 7 = Sunday), and whether
  // they're used for ordering; the Xero contact's name and their payment terms.
  ['suppliers', 'order_email', `ALTER TABLE suppliers ADD COLUMN address TEXT;
    ALTER TABLE suppliers ADD COLUMN order_email TEXT;
    ALTER TABLE suppliers ADD COLUMN cc_emails TEXT;
    ALTER TABLE suppliers ADD COLUMN delivery_schedule TEXT;
    ALTER TABLE suppliers ADD COLUMN orders_enabled INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE suppliers ADD COLUMN xero_contact_name TEXT;
    ALTER TABLE suppliers ADD COLUMN payment_terms_days INTEGER;`],
  // Candidates from the careers inbox: they needn't be for a job, so the table is rebuilt without that rule.
  ['candidates', 'source', (db) => {
    // Built alongside and swapped in: renaming the old table instead would point the tables linked to it (the CVs
    // and the careers emails) at the old copy.
    db.exec(`PRAGMA foreign_keys = OFF; BEGIN;
      CREATE TABLE candidates_new (
        id INTEGER PRIMARY KEY,
        vacancy_id INTEGER REFERENCES vacancies(id) ON DELETE CASCADE,
        location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
        name TEXT NOT NULL, email TEXT, phone TEXT,
        stage TEXT NOT NULL DEFAULT 'applied' CHECK (stage IN ('applied', 'interview', 'trial', 'offer', 'hired', 'rejected')),
        next_step_on TEXT, notes TEXT,
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'email')),
        subject TEXT, message TEXT, email_message_id TEXT, received_at TEXT, declined_at TEXT, reply_drafted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO candidates_new (id, vacancy_id, name, email, phone, stage, next_step_on, notes, created_at, updated_at)
        SELECT id, vacancy_id, name, email, phone, stage, next_step_on, notes, created_at, updated_at FROM candidates;
      DROP TABLE candidates;
      ALTER TABLE candidates_new RENAME TO candidates;
      CREATE INDEX IF NOT EXISTS idx_candidates_vacancy ON candidates(vacancy_id);
      COMMIT; PRAGMA foreign_keys = ON;`);
  }],
  // Each product's VAT code, as Xero names it (e.g. INPUT2 for 20% VAT on expenses), for coding bills. Products
  // already bought get a best guess from the VAT on the last invoice they were on.
  ['products', 'vat_code', (db) => {
    db.exec('ALTER TABLE products ADD COLUMN vat_code TEXT');
    db.exec(`UPDATE products SET vat_code = CASE (SELECT il.vat_rate FROM invoice_lines il WHERE il.product_id = products.id AND il.vat_rate IS NOT NULL ORDER BY il.id DESC LIMIT 1)
      WHEN 20 THEN 'INPUT2' WHEN 5 THEN 'RRINPUT' WHEN 0 THEN 'ZERORATEDINPUT' END`);
  }],
  // The category (and VAT code) chosen for an invoice line that becomes a new product when the invoice is confirmed.
  ['invoice_lines', 'new_category', `ALTER TABLE invoice_lines ADD COLUMN new_category TEXT;
    ALTER TABLE invoice_lines ADD COLUMN new_vat_code TEXT;`],
  // Which of an enquiry's details were filled in by reading their emails (JSON list), to check.
  ['event_enquiries', 'filled_fields', 'ALTER TABLE event_enquiries ADD COLUMN filled_fields TEXT'],
  // What reading the emails made of it (enquiry, marketing or other, and why), and whether a reply is owed: set when
  // the reader or someone decides none is needed, cleared when the customer emails again.
  ['event_enquiries', 'ai_kind', `ALTER TABLE event_enquiries ADD COLUMN ai_kind TEXT;
    ALTER TABLE event_enquiries ADD COLUMN ai_reason TEXT;
    ALTER TABLE event_enquiries ADD COLUMN no_reply_needed INTEGER NOT NULL DEFAULT 0;`],
  ['wastage', 'recipe_id', 'ALTER TABLE wastage ADD COLUMN recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL'],
  // Which sites someone can work with: every site (the default), or their home site plus those in user_sites.
  ['users', 'all_sites', 'ALTER TABLE users ADD COLUMN all_sites INTEGER NOT NULL DEFAULT 1'],
  // A site's own version of a shared check points at the check it replaces there.
  ['safety_tasks', 'replaces_task_id', 'ALTER TABLE safety_tasks ADD COLUMN replaces_task_id INTEGER REFERENCES safety_tasks(id) ON DELETE SET NULL'],
  ['users', 'availability_note', 'ALTER TABLE users ADD COLUMN availability_note TEXT'],
  // Rota publishing: the pub_* columns hold what staff can see (null = never published); the other columns are the
  // draft editors work on, and removed marks a published shift deleted in the draft. Shifts that existed before
  // publishing was added count as published, and whoever could edit the rota can now also publish it.
  // Sickness: a shift can be marked as the person being off sick. It stays on the rota (and is kept for the
  // Sickness report) but doesn't count as hours or labour cost, or as a missed clock-in.
  ['shifts', 'sick', `ALTER TABLE shifts ADD COLUMN sick INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE shifts ADD COLUMN sick_note TEXT;
    ALTER TABLE shifts ADD COLUMN sick_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE shifts ADD COLUMN sick_at TEXT;`],
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
  // Candidates put on the To review list, and when.
  ['candidates', 'to_review_at', 'ALTER TABLE candidates ADD COLUMN to_review_at TEXT'],
  // A person's own permissions (a JSON list), used instead of their permission set's when set.
  ['users', 'custom_permissions', 'ALTER TABLE users ADD COLUMN custom_permissions TEXT'],
  // Two kinds of recipe: sold items (linked to Square sales) and prepped recipes (sauces, fillings, bakes) that are
  // made in a batch with a yield, and used as ingredients of sold items or other prepped recipes.
  ['recipes', 'kind', `ALTER TABLE recipes ADD COLUMN kind TEXT NOT NULL DEFAULT 'sold' CHECK (kind IN ('sold', 'prep'));
    ALTER TABLE recipes ADD COLUMN yield_quantity REAL;
    ALTER TABLE recipes ADD COLUMN yield_unit TEXT;`],
  // Whether a prepped recipe is counted in stock takes.
  ['recipes', 'in_stock_takes', 'ALTER TABLE recipes ADD COLUMN in_stock_takes INTEGER NOT NULL DEFAULT 1'],
  // A recipe line can be a prepped recipe instead of a product, so product_id may be empty. Built alongside and
  // swapped in (nothing else links to these lines).
  ['recipe_ingredients', 'sub_recipe_id', (db) => {
    db.exec(`PRAGMA foreign_keys = OFF; BEGIN;
      CREATE TABLE recipe_ingredients_new (
        id INTEGER PRIMARY KEY,
        recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id),
        sub_recipe_id INTEGER REFERENCES recipes(id),
        quantity REAL NOT NULL,
        notes TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0);
      INSERT INTO recipe_ingredients_new (id, recipe_id, product_id, quantity, notes, sort_order)
        SELECT id, recipe_id, product_id, quantity, notes, sort_order FROM recipe_ingredients;
      DROP TABLE recipe_ingredients;
      ALTER TABLE recipe_ingredients_new RENAME TO recipe_ingredients;
      CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
      COMMIT; PRAGMA foreign_keys = ON;`);
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
// Rebuilt each time the database opens, so they pick up new columns.
const VIEWS = `
DROP VIEW IF EXISTS published_shifts;
CREATE VIEW published_shifts AS
  SELECT id, pub_location_id AS location_id, pub_user_id AS user_id, pub_date AS date, pub_start_time AS start_time,
    pub_end_time AS end_time, pub_break_minutes AS break_minutes, position, notes, sick, sick_note
  FROM shifts WHERE pub_date IS NOT NULL;
DROP VIEW IF EXISTS draft_shifts;
CREATE VIEW draft_shifts AS
  SELECT id, location_id, user_id, date, start_time, end_time, break_minutes, position, notes, sick, sick_note FROM shifts WHERE removed = 0;
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
  repairCandidateLinks(db);
  syncProductCategories(db);
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
    // The My Atlas news feed was added: whoever could manage staff can post news.
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
  if (version < 5) {
    // Seeing the dashboard became a permission: every set keeps it except the built-in Staff set, so staff open
    // Atlas on My Atlas (an admin can tick it for them on the Permissions page).
    for (const ps of db.prepare(`SELECT id, permissions FROM permission_sets WHERE built_in IS NULL OR built_in != 'staff'`).all()) {
      const perms = JSON.parse(ps.permissions || '[]');
      if (!perms.includes('dashboard.view')) {
        db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(JSON.stringify(['dashboard.view', ...perms]), ps.id);
      }
    }
    db.exec('PRAGMA user_version = 5');
  }
  if (version < 6) {
    // The People section was added: whoever could manage staff can use it.
    for (const ps of db.prepare('SELECT id, permissions FROM permission_sets').all()) {
      const perms = JSON.parse(ps.permissions || '[]');
      if (perms.includes('staff.manage') && !perms.includes('people.manage')) {
        db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(JSON.stringify([...perms, 'people.manage']), ps.id);
      }
    }
    db.exec('PRAGMA user_version = 6');
  }
  if (version < 7) {
    // Events were added: whoever could manage staff can manage events.
    for (const ps of db.prepare('SELECT id, permissions FROM permission_sets').all()) {
      const perms = JSON.parse(ps.permissions || '[]');
      if (perms.includes('staff.manage') && !perms.includes('events.manage')) {
        db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(JSON.stringify([...perms, 'events.manage']), ps.id);
      }
    }
    db.exec('PRAGMA user_version = 7');
  }
  if (version < 8) {
    // Availability became a calendar with repeating patterns: each person's usual weekly availability carries on as
    // a weekly pattern from this week.
    const people = db.prepare('SELECT DISTINCT user_id FROM availability').all().map((r) => r.user_id);
    if (people.length) {
      const now = new Date();
      const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7))).toISOString().slice(0, 10);
      const slot = db.prepare(`INSERT INTO availability_pattern_slots (pattern_id, week, weekday, kind, all_day, from_time, to_time) VALUES (?, 0, ?, ?, ?, ?, ?)`);
      for (const userId of people) {
        const patternId = db.prepare('INSERT INTO availability_patterns (user_id, start_date, weeks) VALUES (?, ?, 1)').run(userId, monday).lastInsertRowid;
        for (const r of db.prepare('SELECT * FROM availability WHERE user_id = ?').all(userId)) {
          // "Only available 9–5" becomes "available 9–5"; "not available" becomes unavailable all day.
          if (r.status === 'none') slot.run(patternId, r.weekday, 'unavailable', 1, null, null);
          else slot.run(patternId, r.weekday, 'available', 0, r.from_time, r.to_time);
        }
      }
    }
    db.exec('PRAGMA user_version = 8');
  }
  if (version < 9) {
    // Par levels became named, saved reports: a final version saved the first way becomes a saved report.
    const old = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'par_sheets'`).get();
    if (old) {
      for (const sh of db.prepare(`SELECT p.*, l.name AS site FROM par_sheets p JOIN locations l ON l.id = p.location_id WHERE p.version = 'final'`).all()) {
        const id = db.prepare('INSERT INTO par_reports (name, location_id, category, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(`${sh.category} – ${sh.site}`, sh.location_id, sh.category, sh.saved_by, sh.saved_at, sh.saved_by, sh.saved_at).lastInsertRowid;
        db.prepare(`INSERT INTO par_report_lines (report_id, item_key, item_name, weekday, par)
          SELECT ?, item_key, item_name, weekday, par FROM par_levels WHERE location_id = ? AND category = ? AND version = 'final'`).run(id, sh.location_id, sh.category);
      }
    }
    db.exec('DROP TABLE IF EXISTS par_levels; DROP TABLE IF EXISTS par_sheets;');
    db.exec('PRAGMA user_version = 9');
  }
  ensureDefaultSets(db);
  return db;
}

/**
 * Every category a product is in is on the list of categories (products added before the list existed, from a
 * spreadsheet or by the demo), and each product uses its category's exact name.
 */
export function syncProductCategories(db) {
  db.exec(`INSERT OR IGNORE INTO product_categories (name)
      SELECT DISTINCT trim(category) FROM products WHERE category IS NOT NULL AND trim(category) != '';
    UPDATE products SET category = (SELECT c.name FROM product_categories c WHERE c.name = trim(products.category))
      WHERE category IS NOT NULL AND trim(category) != '' AND category IS NOT (SELECT c.name FROM product_categories c WHERE c.name = trim(products.category));`);
}

/**
 * The first version of the candidates change left the CV files and careers emails linked to a table that no longer
 * exists ("candidates_old"), so nothing could be saved in them. Each is rebuilt linked to candidates. Applications
 * the careers inbox half-added while that was broken (not yet looked at) are cleared, so they're added again
 * properly – with their CVs – the next time the inbox is checked.
 */
function repairCandidateLinks(db) {
  const broken = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%candidates_old%'`).all();
  if (!broken.length) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(db, () => {
      for (const t of broken) {
        db.exec(`ALTER TABLE "${t.name}" RENAME TO "${t.name}_fix"`);
        db.exec(t.sql.replace(/"?candidates_old"?/g, 'candidates'));
        db.exec(`INSERT INTO "${t.name}" SELECT * FROM "${t.name}_fix"; DROP TABLE "${t.name}_fix";`);
      }
      if (!db.prepare('SELECT 1 FROM careers_emails LIMIT 1').get()) {
        db.exec(`DELETE FROM candidates WHERE source = 'email' AND stage = 'applied' AND declined_at IS NULL AND notes IS NULL
          AND NOT EXISTS (SELECT 1 FROM candidate_files f WHERE f.candidate_id = candidates.id)`);
      }
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  db.exec(SCHEMA);
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
