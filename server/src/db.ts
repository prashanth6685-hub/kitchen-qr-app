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

// Migration: existing databases were created before the PARTIALLY_READY
// status existed, so their orders table CHECK constraint rejects it.
// Rebuild the table with the updated constraint, preserving all data.
(function migratePartiallyReady() {
  const def = row<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'"
  )?.sql;
  if (!def || def.includes('PARTIALLY_READY')) return;
  console.log('[db] migrating orders table: adding PARTIALLY_READY status...');
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE orders_new (
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
      currency TEXT NOT NULL DEFAULT 'usd',
      payment_status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (payment_status IN ('PENDING','PAID','FAILED','REFUNDED')),
      order_status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT'
        CHECK (order_status IN ('PENDING_PAYMENT','PAID','RECEIVED','PREPARING','PARTIALLY_READY','READY','COMPLETED','CANCELLED')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO orders_new SELECT * FROM orders;
    DROP TABLE orders;
    ALTER TABLE orders_new RENAME TO orders;
    CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(public_token);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(order_status);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
    COMMIT;
  `);
  db.exec('PRAGMA foreign_keys = ON;');
  const check = db.prepare('PRAGMA foreign_key_check').all();
  if (check.length) console.error('[db] foreign_key_check issues after migration:', check);
  else console.log('[db] orders table migration complete.');
})();

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
