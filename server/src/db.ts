/**
 * Database layer — libsql client.
 *
 * - When TURSO_DATABASE_URL is set (plus TURSO_AUTH_TOKEN), all data lives in
 *   a hosted Turso database and survives deploys, restarts and sleep/wake.
 * - Otherwise it falls back to a local SQLite file (same behavior as before),
 *   honoring DATABASE_PATH or server/data/kitchen.db.
 *
 * The helpers below are async (the old node:sqlite API was sync). All call
 * sites use `await`. Integer values come back as plain JS numbers even though
 * the wire protocol may deliver them as bigint.
 */
import { createClient, type Client } from '@libsql/client';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const tursoUrl = (process.env.TURSO_DATABASE_URL || '').trim();
const tursoAuth = (process.env.TURSO_AUTH_TOKEN || '').trim();
const isRemote = Boolean(tursoUrl);
const localPath = process.env.DATABASE_PATH || join(__dirname, '..', 'data', 'kitchen.db');
if (!isRemote) mkdirSync(dirname(localPath), { recursive: true });

export const client: Client = createClient({
  url: isRemote ? tursoUrl : `file:${localPath}`,
  ...(isRemote && tursoAuth ? { authToken: tursoAuth } : {}),
});
console.log(`[db] using ${isRemote ? 'Turso remote database' : `local file ${localPath}`}`);

// --- value normalization: bigint (wire format) -> number (app format) ---
function normalizeRow<T>(r: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(r)) {
    const v = r[k];
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out as T;
}

export async function row<T = any>(sql: string, ...params: any[]): Promise<T | undefined> {
  const rs = await client.execute({ sql, args: params });
  const first = rs.rows[0] as Record<string, unknown> | undefined;
  return first ? normalizeRow<T>(first) : undefined;
}

export async function all<T = any>(sql: string, ...params: any[]): Promise<T[]> {
  const rs = await client.execute({ sql, args: params });
  return (rs.rows as Record<string, unknown>[]).map(normalizeRow<T>);
}

export async function run(
  sql: string,
  ...params: any[]
): Promise<{ lastInsertRowid: number; changes: number }> {
  const rs = await client.execute({ sql, args: params });
  return {
    lastInsertRowid: Number(rs.lastInsertRowid ?? 0),
    changes: Number(rs.rowsAffected ?? 0),
  };
}

export interface Tx {
  row<T = any>(sql: string, ...params: any[]): Promise<T | undefined>;
  all<T = any>(sql: string, ...params: any[]): Promise<T[]>;
  run(sql: string, ...params: any[]): Promise<{ lastInsertRowid: number; changes: number }>;
}

/** Run `fn` inside a write transaction (commit on success, rollback on throw). */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await client.transaction('write');
  const wrap: Tx = {
    row: async <T = any>(sql: string, ...p: any[]): Promise<T | undefined> => {
      const r = await tx.execute({ sql, args: p });
      const first = r.rows[0] as Record<string, unknown> | undefined;
      return (first ? normalizeRow(first) : undefined) as T | undefined;
    },
    all: async <T = any>(sql: string, ...p: any[]): Promise<T[]> => {
      const r = await tx.execute({ sql, args: p });
      return (r.rows as Record<string, unknown>[]).map(normalizeRow) as T[];
    },
    run: async (sql: string, ...p: any[]) => {
      const r = await tx.execute({ sql, args: p });
      return {
        lastInsertRowid: Number(r.lastInsertRowid ?? 0),
        changes: Number(r.rowsAffected ?? 0),
      };
    },
  };
  try {
    const out = await fn(wrap);
    await tx.commit();
    return out;
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}

export function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Schema + idempotent migrations (top-level await: dependents wait for this).
// ---------------------------------------------------------------------------

async function execScript(script: string) {
  for (const chunk of script.split(';')) {
    const stmt = chunk.trim();
    if (!stmt) continue;
    // Turso remote rejects state-changing PRAGMAs (e.g. journal_mode = WAL,
    // which ships in schema.sql); they only matter for the local-file
    // backend, so skip them on remote connections.
    if (isRemote && /^pragma\b/i.test(stmt)) continue;
    await client.execute(stmt);
  }
}

if (!isRemote) {
  // Local-file pragmas only; meaningless per-request on a remote connection.
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA foreign_keys = ON');
}

await execScript(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));

