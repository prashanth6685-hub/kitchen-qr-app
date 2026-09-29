import { Router } from 'express';
import { all, row, run, now } from './db.js';
import {
  AuthRequest,
  requireAuth,
  requireRole,
  canSetStatus,
} from './auth.js';
import { generatePublicToken, qrPngBuffer, trackingUrl } from './qr.js';
import {
  sseInit,
  sseSend,
  subscribeToken,
  unsubscribeToken,
  subscribeAll,
  unsubscribeAll,
  broadcastOrderUpdate,
} from './sse.js';
import { notifyOrderStatus } from './push.js';
import {
  createCheckoutSession,
  markOrderPaid,
  stripeConfigured,
  DEMO_PAYMENTS,
} from './payments.js';

export const ordersRouter = Router();

const TRANSITIONS: Record<string, string[]> = {
  PENDING_PAYMENT: ['PAID', 'CANCELLED'],
  PAID: ['RECEIVED', 'CANCELLED'],
  RECEIVED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

interface OrderRow {
  id: number;
  public_token: string;
  org_id: number | null;
  location_id: number | null;
  counter_id: number | null;
  order_number: number;
  customer_name: string | null;
  customer_phone: string | null;
  special_instructions: string | null;
  total_cents: number;
  discount_cents: number;
  currency: string;
  payment_status: string;
  order_status: string;
  created_at: string;
  updated_at: string;
}

function itemsFor(orderId: number) {
  return all(
    'SELECT item_name, quantity, unit_price_cents, total_price_cents FROM order_items WHERE order_id = ?',
    orderId
  );
}

function nextOrderNumber(): number {
  const r = row<{ m: number | null }>('SELECT MAX(order_number) AS m FROM orders');
  return (r?.m ?? 999) + 1;
}

function defaultCounterId(): number | null {
  const c = row<{ id: number }>('SELECT id FROM counters ORDER BY id LIMIT 1');
  return c?.id ?? null;
}

// ---------- Public customer endpoints (secure token, no login) ----------

ordersRouter.get('/token/:token', (req, res) => {
  const order = row<OrderRow>('SELECT * FROM orders WHERE public_token = ?', req.params.token);
  if (!order) return res.status(404).json({ error: 'This order link is invalid or expired.' });
  res.json({
    order_number: order.order_number,
    order_status: order.order_status,
    payment_status: order.payment_status,
    customer_name: order.customer_name,
    special_instructions: order.special_instructions,
    total_cents: order.total_cents,
    discount_cents: order.discount_cents || 0,
    currency: order.currency,
    created_at: order.created_at,
    updated_at: order.updated_at,
    items: itemsFor(order.id),
  });
});

ordersRouter.get('/token/:token/events', (req, res) => {
  const order = row<OrderRow>('SELECT * FROM orders WHERE public_token = ?', req.params.token);
  if (!order) return res.status(404).end();
  sseInit(res);
  subscribeToken(order.public_token, res);
  sseSend(res, 'order', {
    id: order.id,
    public_token: order.public_token,
    order_number: order.order_number,
    order_status: order.order_status,
    payment_status: order.payment_status,
    updated_at: order.updated_at,
  });
  req.on('close', () => unsubscribeToken(order.public_token, res));
});

// ---------- Staff endpoints ----------

ordersRouter.use(requireAuth);

ordersRouter.post(
  '/',
  requireRole('ADMIN'),
  async (req: AuthRequest, res) => {
    const { customer_name, customer_phone, special_instructions, counter_id, items } = req.body ?? {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }
    const cleanItems: { name: string; qty: number; unit_price_cents: number }[] = [];
    for (const it of items) {
      const name = String(it.name || it.item_name || '').trim().slice(0, 120);
      const qty = Math.floor(Number(it.qty ?? it.quantity));
      const unit = Math.round(Number(it.unit_price ?? it.unit_price_cents));
      if (!name || !Number.isFinite(qty) || qty < 1 || qty > 99) {
        return res.status(400).json({ error: 'Each item needs a name and quantity 1–99' });
      }
      if (!Number.isFinite(unit) || unit < 0 || unit > 1000000) {
        return res.status(400).json({ error: 'Invalid item price' });
      }
      cleanItems.push({ name, qty, unit_price_cents: unit });
    }

    const total = cleanItems.reduce((s, i) => s + i.qty * i.unit_price_cents, 0);
    if (total <= 0) return res.status(400).json({ error: 'Order total must be greater than zero' });

    const token = generatePublicToken();
    const orderNumber = nextOrderNumber();
    const ts = now();
    const insert = run(
      `INSERT INTO orders (public_token, org_id, location_id, counter_id, order_number,
        customer_name, customer_phone, special_instructions, total_cents, currency,
        payment_status, order_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'usd', 'PENDING', 'PENDING_PAYMENT', ?, ?)`,
      token,
      req.user!.org_id,
      null,
      counter_id ?? defaultCounterId(),
      orderNumber,
      customer_name ? String(customer_name).slice(0, 120) : null,
      customer_phone ? String(customer_phone).slice(0, 40) : null,
      special_instructions ? String(special_instructions).slice(0, 500) : null,
      total,
      ts,
      ts
    );
    const orderId = Number(insert.lastInsertRowid);
    for (const i of cleanItems) {
      run(
        'INSERT INTO order_items (order_id, item_name, quantity, unit_price_cents, total_price_cents) VALUES (?, ?, ?, ?, ?)',
        orderId,
        i.name,
        i.qty,
        i.unit_price_cents,
        i.qty * i.unit_price_cents
      );
    }
    run(
      'INSERT INTO order_status_history (order_id, old_status, new_status, changed_by) VALUES (?, NULL, ?, ?)',
      orderId,
      'PENDING_PAYMENT',
      req.user!.username
    );

    // Payment: prefer real Stripe Checkout when configured.
    let checkout_url: string | null = null;
    if (stripeConfigured) {
      try {
        checkout_url = await createCheckoutSession(orderId);
      } catch (e: any) {
        console.error('[orders] stripe session failed', e.message);
      }
    }

    res.status(201).json({
      id: orderId,
      order_number: orderNumber,
      public_token: token,
      total_cents: total,
      checkout_url,
      stripe_configured: stripeConfigured,
      demo_payments: DEMO_PAYMENTS && !stripeConfigured,
    });
  }
);

ordersRouter.get('/', (req: AuthRequest, res) => {
  const { status, q, limit } = req.query as Record<string, string>;
  const clauses: string[] = [];
  const params: any[] = [];
  if (status) {
    clauses.push('o.order_status = ?');
    params.push(status);
  }
  if (q) {
    clauses.push('(o.customer_name LIKE ? OR CAST(o.order_number AS TEXT) LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const lim = Math.min(Math.max(parseInt(limit || '100', 10) || 100, 1), 500);
  const rows = all<OrderRow>(
    `SELECT o.* FROM orders o ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
     ORDER BY o.created_at DESC LIMIT ${lim}`,
    ...params
  );
  res.json(
    rows.map((o) => ({
      id: o.id,
      order_number: o.order_number,
      customer_name: o.customer_name,
      order_status: o.order_status,
      payment_status: o.payment_status,
      total_cents: o.total_cents,
    discount_cents: o.discount_cents || 0,
      created_at: o.created_at,
      item_count: row<{ c: number }>(
        'SELECT COUNT(*) AS c FROM order_items WHERE order_id = ?',
        o.id
      )?.c,
    }))
  );
});

// Staff live feed for dashboards / kitchen screens.
ordersRouter.get('/events', (req: AuthRequest, res) => {
  sseInit(res);
  subscribeAll(res);
  req.on('close', () => unsubscribeAll(res));
});

ordersRouter.get('/:id', (req: AuthRequest, res) => {
  const order = row<OrderRow>('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({
    ...order,
    items: itemsFor(order.id),
    tracking_url: trackingUrl(order.public_token),
    history: all(
      'SELECT old_status, new_status, changed_by, changed_at FROM order_status_history WHERE order_id = ? ORDER BY id',
      order.id
    ),
  });
});

ordersRouter.patch('/:id/status', (req: AuthRequest, res) => {
  const { status } = req.body ?? {};
  if (typeof status !== 'string' || !TRANSITIONS[status]) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (!canSetStatus(req.user!.role, status)) {
    return res.status(403).json({ error: 'Your role cannot set this status' });
  }
  const order = row<OrderRow>('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(TRANSITIONS[order.order_status] || []).includes(status)) {
    return res
      .status(409)
      .json({ error: `Cannot move order from ${order.order_status} to ${status}` });
  }
  // Payment must flow through the payment choke point, never a raw status edit.
  if (status === 'PAID') {
    return res
      .status(400)
      .json({ error: 'Use the payment endpoint to mark an order paid' });
  }

  const ts = now();
  run('UPDATE orders SET order_status = ?, updated_at = ? WHERE id = ?', status, ts, order.id);
  run(
    'INSERT INTO order_status_history (order_id, old_status, new_status, changed_by) VALUES (?, ?, ?, ?)',
    order.id,
    order.order_status,
    status,
    req.user!.username
  );
  const updated = row<OrderRow>('SELECT * FROM orders WHERE id = ?', order.id)!;
  broadcastOrderUpdate(updated);
  notifyOrderStatus(order.id, updated.order_number, status, updated.public_token).catch((e) =>
    console.error('[orders] push notify failed', e)
  );
  res.json({ id: updated.id, order_status: updated.order_status, updated_at: ts });
});

// Admin: apply/change a discount (flat cents) while the order is still editable
// (PENDING_PAYMENT or PAID). Total is recalculated from items minus discount.
ordersRouter.patch('/:id/discount', requireRole('ADMIN'), (req: AuthRequest, res) => {
  const order = row<OrderRow>('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['PENDING_PAYMENT', 'PAID'].includes(order.order_status)) {
    return res.status(409).json({ error: 'Order can no longer be discounted — the kitchen is already working on it' });
  }
  const discount = Math.round(Number(req.body?.discount_cents));
  if (!Number.isFinite(discount) || discount < 0) {
    return res.status(400).json({ error: 'Invalid discount' });
  }
  const itemsTotal = all<{ total_price_cents: number }>(
    'SELECT total_price_cents FROM order_items WHERE order_id = ?',
    order.id
  ).reduce((s, i) => s + i.total_price_cents, 0);
  const capped = Math.min(discount, itemsTotal);
  const ts = now();
  run('UPDATE orders SET discount_cents = ?, total_cents = ?, updated_at = ? WHERE id = ?',
    capped, itemsTotal - capped, ts, order.id);
  const updated = row<OrderRow>('SELECT * FROM orders WHERE id = ?', order.id)!;
  broadcastOrderUpdate(updated);
  res.json({ id: updated.id, discount_cents: updated.discount_cents, total_cents: updated.total_cents });
});

// Admin: replace the order's items while it is still editable
// (PENDING_PAYMENT or PAID). Locked once the kitchen accepts the order.
ordersRouter.patch('/:id/items', requireRole('ADMIN'), (req: AuthRequest, res) => {
  const order = row<OrderRow>('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['PENDING_PAYMENT', 'PAID'].includes(order.order_status)) {
    return res.status(409).json({ error: 'Order can no longer be edited — the kitchen is already working on it' });
  }
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }
  const clean: { name: string; qty: number; unit: number }[] = [];
  for (const it of items) {
    const name = String(it.name || it.item_name || '').trim().slice(0, 120);
    const qty = Math.floor(Number(it.qty ?? it.quantity));
    const unit = Math.round(Number(it.unit_price ?? it.unit_price_cents));
    if (!name || !Number.isFinite(qty) || qty < 1 || qty > 99) {
      return res.status(400).json({ error: 'Each item needs a name and quantity 1–99' });
    }
    if (!Number.isFinite(unit) || unit < 0 || unit > 1000000) {
      return res.status(400).json({ error: 'Invalid item price' });
    }
    clean.push({ name, qty, unit });
  }
  const itemsTotal = clean.reduce((s, i) => s + i.qty * i.unit, 0);
  if (itemsTotal <= 0) return res.status(400).json({ error: 'Order total must be greater than zero' });
  const discount = Math.min(order.discount_cents || 0, itemsTotal);
  const ts = now();
  run('DELETE FROM order_items WHERE order_id = ?', order.id);
  for (const i of clean) {
    run(
      'INSERT INTO order_items (order_id, item_name, quantity, unit_price_cents, total_price_cents) VALUES (?, ?, ?, ?, ?)',
      order.id, i.name, i.qty, i.unit, i.qty * i.unit
    );
  }
  run('UPDATE orders SET discount_cents = ?, total_cents = ?, updated_at = ? WHERE id = ?',
    discount, itemsTotal - discount, ts, order.id);
  run(
    'INSERT INTO order_status_history (order_id, old_status, new_status, changed_by) VALUES (?, ?, ?, ?)',
    order.id, order.order_status, order.order_status, req.user!.username + ' (items edited)'
  );
  const updated = row<OrderRow>('SELECT * FROM orders WHERE id = ?', order.id)!;
  broadcastOrderUpdate(updated);
  res.json({ id: updated.id, total_cents: updated.total_cents, discount_cents: updated.discount_cents });
});

// QR code image — ONLY available once payment is confirmed.
ordersRouter.get('/:id/qr.png', (req: AuthRequest, res) => {
  const order = row<OrderRow>('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.payment_status !== 'PAID') {
    return res
      .status(409)
      .json({ error: 'QR code is only available after payment is confirmed' });
  }
  qrPngBuffer(order.public_token)
    .then((buf) => {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(buf);
    })
    .catch(() => res.status(500).json({ error: 'Could not generate QR code' }));
});

// Create a Stripe Checkout session for an unpaid order (card payment).
ordersRouter.post(
  '/:id/payments/stripe',
  requireRole('ADMIN'),
  async (req: AuthRequest, res) => {
    if (!stripeConfigured) {
      return res.status(400).json({ error: 'Stripe is not configured' });
    }
    try {
      const checkout_url = await createCheckoutSession(Number(req.params.id));
      res.json({ checkout_url });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

// Cash payment — a real payment flow for counters that accept cash.
ordersRouter.post(
  '/:id/payments/cash',
  requireRole('ADMIN'),
  (req: AuthRequest, res) => {
    try {
      const result = markOrderPaid(Number(req.params.id), 'cash', null);
      res.json({ ...result, provider: 'cash' });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

// DEMO ONLY: simulated card payment for testing without Stripe keys.
ordersRouter.post('/:id/payments/demo', requireRole('ADMIN'), (req, res) => {
  if (!DEMO_PAYMENTS) {
    return res.status(403).json({ error: 'Demo payments are disabled' });
  }
  try {
    const result = markOrderPaid(Number(req.params.id), 'demo', `demo_${Date.now()}`);
    res.json({ ...result, provider: 'demo', warning: 'DEMO PAYMENT — not a real charge' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
