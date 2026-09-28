import Stripe from 'stripe';
import { row, run, now } from './db.js';
import { broadcastOrderUpdate } from './sse.js';
import { notifyOrderStatus } from './push.js';

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
export const stripeConfigured = Boolean(STRIPE_KEY);

export const stripe = stripeConfigured
  ? new Stripe(STRIPE_KEY, { apiVersion: '2024-11-20.acacia' as any })
  : null;

if (stripeConfigured) {
  console.log('[payments] Stripe configured');
} else {
  console.warn(
    '[payments] STRIPE_SECRET_KEY not set — card payments disabled. ' +
      'Cash payments still work; set DEMO_PAYMENTS=true to test the card flow without Stripe.'
  );
}

export const DEMO_PAYMENTS = process.env.DEMO_PAYMENTS === 'true';

export interface OrderRow {
  id: number;
  public_token: string;
  order_number: number;
  total_cents: number;
  currency: string;
  payment_status: string;
  order_status: string;
  updated_at: string;
}

function orderPublicShape(o: OrderRow) {
  return {
    id: o.id,
    public_token: o.public_token,
    order_number: o.order_number,
    order_status: o.order_status,
    payment_status: o.payment_status,
    updated_at: o.updated_at,
  };
}

function recordStatusHistory(orderId: number, oldStatus: string | null, newStatus: string, changedBy: string) {
  run(
    'INSERT INTO order_status_history (order_id, old_status, new_status, changed_by) VALUES (?, ?, ?, ?)',
    orderId,
    oldStatus,
    newStatus,
    changedBy
  );
}

/**
 * The single choke point for marking an order paid. Called ONLY from:
 *  - the verified Stripe webhook,
 *  - the staff cash-payment endpoint,
 *  - the DEMO endpoint (DEMO_PAYMENTS=true only, clearly labeled).
 * Never mark an order paid from the frontend's word alone.
 */
export function markOrderPaid(orderId: number, provider: string, providerReference: string | null) {
  const order = row<OrderRow>('SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) throw new Error('Order not found');
  if (order.payment_status === 'PAID') return orderPublicShape(order); // idempotent

  if (order.order_status !== 'PENDING_PAYMENT') {
    throw new Error(`Order cannot be paid from status ${order.order_status}`);
  }

  const ts = now();
  run(
    `INSERT INTO payments (order_id, provider, provider_reference, amount_cents, currency, status)
     VALUES (?, ?, ?, ?, ?, 'SUCCEEDED')`,
    orderId,
    provider,
    providerReference,
    order.total_cents,
    order.currency
  );
  run(
    `UPDATE orders SET payment_status = 'PAID', order_status = 'PAID', updated_at = ? WHERE id = ?`,
    ts,
    orderId
  );
  recordStatusHistory(orderId, order.order_status, 'PAID', `payment:${provider}`);

  const updated = row<OrderRow>('SELECT * FROM orders WHERE id = ?', orderId)!;
  broadcastOrderUpdate(updated);
  // Fire-and-forget push (subscriptions usually don't exist yet at payment time,
  // but a returning customer may already be subscribed).
  notifyOrderStatus(orderId, updated.order_number, 'PAID', updated.public_token).catch((e) =>
    console.error('[payments] push notify failed', e)
  );
  console.log(`[payments] order #${updated.order_number} marked PAID via ${provider}`);
  return orderPublicShape(updated);
}

/** Create a Stripe Checkout Session for an unpaid order. Returns the hosted URL. */
export async function createCheckoutSession(orderId: number): Promise<string> {
  if (!stripe) throw new Error('Stripe is not configured');
  const order = row<OrderRow & { customer_name: string | null }>(
    'SELECT * FROM orders WHERE id = ?',
    orderId
  );
  if (!order) throw new Error('Order not found');
  if (order.payment_status === 'PAID') throw new Error('Order is already paid');

  const items = row<{ names: string }>(
    `SELECT GROUP_CONCAT(item_name || ' x' || quantity, ', ') AS names FROM order_items WHERE order_id = ?`,
    orderId
  );
  const baseUrl = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

  // Drop superseded pending sessions so a retry doesn't stack duplicates.
  run(`DELETE FROM payments WHERE order_id = ? AND provider = 'stripe' AND status = 'PENDING'`, orderId);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: order.currency,
          unit_amount: order.total_cents,
          product_data: { name: `Order #${order.order_number} — ${items?.names || 'Kitchen order'}` },
        },
        quantity: 1,
      },
    ],
    metadata: { order_id: String(orderId) },
    success_url: `${baseUrl}/staff/orders/${orderId}?paid=1`,
    cancel_url: `${baseUrl}/staff/orders/${orderId}?cancelled=1`,
  });

  run(
    `INSERT INTO payments (order_id, provider, provider_reference, amount_cents, currency, status)
     VALUES (?, ?, ?, ?, ?, 'PENDING')`,
    orderId,
    'stripe',
    session.id,
    order.total_cents,
    order.currency
  );

  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

/** Verify + handle a Stripe webhook event. Returns true if it was a payment event we handled. */
export async function handleStripeWebhook(rawBody: Buffer, signature: string): Promise<boolean> {
  if (!stripe || !WEBHOOK_SECRET) throw new Error('Stripe webhook not configured');
  const event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const orderId = Number(session.metadata?.order_id);
    if (!orderId) {
      console.error('[payments] checkout.session.completed without order_id metadata');
      return true;
    }
    // Idempotency: Stripe may redeliver; markOrderPaid is safe to call twice.
    const existing = row(
      'SELECT id FROM payments WHERE provider_reference = ? AND status = ?',
      session.id,
      'SUCCEEDED'
    );
    if (!existing) {
      run('UPDATE payments SET status = ? WHERE provider_reference = ?', 'SUCCEEDED', session.id);
      markOrderPaid(orderId, 'stripe', session.payment_intent as string);
    }
    return true;
  }

  if (event.type === 'checkout.session.expired' || event.type === 'payment_intent.payment_failed') {
    const obj: any = event.data.object;
    const ref = obj.id as string;
    run('UPDATE payments SET status = ? WHERE provider_reference = ?', 'FAILED', ref);
    return true;
  }

  return false;
}
