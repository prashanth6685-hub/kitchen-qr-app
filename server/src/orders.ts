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
import { maybeSendReadySms } from './sms.js';
import { applyCodeToLine, findCode, normalizeCode } from './discounts.js';
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
  READY: ['PARTIALLY_COMPLETED', 'COMPLETED', 'CANCELLED'],
  PARTIALLY_COMPLETED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

// Admin can edit items / instructions / discounts while the order is still
// "pending" — the order locks the moment the kitchen starts preparing it.
const EDITABLE_STATUSES = ['PENDING_PAYMENT', 'PAID', 'RECEIVED'];

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

interface OrderItemInput {
  name: string;
  qty: number;
  unit_price_cents: number;
  /** Manual per-line discount, flat cents (admin-entered). */
  discount_cents?: number;
  /** Discount code to apply to this line (validated + snapshotted). */
  discount_code?: string | null;
}

interface OrderItemClean extends OrderItemInput {
  name: string;
  qty: number;
  unit_price_cents: number;
  discount_cents: number;
  discount_code: string | null;
  code_discount_cents: number;
}

/**
 * Validate + normalize order lines. Only ONE discount code may be active on an
 * order — it is applied to every line it is applicable to.
 *
 * Optional `applyCode` (order-level code from the Discount section):
 *   - a code string  -> that code is applied to each applicable line (replacing
 *                       any previous code); lines it doesn't apply to get none.
 *   - '' (empty)      -> clears the code from every line.
 *   - undefined       -> legacy per-line `discount_code` values are honored.
 */
function cleanItemsInput(items: any, applyCode?: string | null): OrderItemClean[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one item is required');
  }
  const orderCode = applyCode === undefined ? undefined : normalizeCode(String(applyCode || ''));
  if (orderCode) {
    const dc = findCode(orderCode);
    if (!dc) throw new Error('Discount code not found');
    if (!dc.active) throw new Error(`Code ${dc.code} is inactive`);
  }
  const clean: OrderItemClean[] = [];
  let appliedLines = 0;
  for (const it of items) {
    const name = String(it.name || it.item_name || '').trim().slice(0, 120);
    const qty = Math.floor(Number(it.qty ?? it.quantity));
    const unit = Math.round(Number(it.unit_price ?? it.unit_price_cents));
    if (!name || !Number.isFinite(qty) || qty < 1 || qty > 99) {
      throw new Error('Each item needs a name and quantity 1–99');
    }
    if (!Number.isFinite(unit) || unit < 0 || unit > 1000000) {
      throw new Error('Invalid item price');
    }
    const manual = Math.round(Number(it.discount_cents ?? 0));
    if (!Number.isFinite(manual) || manual < 0) throw new Error('Invalid item discount');
    let code: string | null = null;
    let codeDisc = 0;
    if (orderCode === undefined) {
      // Legacy per-line code path.
      const codeRaw = it.discount_code ? normalizeCode(String(it.discount_code)) : null;
      if (codeRaw) {
        const applied = applyCodeToLine(codeRaw, name, qty, unit);
        if (!applied.ok) throw new Error(applied.error);
        code = applied.code!;
        codeDisc = applied.code_discount_cents!;
      }
    } else if (orderCode) {
      // Order-level code: applies only where applicable, never errors per line.
      const applied = applyCodeToLine(orderCode, name, qty, unit);
      if (applied.ok) {
        code = applied.code!;
        codeDisc = applied.code_discount_cents!;
        appliedLines++;
      }
    }
    const gross = qty * unit;
    clean.push({
      name, qty, unit_price_cents: unit,
      discount_cents: Math.min(manual, gross),
      discount_code: code,
      code_discount_cents: codeDisc,
    });
  }
  if (orderCode && appliedLines === 0) {
    throw new Error(`Code ${orderCode} doesn't apply to any item in this order`);
  }
  // Never stack: at most one distinct code across the whole order.
  const distinct = [...new Set(clean.map((l) => l.discount_code).filter(Boolean))];
  if (distinct.length > 1) {
    throw new Error('Only one discount code can be applied per order');
  }
  return clean;
}

