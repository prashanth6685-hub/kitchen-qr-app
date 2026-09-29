import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { row, all, run } from './db.js';
import {
  verifyPassword,
  signToken,
  requireAuth,
  requireRole,
  AuthRequest,
  StaffUser,
} from './auth.js';
import { ordersRouter } from './orders.js';
import { waitlistRouter } from './waitlist.js';
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
    'SELECT id, username, role, org_id, password_hash FROM users WHERE username = ?',
    String(username)
  );
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = signToken({ id: user.id, username: user.username, role: user.role, org_id: user.org_id });
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role },
  });
});

app.get('/api/auth/me', requireAuth, (req: AuthRequest, res) => {
  res.json({ user: { id: req.user!.id, username: req.user!.username, role: req.user!.role } });
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

app.get('/api/counters', requireAuth, (_req, res) => {
  res.json(all('SELECT id, name FROM counters ORDER BY id'));
});

app.use('/api/orders', ordersRouter);
app.use('/api/waitlist', waitlistRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- Serve the client (Angular, prebuilt into client/dist) ----------
// The Angular app is compiled ahead of time; client/dist is committed so the
// app runs with no client-side install. Refresh it with `npm run build`
// inside client/ (requires the Angular packages from npm).
const clientDir = join(__dirname, '..', '..', 'client', 'dist');
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
