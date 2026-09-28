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