// Idempotent migrations for databases created before a column/table existed.
// (CREATE TABLE IF NOT EXISTS never alters an existing table.)
async function ensureColumn(table: string, column: string, ddl: string) {
  const cols = await all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
await ensureColumn('users', 'email', 'TEXT');
await ensureColumn('users', 'phone', 'TEXT');
// Free notification contact info (email + carrier for gateway SMS).
await ensureColumn('orders', 'customer_email', 'TEXT');
await ensureColumn('orders', 'customer_carrier', 'TEXT');
await ensureColumn('waitlist_entries', 'customer_email', 'TEXT');
await ensureColumn('waitlist_entries', 'customer_carrier', 'TEXT');
// One account per email address (case-insensitive). NULL emails (seeded demo
// users) are not constrained — SQLite treats NULLs as distinct in unique indexes.
await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE)');
await ensureColumn('locations', 'slug', 'TEXT');
await ensureColumn('locations', 'waitlist_prefix', "TEXT NOT NULL DEFAULT 'A'");
await ensureColumn('locations', 'avg_party_minutes', 'INTEGER NOT NULL DEFAULT 5');
await ensureColumn('locations', 'waitlist_enabled', 'INTEGER NOT NULL DEFAULT 1');
await ensureColumn('orders', 'discount_cents', 'INTEGER NOT NULL DEFAULT 0');
await ensureColumn('order_items', 'discount_cents', 'INTEGER NOT NULL DEFAULT 0');
await ensureColumn('order_items', 'discount_code', 'TEXT');
await ensureColumn('order_items', 'code_discount_cents', 'INTEGER NOT NULL DEFAULT 0');
await ensureColumn('orders', 'completed_at', 'TEXT');
// Backfill completion timestamps for orders finished before the column existed.
await client.execute(`
  UPDATE orders SET completed_at = COALESCE(
    (SELECT MAX(changed_at) FROM order_status_history
     WHERE order_id = orders.id AND new_status = 'COMPLETED'),
    updated_at
  )
  WHERE order_status = 'COMPLETED' AND completed_at IS NULL
`);
// --- Migration: the seeded demo organization is the owner's restaurant.
await client.execute(`UPDATE organizations SET name = 'Nankana''s Kitchen' WHERE name = 'Your Kitchen'`);
// --- Migration: allow the PARTIALLY_COMPLETED order status.
// SQLite cannot alter a CHECK constraint, so rebuild the orders table once
// (data-preserving: copy every surviving column into the new table, drop the
// old one, rename). Child tables keep referencing `orders` by name, which
// still exists afterwards.
{
  const ddlRow = await row<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'"
  );
  const ddl = ddlRow?.sql || '';
  if (ddl && !ddl.includes('PARTIALLY_COMPLETED')) {
    // Every column the new table has; copy only the ones the old table has so
    // the migration preserves data no matter which version it upgrades from.
    const NEW_COLS = [
      'id', 'public_token', 'org_id', 'location_id', 'counter_id', 'order_number',
      'customer_name', 'customer_phone', 'customer_email', 'customer_carrier',
      'special_instructions', 'total_cents', 'discount_cents', 'currency',
      'payment_status', 'order_status', 'created_at', 'updated_at', 'completed_at',
    ];
    const existing = (await all<{ name: string }>('PRAGMA table_info(orders)')).map((c) => c.name);
    const copyCols = NEW_COLS.filter((c) => existing.includes(c));
    const cols = copyCols.join(', ');
    try {
      await client.execute('PRAGMA foreign_keys = OFF');
    } catch {
      /* remote connections: pragma is per-request, harmless to skip */
    }
    try {
      await client.execute(`CREATE TABLE orders_new (
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
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      )`);
      await client.execute(`INSERT INTO orders_new (${cols}) SELECT ${cols} FROM orders`);
      await client.execute('DROP TABLE orders');
      await client.execute('ALTER TABLE orders_new RENAME TO orders');
      await client.execute('CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(public_token)');
      await client.execute('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(order_status)');
      await client.execute('CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC)');
      await client.execute("DELETE FROM sqlite_sequence WHERE name = 'orders_new'");
      await client.execute("UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM orders) WHERE name = 'orders'");
    } finally {
      try {
        await client.execute('PRAGMA foreign_keys = ON');
      } catch {
        /* remote connections: harmless to skip */
      }
    }
    console.log('[db] migrated orders table: PARTIALLY_COMPLETED status enabled');
  }
}
// The COUNTER_STAFF role was merged into ADMIN: promote any existing counter
// users so they keep access with the same username/password.
await client.execute(`UPDATE users SET role = 'ADMIN' WHERE role = 'COUNTER_STAFF'`);
// Backfill a URL-safe slug for locations created before slugs existed.
for (const loc of await all<{ id: number; name: string }>(
  'SELECT id, name FROM locations WHERE slug IS NULL OR slug = ?',
  ''
)) {
  const slug =
    loc.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `location-${loc.id}`;
  const taken = await row('SELECT id FROM locations WHERE slug = ? AND id != ?', slug, loc.id);
  await run('UPDATE locations SET slug = ? WHERE id = ?', taken ? `${slug}-${loc.id}` : slug, loc.id);
}
