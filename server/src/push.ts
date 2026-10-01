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
  PARTIALLY_COMPLETED: {
    title: 'Part of your order is ready 🟡',
    body: (n) => `Part of your order #${n} is ready for pickup!`,
  },
  COMPLETED: {
    title: 'Order Ready 🎉',
    body: (n) => `Your order #${n} is ready for pickup!`,
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
  const orgRow = row<{ name: string }>(
    'SELECT org.name AS name FROM organizations org JOIN orders o ON o.org_id = org.id WHERE o.id = ?',
    orderId
  );
  const restaurant = orgRow?.name || '';
  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const subs = subscriptionsForOrder(orderId);
  const payload = JSON.stringify({
    title: restaurant ? `${restaurant}: ${msg.title}` : msg.title,
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

// ---------- Module 2: waiting-list push notifications ----------

export interface WaitlistSubscriptionRecord {
  id: number;
  waitlist_entry_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_type: string | null;
}

export function saveWaitlistSubscription(
  entryId: number,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  deviceType?: string
) {
  run(
    `INSERT INTO waitlist_subscriptions (waitlist_entry_id, endpoint, p256dh, auth, device_type)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET waitlist_entry_id = excluded.waitlist_entry_id, device_type = excluded.device_type`,
    entryId,
    sub.endpoint,
    sub.keys.p256dh,
    sub.keys.auth,
    deviceType || null
  );
}

function subscriptionsForWaitlistEntry(entryId: number): WaitlistSubscriptionRecord[] {
  return all('SELECT * FROM waitlist_subscriptions WHERE waitlist_entry_id = ?', entryId);
}

const WAITLIST_MESSAGES: Record<string, { title: (r: string) => string; body: (qn: string) => string }> = {
  ALMOST_READY: {
    title: (r) => `${r}: You're next!`,
    body: (qn) => `Your table is almost ready. Queue number ${qn} — please stay near the restaurant.`,
  },
  CALLED: {
    title: (r) => `${r}: Your table is ready!`,
    body: (qn) => `Queue number ${qn} — please proceed to the host stand.`,
  },
  RECALLED: {
    title: (r) => `${r}: Your table is ready!`,
    body: (qn) => `Reminder: queue number ${qn} — please proceed to the host stand.`,
  },
  SEATED: {
    title: (r) => `${r}: Welcome!`,
    body: (qn) => `Queue number ${qn} is now seated. Enjoy your meal!`,
  },
};

/**
 * Push a waitlist status change to the customer's subscribed devices.
 * Idempotent per status: ALMOST_READY / CALLED are only pushed once
 * (tracked with notified_* flags on the entry); RECALLED re-pushes deliberately.
 */
export async function notifyWaitlistStatus(
  entryId: number,
  queueNumber: string,
  newStatus: string,
  publicToken: string,
  restaurantName: string
) {
  if (!pushEnabled) return;
  const msg = WAITLIST_MESSAGES[newStatus];
  if (!msg) return;
  const entry = row<{ notified_almost_ready: number; notified_called: number }>(
    'SELECT notified_almost_ready, notified_called FROM waitlist_entries WHERE id = ?',
    entryId
  );
  if (!entry) return;
  if (newStatus === 'ALMOST_READY' && entry.notified_almost_ready) return;
  if (newStatus === 'CALLED' && entry.notified_called) return;

  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const subs = subscriptionsForWaitlistEntry(entryId);
  if (subs.length === 0) return;
  const payload = JSON.stringify({
    title: msg.title(restaurantName),
    body: msg.body(queueNumber),
    url: `${baseUrl}/wait/${publicToken}`,
    tag: `waitlist-${entryId}`,
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
        run('DELETE FROM waitlist_subscriptions WHERE id = ?', sub.id);
      } else {
        console.error('[push] failed to send to', sub.endpoint.slice(0, 60), err?.message);
      }
    }
  }
  if (newStatus === 'ALMOST_READY') {
    run('UPDATE waitlist_entries SET notified_almost_ready = 1 WHERE id = ?', entryId);
  } else if (newStatus === 'CALLED') {
    run('UPDATE waitlist_entries SET notified_called = 1 WHERE id = ?', entryId);
  }
}
