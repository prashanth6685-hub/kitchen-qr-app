import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH || join(__dirname, '..', 'data', 'kitchen.db');

mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const schemaPath = join(__dirname, 'schema.sql');
db.exec(readFileSync(schemaPath, 'utf8'));

// Idempotent migrations for databases created before a column/table existed.
// (CREATE TABLE IF NOT EXISTS never alters an existing table.)
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
ensureColumn('users', 'email', 'TEXT');
ensureColumn('users', 'phone', 'TEXT');
// Free notification contact info (email + carrier for gateway SMS).
ensureColumn('orders', 'customer_email', 'TEXT');
ensureColumn('orders', 'customer_carrier', 'TEXT');
ensureColumn('waitlist_entries', 'customer_email', 'TEXT');
ensureColumn('waitlist_entries', 'customer_carrier', 'TEXT');
// One account per email address (case-insensitive). NULL emails (seeded demo
// users) are not constrained — SQLite treats NULLs as distinct in unique indexes.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE)');
ensureColumn('locations', 'slug', 'TEXT');
ensureColumn('locations', 'waitlist_prefix', "TEXT NOT NULL DEFAULT 'A'");
ensureColumn('locations', 'avg_party_minutes', 'INTEGER NOT NULL DEFAULT 5');
ensureColumn('locations', 'waitlist_enabled', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('orders', 'discount_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('order_items', 'discount_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('order_items', 'discount_code', 'TEXT');
ensureColumn('order_items', 'code_discount_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'completed_at', 'TEXT');
// Backfill completion timestamps for orders finished before the column existed.
db.exec(`
  UPDATE orders SET completed_at = COALESCE(
    (SELECT MAX(changed_at) FROM order_status_history
     WHERE order_id = orders.id AND new_status = 'COMPLETED'),
    updated_at
  )
  WHERE order_status = 'COMPLETED' AND completed_at IS NULL
`);
// --- Migration: the seeded demo organization is the owner's restaurant.
db.exec(`UPDATE organizations SET name = 'Nankana''s Kitchen' WHERE name = 'Your Kitchen'`);
// --- Migration: allow the PARTIALLY_COMPLETED order status.
// SQLite cannot alter a CHECK constraint, so rebuild the orders table once
// (data-preserving: copy into a new table, drop the old one, rename).
// Child tables keep referencing `orders` by name, which still exists afterwards.
{
  const ddl =
    (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get() as
      | { sql: string }
      | undefined)?.sql || '';
  if (!ddl.includes('PARTIALLY_COMPLETED')) {
    const ORDER_COLS = [
      'id', 'public_token', 'org_id', 'location_id', 'counter_id', 'order_number',
      'customer_name', 'customer_phone', 'special_instructions', 'total_cents',
      'discount_cents', 'currency', 'payment_status', 'order_status',
      'created_at', 'updated_at',
    ];
    const cols = ORDER_COLS.join(', ');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec(`CREATE TABLE orders_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_token TEXT NOT NULL UNIQUE,
        org_id INTEGER REFERENCES organizations(id),
        location_id INTEGER REFERENCES locations(id),
        counter_id INTEGER REFERENCES counters(id),
        order_number INTEGER NOT NULL,
        customer_name TEXT,
        customer_phone TEXT,
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
      )`);
      db.exec(`INSERT INTO orders_new (${cols}) SELECT ${cols} FROM orders`);
      db.exec('DROP TABLE orders');
      db.exec('ALTER TABLE orders_new RENAME TO orders');
      db.exec('CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(public_token)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(order_status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC)');
      db.exec("DELETE FROM sqlite_sequence WHERE name = 'orders_new'");
      db.exec("UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM orders) WHERE name = 'orders'");
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
    console.log('[db] migrated orders table: PARTIALLY_COMPLETED status enabled');
  }
}
// The COUNTER_STAFF role was merged into ADMIN: promote any existing counter
// users so they keep access with the same username/password.
db.exec(`UPDATE users SET role = 'ADMIN' WHERE role = 'COUNTER_STAFF'`);
// Backfill a URL-safe slug for locations created before slugs existed.
for (const loc of db
  .prepare('SELECT id, name FROM locations WHERE slug IS NULL OR slug = ?')
  .all('') as { id: number; name: string }[]) {
  const slug =
    loc.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `location-${loc.id}`;
  const taken = db
    .prepare('SELECT id FROM locations WHERE slug = ? AND id != ?')
    .get(slug, loc.id);
  db.prepare('UPDATE locations SET slug = ? WHERE id = ?').run(
    taken ? `${slug}-${loc.id}` : slug,
    loc.id
  );
}

export function row<T = any>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T = any>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function run(sql: string, ...params: any[]): { lastInsertRowid: number | bigint; changes: number | bigint } {
  const r = db.prepare(sql).run(...params);
  return { lastInsertRowid: r.lastInsertRowid, changes: Number(r.changes) };
}

export function now(): string {
  return new Date().toISOString();
}