function itemsFor(orderId: number) {
  return all(
    `SELECT item_name, quantity, unit_price_cents, total_price_cents,
            discount_cents, discount_code, code_discount_cents
     FROM order_items WHERE order_id = ?`,
    orderId
  );
}

/** Totals from a set of clean lines + the order-level discount (flat cents). */
function computeTotals(lines: OrderItemClean[], orderDiscountCents: number) {
  const itemsTotal = lines.reduce((s, i) => {
    const gross = i.qty * i.unit_price_cents;
    return s + gross - Math.min(i.discount_cents + i.code_discount_cents, gross);
  }, 0);
  const discount = Math.min(Math.max(0, orderDiscountCents), itemsTotal);
  return { itemsTotal, discount_cents: discount, total_cents: itemsTotal - discount };
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
  const order = row<OrderRow & { restaurant_name: string | null }>(
    `SELECT o.*, org.name AS restaurant_name FROM orders o
     LEFT JOIN organizations org ON org.id = o.org_id WHERE o.public_token = ?`,
    req.params.token
  );
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
    restaurant_name: order.restaurant_name,
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

    let cleanItems: OrderItemClean[];
    try {
      cleanItems = cleanItemsInput(items);
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }

    const { total_cents: total } = computeTotals(cleanItems, 0);
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
        `INSERT INTO order_items (order_id, item_name, quantity, unit_price_cents, total_price_cents,
           discount_cents, discount_code, code_discount_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        orderId,
        i.name,
        i.qty,
        i.unit_price_cents,
        i.qty * i.unit_price_cents,
        i.discount_cents,
        i.discount_code,
        i.code_discount_cents
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

// Admin: sales report aggregated over COMPLETED orders — per-item qty sold,
// gross amount, item-level discounts and net, plus order-level totals.
// Optional ?from= / ?to= (ISO datetimes) restrict to orders completed in [from, to).
ordersRouter.get('/report/summary', requireRole('ADMIN'), (req: AuthRequest, res) => {
  const { from, to } = req.query as Record<string, string>;
  const rangeClauses = [`order_status = 'COMPLETED'`];
  const rangeParams: any[] = [];
  if (from) {
    rangeClauses.push('completed_at >= ?');
    rangeParams.push(from);
  }
  if (to) {
    rangeClauses.push('completed_at < ?');
    rangeParams.push(to);
  }
  const rangeWhere = rangeClauses.join(' AND ');
  const items = all<{
    item_name: string;
    orders: number;
    qty: number;
    gross_cents: number;
    discount_cents: number;
    net_cents: number;
  }>(
    `SELECT item_name,
            COUNT(DISTINCT order_id) AS orders,
            SUM(quantity) AS qty,
            SUM(quantity * unit_price_cents) AS gross_cents,
            SUM(MIN(COALESCE(discount_cents, 0) + COALESCE(code_discount_cents, 0),
                    quantity * unit_price_cents)) AS discount_cents,
            SUM(quantity * unit_price_cents) -
              SUM(MIN(COALESCE(discount_cents, 0) + COALESCE(code_discount_cents, 0),
                      quantity * unit_price_cents)) AS net_cents
     FROM order_items
     WHERE order_id IN (SELECT id FROM orders WHERE ${rangeWhere})
     GROUP BY item_name
     ORDER BY qty DESC, item_name ASC`,
    ...rangeParams
  );
  const totals = row<{
    orders: number;
    order_discount_cents: number;
    net_cents: number;
  }>(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(discount_cents), 0) AS order_discount_cents,
            COALESCE(SUM(total_cents), 0) AS net_cents
     FROM orders WHERE ${rangeWhere}`,
    ...rangeParams
  )!;
  const itemGross = items.reduce((s, i) => s + (i.gross_cents || 0), 0);
  const itemDiscountTotal = items.reduce((s, i) => s + (i.discount_cents || 0), 0);
  res.json({
    orders: totals.orders,
    items,
    item_gross_cents: itemGross,
    item_discount_cents: itemDiscountTotal,
    order_discount_cents: totals.order_discount_cents,
    net_cents: totals.net_cents,
  });
});

