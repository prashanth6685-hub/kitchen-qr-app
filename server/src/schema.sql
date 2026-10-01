PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  slug TEXT,
  waitlist_prefix TEXT NOT NULL DEFAULT 'A',
  avg_party_minutes INTEGER NOT NULL DEFAULT 5,
  waitlist_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS counters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','KITCHEN_STAFF')),
  org_id INTEGER REFERENCES organizations(id),
  email TEXT,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER REFERENCES organizations(id),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_token TEXT NOT NULL UNIQUE,
  org_id INTEGER REFERENCES organizations(id),
  location_id INTEGER REFERENCES locations(id),
  counter_id INTEGER REFERENCES counters(id),
  order_number INTEGER NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  customer_carrier TEXT,
  special_instructions TEXT,
  total_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  payment_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (payment_status IN ('PENDING','PAID','FAILED','REFUNDED')),
  order_status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT'
    CHECK (order_status IN ('PENDING_PAYMENT','PAID','RECEIVED','PREPARING','READY','PARTIALLY_COMPLETED','COMPLETED','CANCELLED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(public_token);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(order_status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  total_price_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  discount_code TEXT,
  code_discount_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- Admin-defined discount codes, optionally tied to one menu item.
-- Exactly one of amount_cents / percent_off is set.
CREATE TABLE IF NOT EXISTS discount_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  label TEXT,
  menu_item_id INTEGER REFERENCES menu_items(id),
  amount_cents INTEGER,
  percent_off INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_reference TEXT UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL CHECK (status IN ('PENDING','SUCCEEDED','FAILED','REFUNDED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_subs_order ON push_subscriptions(order_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_status_history_order ON order_status_history(order_id);

-- ================= Module 2: restaurant check-in & digital waiting list =================

CREATE TABLE IF NOT EXISTS waitlist_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_token TEXT NOT NULL UNIQUE,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  queue_seq INTEGER NOT NULL,
  queue_number TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  customer_email TEXT,
  customer_carrier TEXT,
  party_size INTEGER NOT NULL DEFAULT 1,
  special_requirements TEXT,
  status TEXT NOT NULL DEFAULT 'WAITING'
    CHECK (status IN ('WAITING','ALMOST_READY','CALLED','SEATED','SKIPPED','NO_SHOW','CANCELLED','EXPIRED')),
  recall_count INTEGER NOT NULL DEFAULT 0,
  notified_almost_ready INTEGER NOT NULL DEFAULT 0,
  notified_called INTEGER NOT NULL DEFAULT 0,
  check_in_time TEXT NOT NULL DEFAULT (datetime('now')),
  called_time TEXT,
  seated_time TEXT,
  cancelled_time TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_waitlist_token ON waitlist_entries(public_token);
CREATE INDEX IF NOT EXISTS idx_waitlist_location_status ON waitlist_entries(location_id, status);
CREATE INDEX IF NOT EXISTS idx_waitlist_location_seq ON waitlist_entries(location_id, queue_seq);

-- Atomic per-location, per-day queue numbering.
CREATE TABLE IF NOT EXISTS waitlist_sequences (
  location_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, day)
);

CREATE TABLE IF NOT EXISTS queue_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  waitlist_entry_id INTEGER NOT NULL REFERENCES waitlist_entries(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT,
  performed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_queue_events_entry ON queue_events(waitlist_entry_id);

-- Web-push subscriptions for waitlist entries (mirrors push_subscriptions for orders).
CREATE TABLE IF NOT EXISTS waitlist_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  waitlist_entry_id INTEGER NOT NULL REFERENCES waitlist_entries(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_waitlist_subs_entry ON waitlist_subscriptions(waitlist_entry_id);
