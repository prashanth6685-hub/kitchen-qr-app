import webpush from 'web-push';
import { all, row, run } from './db.js';

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const CONTACT = process.env.VAPID_CONTACT || 'mailto:kitchen@example.com';

export const pushEnabled = Boolean(PUBLIC_KEY && PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(CONTACT, PUBLIC_KEY, PRIVATE_KEY);
  console.log('[push] Web Push enabled (VAPID configured)');
} else {
  console.warn(
    '[push] VAPID keys not set — push notifications disabled. Run `npm run seed` or set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY.'
  );
}

export function getVapidPublicKey(): string {
  return PUBLIC_KEY;
}

export interface PushSubscriptionRecord {
  id: number;
  order_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_type: string | null;
}

export function saveSubscription(
  orderId: number,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  deviceType?: string
) {
  run(
    `INSERT INTO push_subscriptions (order_id, endpoint, p256dh, auth, device_type)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET order_id = excluded.order_id, device_type = excluded.device_type`,
    orderId,
    sub.endpoint,
    sub.keys.p256dh,
    sub.keys.auth,
    deviceType || null
  );
}

export function subscriptionsForOrder(orderId: number): PushSubscriptionRecord[] {
  return all('SELECT * FROM push_subscriptions WHERE order_id = ?', orderId);
}

const STATUS_MESSAGES: Record<string, { title: string; body: (n: number) => string }> = {
  RECEIVED: {
    title: 'Order Received',
    body: (n) => `We've received your order #${n}.`,
  },
  PREPARING: {
    title: 'Order Being Prepared',
    body: (n) => `Your order #${n} is now being prepared.`,
  },
  READY: {
    title: 'Order Ready 🎉',
    body: (n) => `Your order #${n} is ready for pickup!`,
  },
  COMPLETED: {
    title: 'Order Completed',
    body: (n) => `Thank you for your order #${n}!`,
  },
  CANCELLED: {
    title: 'Order Cancelled',
    body: (n) => `Your order #${n} has been cancelled. Please contact the counter.`,
  },
  PAID: {
    title: 'Payment Confirmed',
    body: (n) => `Payment confirmed for order #${n}.`,
  },
};

export async function notifyOrderStatus(
  orderId: number,
  orderNumber: number,
  newStatus: string,
  publicToken: string
) {
  if (!pushEnabled) return;
  const msg = STATUS_MESSAGES[newStatus];
  if (!msg) return;
  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const subs = subscriptionsForOrder(orderId);
  const payload = JSON.stringify({
    title: msg.title,
    body: msg.body(orderNumber),
    url: `${baseUrl}/order/${publicToken}`,
    tag: `order-${orderId}`,
  });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (err: any) {
      // 404/410 = subscription gone; clean it up so we don't retry forever.
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        run('DELETE FROM push_subscriptions WHERE id = ?', sub.id);
      } else {
        console.error('[push] failed to send to', sub.endpoint.slice(0, 60), err?.message);
      }
    }
  }
}
