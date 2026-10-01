import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { row, all, run } from './db.js';
import {
  verifyPassword,
  hashPassword,
  signToken,
  requireAuth,
  requireRole,
  AuthRequest,
  StaffUser,
} from './auth.js';
import { ordersRouter } from './orders.js';
import { waitlistRouter } from './waitlist.js';
import { discountsRouter } from './discounts.js';
import { handleStripeWebhook, stripeConfigured } from './payments.js';
import { saveSubscription, getVapidPublicKey, pushEnabled } from './push.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(cors());

// Stripe webhook needs the RAW body for signature verification — register before json().
app.post(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripeConfigured) return res.status(400).json({ error: 'Stripe not configured' });
    const sig = req.headers['stripe-signature'] as string;
    if (!sig) return res.status(400).json({ error: 'Missing signature' });
    try {
      await handleStripeWebhook(req.body, sig);
      res.json({ received: true });
    } catch (e: any) {
      console.error('[webhook]', e.message);
      res.status(400).json({ error: 'Webhook verification failed' });
    }
  }
);

app.use(express.json({ limit: '1mb' }));

// ---------- Auth ----------
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const user = row<StaffUser & { password_hash: string }>(
    `SELECT u.id, u.username, u.role, u.org_id, o.name AS org_name, u.password_hash
     FROM users u LEFT JOIN organizations o ON o.id = u.org_id WHERE u.username = ?`,
    String(username)
  );
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = signToken({
    id: user.id,
    username: user.username,
    role: user.role,
    org_id: user.org_id,
    org_name: user.org_name,
  });
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role, restaurant_name: user.org_name },
  });
});

// Public signup: creates a restaurant (organization) with a default location
// and counters, plus an ADMIN account that gets full functionality.
app.post('/api/auth/signup', (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const restaurantName = String(req.body?.restaurant_name ?? '').trim().slice(0, 80);
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({
      error: 'Username must be 3–32 characters (letters, numbers, . _ -).',
    });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (!restaurantName) {
    return res.status(400).json({ error: 'Please enter your restaurant or company name.' });
  }
  if (row('SELECT id FROM users WHERE username = ?', username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }
  const org = run('INSERT INTO organizations (name) VALUES (?)', restaurantName);
  const orgId = Number(org.lastInsertRowid);
  const loc = run('INSERT INTO locations (org_id, name) VALUES (?, ?)', orgId, 'Main Location');
  const locId = Number(loc.lastInsertRowid);
  for (const name of ['Counter 1', 'Counter 2', 'Counter 3']) {
    run('INSERT INTO counters (location_id, name) VALUES (?, ?)', locId, name);
  }
  const u = run('INSERT INTO users (username, password_hash, role, org_id) VALUES (?, ?, ?, ?)', username, hashPassword(password), 'ADMIN', orgId);
  const userId = Number(u.lastInsertRowid);
  const token = signToken({
    id: userId,
    username,
    role: 'ADMIN',
    org_id: orgId,
    org_name: restaurantName,
  });
  res.status(201).json({
    token,
    user: { id: userId, username, role: 'ADMIN', restaurant_name: restaurantName },
  });
});

// Public: the deployment's restaurant name, shown on the login page.
app.get('/api/public/restaurant-name', (_req, res) => {
  const org = row<{ name: string }>('SELECT name FROM organizations ORDER BY id LIMIT 1');
  res.json({ name: org?.name || 'Kitchen Orders' });
});

app.get('/api/auth/me', requireAuth, (req: AuthRequest, res) => {
  res.json({
    user: {
      id: req.user!.id,
      username: req.user!.username,
      role: req.user!.role,
      restaurant_name: req.user!.org_name,
    },
  });
});

// ---------- Notifications ----------
app.get('/api/notifications/vapid-key', (_req, res) => {
  res.json({ publicKey: getVapidPublicKey(), enabled: pushEnabled });
});

app.post('/api/notifications/subscribe', (req, res) => {
  const { token, subscription, device_type } = req.body ?? {};
  if (!token || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const order = row<{ id: number }>('SELECT id FROM orders WHERE public_token = ?', token);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  saveSubscription(order.id, subscription, device_type);
  res.json({ ok: true });
});

// ---------- Staff reference data ----------
app.get('/api/menu', requireAuth, (_req, res) => {
  res.json(all('SELECT id, name, price_cents AS price FROM menu_items WHERE active = 1 ORDER BY name'));
});

app.post('/api/menu', requireAuth, requireRole('ADMIN'), (req: AuthRequest, res) => {
  const { name, price_cents } = req.body ?? {};
  const n = String(name || '').trim().slice(0, 120);
  const p = Math.round(Number(price_cents));
  if (!n || !Number.isFinite(p) || p < 0) return res.status(400).json({ error: 'Invalid item' });
  const r = run(
    'INSERT INTO menu_items (org_id, name, price_cents) VALUES (?, ?, ?)',
    req.user!.org_id,
    n,
    p
  );
  res.status(201).json({ id: Number(r.lastInsertRowid), name: n, price: p });
});

app.put('/api/menu/:id', requireAuth, requireRole('ADMIN'), (req: AuthRequest, res) => {
  const { name, price_cents } = req.body ?? {};
  const n = String(name || '').trim().slice(0, 120);
  const pr = Math.round(Number(price_cents));
  if (!n || !Number.isFinite(pr) || pr < 0) return res.status(400).json({ error: 'Invalid item' });
  const item = row('SELECT id FROM menu_items WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });
  run('UPDATE menu_items SET name = ?, price_cents = ? WHERE id = ?', n, pr, req.params.id);
  res.json({ id: Number(req.params.id), name: n, price: pr });
});

app.delete('/api/menu/:id', requireAuth, requireRole('ADMIN'), (req: AuthRequest, res) => {
  const item = row('SELECT id FROM menu_items WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });
  run('UPDATE menu_items SET active = 0 WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

app.get('/api/counters', requireAuth, (_req, res) => {
  res.json(all('SELECT id, name FROM counters ORDER BY id'));
});

app.use('/api/orders', ordersRouter);
app.use('/api/waitlist', waitlistRouter);
app.use('/api/discount-codes', discountsRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- Serve the client (PWA, zero build step) ----------
const clientDir = join(__dirname, '..', '..', 'client');
app.use(express.static(clientDir));
// SPA fallback — but never swallow /api routes.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(join(clientDir, 'index.html'));
});
console.log('[server] serving client from', clientDir);

app.listen(PORT, () => {
  console.log(`[server] Kitchen QR app listening on http://localhost:${PORT}`);
});
