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
ensureColumn('locations', 'slug', 'TEXT');
ensureColumn('locations', 'waitlist_prefix', "TEXT NOT NULL DEFAULT 'A'");
ensureColumn('locations', 'avg_party_minutes', 'INTEGER NOT NULL DEFAULT 5');
ensureColumn('locations', 'waitlist_enabled', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('orders', 'discount_cents', 'INTEGER NOT NULL DEFAULT 0');
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