// Admin: per-day totals for the last N days (UTC day boundaries) — trend view
// for business expansion planning: [{ day: 'YYYY-MM-DD', orders, items, net_cents }].
ordersRouter.get('/report/daily', requireRole('ADMIN'), (req: AuthRequest, res) => {
  const days = Math.min(Math.max(parseInt((req.query.days as string) || '7', 10) || 7, 1), 90);
  const since = `-${days - 1} days`;
  const perOrder = all<{ day: string; total_cents: number }>(
    `SELECT date(completed_at) AS day, total_cents FROM orders
     WHERE order_status = 'COMPLETED' AND completed_at >= datetime('now', ?)`,
    since
  );
  const perItem = all<{ day: string; qty: number }>(
    `SELECT date(o.completed_at) AS day, SUM(oi.quantity) AS qty
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE o.order_status = 'COMPLETED' AND o.completed_at >= datetime('now', ?)
     GROUP BY day`,
    since
  );
  const byDay = new Map<string, { day: string; orders: number; items: number; net_cents: number }>();
  // Fill every day in the window so the trend has no gaps.
  for (let d = days - 1; d >= 0; d--) {
    const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    byDay.set(day, { day, orders: 0, items: 0, net_cents: 0 });
  }
  for (const r of perOrder) {
    const e = byDay.get(r.day);
    if (e) {
      e.orders++;
      e.net_cents += r.total_cents || 0;
    }
  }
  for (const r of perItem) {
    const e = byDay.get(r.day);
    if (e) e.items += r.qty || 0;
  }
  res.json([...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)));
});

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
  const order = row<OrderRow & { restaurant_name: string | null }>(
    `SELECT o.*, org.name AS restaurant_name FROM orders o
     LEFT JOIN organizations org ON org.id = o.org_id WHERE o.id = ?`,
    req.params.id
  );
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
  if (status === 'COMPLETED') {
    run('UPDATE orders SET order_status = ?, updated_at = ?, completed_at = ? WHERE id = ?', status, ts, ts, order.id);
  } else {
    run('UPDATE orders SET order_status = ?, updated_at = ? WHERE id = ?', status, ts, order.id);
  }
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
  // Text the customer on READY / PARTIALLY_COMPLETED — the user-friendly
  // fallback for iPhones, where web push only works for Home-Screen-installed pages.
  const restaurantName =
    row<{ name: string }>(
      'SELECT org.name AS name FROM organizations org JOIN orders o ON o.org_id = org.id WHERE o.id = ?',
      order.id
    )?.name || '';
  if (status === 'READY') {
    maybeSendReadySms(updated.order_number, updated.customer_phone, restaurantName);
  } else if (status === 'PARTIALLY_COMPLETED') {
    maybeSendReadySms(updated.order_number, updated.customer_phone, restaurantName, true);
  }
  res.json({ id: updated.id, order_status: updated.order_status, updated_at: ts });
});

