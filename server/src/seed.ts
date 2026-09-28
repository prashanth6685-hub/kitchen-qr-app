/**
 * One-time setup: seeds the database and generates VAPID keys for Web Push.
 * Safe to re-run (idempotent). Writes missing keys into server/.env.
 */
import 'dotenv/config';
import webpush from 'web-push';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { row, run } from './db.js';
import { hashPassword } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = join(__dirname, '..');
const envPath = join(serverDir, '.env');

function ensureEnv(key: string, value: string) {
  const content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  if (new RegExp(`^${key}=`, 'm').test(content)) return;
  const line = `${key}=${value}\n`;
  if (!content) writeFileSync(envPath, line);
  else appendFileSync(envPath, (content.endsWith('\n') ? '' : '\n') + line);
}

// --- VAPID keys for Web Push ---
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const keys = webpush.generateVAPIDKeys();
  ensureEnv('VAPID_PUBLIC_KEY', keys.publicKey);
  ensureEnv('VAPID_PRIVATE_KEY', keys.privateKey);
  console.log('[seed] generated VAPID keys → saved to server/.env');
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
}

// --- Organization / location / counters ---
let org = row<{ id: number }>('SELECT id FROM organizations LIMIT 1');
if (!org) {
  const r = run('INSERT INTO organizations (name) VALUES (?)', 'Your Kitchen');
  org = { id: Number(r.lastInsertRowid) };
  const loc = run('INSERT INTO locations (org_id, name) VALUES (?, ?)', org.id, 'Main Location');
  const locId = Number(loc.lastInsertRowid);
  for (const name of ['Counter 1', 'Counter 2', 'Counter 3']) {
    run('INSERT INTO counters (location_id, name) VALUES (?, ?)', locId, name);
  }
  console.log('[seed] created organization, location, and 3 counters');
}

// --- Staff users ---
const users: [string, string, string][] = [
  ['admin', 'admin123', 'ADMIN'],
  ['counter', 'counter123', 'COUNTER_STAFF'],
  ['kitchen', 'kitchen123', 'KITCHEN_STAFF'],
];
for (const [username, password, role] of users) {
  const existing = row('SELECT id FROM users WHERE username = ?', username);
  if (!existing) {
    run('INSERT INTO users (username, password_hash, role, org_id) VALUES (?, ?, ?, ?)', username, hashPassword(password), role, org!.id);
    console.log(`[seed] created user "${username}" / password "${password}" (${role})`);
  }
}

// --- Sample menu ---
const menuCount = row<{ c: number }>('SELECT COUNT(*) AS c FROM menu_items')!.c;
if (menuCount === 0) {
  const items: [string, number][] = [
    ['Chicken Biryani', 1299],
    ['Chicken 65', 899],
    ['Garlic Naan', 349],
    ['Vegetable Samosa (2 pc)', 499],
    ['Mango Lassi', 449],
    ['Masala Chai', 299],
  ];
  for (const [name, price] of items) {
    run('INSERT INTO menu_items (org_id, name, price_cents) VALUES (?, ?, ?)', org!.id, name, price);
  }
  console.log('[seed] added sample menu items');
}

// --- Sensible .env defaults ---
if (!process.env.PUBLIC_BASE_URL) ensureEnv('PUBLIC_BASE_URL', 'http://localhost:3000');
if (!process.env.DEMO_PAYMENTS) ensureEnv('DEMO_PAYMENTS', 'true');
if (!process.env.JWT_SECRET) {
  const { randomBytes } = await import('node:crypto');
  ensureEnv('JWT_SECRET', randomBytes(32).toString('hex'));
}

console.log('[seed] done.');
