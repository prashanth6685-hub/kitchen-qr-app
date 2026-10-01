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
import { emailEnabled } from './email.js';
import { EMAIL_RE, emailDomainReceivesMail } from './emailValidation.js';

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
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const user = await row<StaffUser & { password_hash: string }>(
    `SELECT u.id, u.username, u.role, u.org_id, o.name AS org_name, u.password_hash, u.email, u.phone
     FROM users u LEFT JOIN organizations o ON o.id = u.org_id WHERE u.username = ? COLLATE NOCASE`,
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
    email: user.email,
    phone: user.phone,
  });
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role, restaurant_name: user.org_name, email: user.email, phone: user.phone },
  });
});

// Public signup: creates a restaurant (organization) with a default location
// and counters, plus an ADMIN account that gets full functionality.
// Username rule: at least 5 characters, or 4 characters including a number.
// Email is required and unique (one account per email); phone is optional.
const USERNAME_RE = /^[a-zA-Z0-9._-]{5,32}$/;
function usernameProblem(username: string): string | null {
  if (!USERNAME_RE.test(username)) {
    return 'Username must be 5–32 characters (letters, numbers, . _ -).';
  }
  return null;
}
const PHONE_RE = /^[+()\-.\s\d]{7,25}$/;
app.post('/api/auth/signup', async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const phone = String(req.body?.phone ?? '').trim();
  const restaurantName = String(req.body?.restaurant_name ?? '').trim().slice(0, 80);
  const badName = usernameProblem(username);
  if (badName) return res.status(400).json({ error: badName });
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  // Stronger check: the domain must actually be able to receive email
  // (MX record, or A/AAAA fallback). Fails open when DNS can't be checked.
  const mailOk = await emailDomainReceivesMail(email.split('@')[1] || '');
  if (mailOk === false) {
    return res
      .status(400)
      .json({ error: "That email domain doesn't appear to accept email. Please check the address and try again." });
  }
  if (phone && !PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  }
  if (!restaurantName) {
    return res.status(400).json({ error: 'Please enter your restaurant or company name.' });
  }
  if (await row('SELECT id FROM users WHERE username = ? COLLATE NOCASE', username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }
  if (await row('SELECT id FROM users WHERE email = ? COLLATE NOCASE', email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  const org = await run('INSERT INTO organizations (name) VALUES (?)', restaurantName);
  const orgId = Number(org.lastInsertRowid);
  const loc = await run('INSERT INTO locations (org_id, name) VALUES (?, ?)', orgId, 'Main Location');
  const locId = Number(loc.lastInsertRowid);
  for (const name of ['Counter 1', 'Counter 2', 'Counter 3']) {
    await run('INSERT INTO counters (location_id, name) VALUES (?, ?)', locId, name);
  }
  const u = await run(
    'INSERT INTO users (username, password_hash, role, org_id, email, phone) VALUES (?, ?, ?, ?, ?, ?)',
    username, hashPassword(password), 'ADMIN', orgId, email, phone || null
  );
  const userId = Number(u.lastInsertRowid);
  const token = signToken({
    id: userId,
    username,
    role: 'ADMIN',
    org_id: orgId,
    org_name: restaurantName,
    email,
    phone: phone || null,
  });
  res.status(201).json({
    token,
    user: { id: userId, username, role: 'ADMIN', restaurant_name: restaurantName, email, phone: phone || null },
  });
});

// Public: live username-availability check for the signup form (case-insensitive).
app.get('/api/auth/username-available', async (req, res) => {
  const username = String(req.query.username ?? '').trim();
  const badName = usernameProblem(username);
  if (badName) {
    return res.json({ available: false, message: badName });
  }
  const taken = !!await row('SELECT id FROM users WHERE username = ? COLLATE NOCASE', username);
  res.json({
    available: !taken,
    message: taken ? 'That username is already taken.' : 'Username available ✓',
  });
});

// Public: the deployment's restaurant name, shown on the login page.
app.get('/api/public/restaurant-name', async (_req, res) => {
  const org = await row<{ name: string }>('SELECT name FROM organizations ORDER BY id LIMIT 1');
  res.json({ name: org?.name || 'Kitchen Orders' });
});

app.get('/api/auth/me', requireAuth, (req: AuthRequest, res) => {
  res.json({
    user: {
      id: req.user!.id,
      username: req.user!.username,
      role: req.user!.role,
      restaurant_name: req.user!.org_name,
      email: req.user!.email,
      phone: req.user!.phone,
    },
  });
});

// ---------- Notifications ----------
app.get('/api/notifications/vapid-key', (_req, res) => {
  res.json({ publicKey: getVapidPublicKey(), enabled: pushEnabled });
});

app.post('/api/notifications/subscribe', async (req, res) => {
  const { token, subscription, device_type } = req.body ?? {};
  if (!token || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const order = await row<{ id: number }>('SELECT id FROM orders WHERE public_token = ?', token);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  await saveSubscription(order.id, subscription, device_type);
  res.json({ ok: true });
});

// ---------- Staff reference data ----------
app.get('/api/menu', requireAuth, async (_req, res) => {
  res.json(await all('SELECT id, name, price_cents AS price FROM menu_items WHERE active = 1 ORDER BY name'));
});

app.post('/api/menu', requireAuth, requireRole('ADMIN'), async (req: AuthRequest, res) => {
  const { name, price_cents } = req.body ?? {};
  const n = String(name || '').trim().slice(0, 120);
  const p = Math.round(Number(price_cents));
  if (!n || !Number.isFinite(p) || p < 0) return res.status(400).json({ error: 'Invalid item' });
  const r = await run(
    'INSERT INTO menu_items (org_id, name, price_cents) VALUES (?, ?, ?)',
    req.user!.org_id,
    n,
    p
  );
  res.status(201).json({ id: Number(r.lastInsertRowid), name: n, price: p });
});

app.put('/api/menu/:id', requireAuth, requireRole('ADMIN'), async (req: AuthRequest, res) => {
  const { name, price_cents } = req.body ?? {};
  const n = String(name || '').trim().slice(0, 120);
  const pr = Math.round(Number(price_cents));
  if (!n || !Number.isFinite(pr) || pr < 0) return res.status(400).json({ error: 'Invalid item' });
  const item = await row('SELECT id FROM menu_items WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });
  await run('UPDATE menu_items SET name = ?, price_cents = ? WHERE id = ?', n, pr, req.params.id);
  res.json({ id: Number(req.params.id), name: n, price: pr });
});

app.delete('/api/menu/:id', requireAuth, requireRole('ADMIN'), async (req: AuthRequest, res) => {
  const item = await row('SELECT id FROM menu_items WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });
  await run('UPDATE menu_items SET active = 0 WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

app.get('/api/counters', requireAuth, async (_req, res) => {
  res.json(await all('SELECT id, name FROM counters ORDER BY id'));
});

app.use('/api/orders', ordersRouter);
app.use('/api/waitlist', waitlistRouter);
app.use('/api/discount-codes', discountsRouter);

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString(), email: emailEnabled })
);

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