// Admin: apply/change an order-level discount (flat cents) while the order is
// still editable (PENDING_PAYMENT, PAID or RECEIVED). Total is recalculated
// from items (net of per-item discounts) minus this discount.
ordersRouter.patch('/:id/discount', requireRole('ADMIN'), (req: AuthRequest, res) => {
  const order = row<OrderRow>('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!EDITABLE_STATUSES.includes(order.order_status)) {
    return res.status(409).json({ error: 'Order can no longer be discounted — the kitchen has started preparing it' });
  }
  const discount = Math.round(Number(req.body?.discount_cents));
  if (!Number.isFinite(discount) || discount < 0) {
    return res.status(400).json({ error: 'Invalid discount' });
  }
  const lines = all<{ quantity: number; unit_price_cents: number; discount_cents: number; code_discount_cents: number }>(
    'SELECT quantity, unit_price_cents, discount_cents, code_discount_cents FROM order_items WHERE order_id = ?',
    order.id
  ).map((l) => ({
    name: '', qty: l.quantity, unit_price_cents: l.unit_price_cents,
    discount_cents: l.discount_cents || 0, discount_code: null, code_discount_cents: l.code_discount_cents || 0,
  }));
  const { itemsTotal, discount_cents, total_cents } = computeTotals(lines, discount);
  const ts = now();
  run('UPDATE orders SET discount_cents = ?, total_cents = ?, updated_at = ? WHERE id = ?',
    discount_cents, total_cents, ts, order.id);
  const updated = row<OrderRow>('SELECT * FROM orders WHERE id = ?', order.id)!;
  broadcastOrderUpdate(updated);
  res.json({ id: updated.id, discount_cents: updated.discount_cents, total_cents: updated.total_cents, items_total_cents: itemsTotal });
});

// Admin: replace the order's items while it is still editable
// (PENDING_PAYMENT, PAID or RECEIVED). Locked once the kitchen starts preparing.
// Each line may carry a manual discount_cents and/or a discount_code.
ordersRouter.patch('/:id/items', requireRole('ADMIN'), (req: AuthRequest, res) => {
  const order = row<OrderRow>('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!EDITABLE_STATUSES.includes(order.order_status)) {
    return res.status(409).json({ error: 'Order can no longer be edited — the kitchen has started preparing it' });
  }
  let clean: OrderItemClean[];
  try {
    clean = cleanItemsInput(req.body?.items, req.body?.apply_code);
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
  const { total_cents, discount_cents } = computeTotals(clean, order.discount_cents || 0);
  if (total_cents <= 0) return res.status(400).json({ error: 'Order total must be greater than zero' });
  const ts = now();
  run('DELETE FROM order_items WHERE order_id = ?', order.id);
  for (const i of clean) {
    run(
      `INSERT INTO order_items (order_id, item_name, quantity, unit_price_cents, total_price_cents,
         discount_cents, discount_code, code_discount_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      order.id, i.name, i.qty, i.unit_price_cents, i.qty * i.unit_price_cents,
      i.discount_cents, i.discount_code, i.code_discount_cents
    );
  }
  run('UPDATE orders SET discount_cents = ?, total_cents = ?, updated_at = ? WHERE id = ?',
    discount_cents, total_cents, ts, order.id);
  run(
    'INSERT INTO order_status_history (order_id, old_status, new_status, changed_by) VALUES (?, ?, ?, ?)',
    order.id, order.order_status, order.order_status, req.user!.username + ' (items edited)'
  );
  const updated = row<OrderRow>('SELECT * FROM orders WHERE id = ?', order.id)!;
  broadcastOrderUpdate(updated);
  res.json({ id: updated.id, total_cents: updated.total_cents, discount_cents: updated.discount_cents });
});

// Admin: update the order's special instructions while it is still editable
// (PENDING_PAYMENT, PAID or RECEIVED). Locked once the kitchen starts preparing.
ordersRouter.patch('/:id/instructions', requireRole('ADMIN'), (req: AuthRequest, res) => {
  const order = row<OrderRow>('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!EDITABLE_STATUSES.includes(order.order_status)) {
    return res.status(409).json({ error: 'Instructions can no longer be changed — the kitchen has started preparing it' });
  }
  const notes = String(req.body?.special_instructions ?? '').trim().slice(0, 500);
  const ts = now();
  run('UPDATE orders SET special_instructions = ?, updated_at = ? WHERE id = ?', notes || null, ts, order.id);
  const updated = row<OrderRow>('SELECT * FROM orders WHERE id = ?', order.id)!;
  broadcastOrderUpdate(updated);
  res.json({ id: updated.id, special_instructions: updated.special_instructions });
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
