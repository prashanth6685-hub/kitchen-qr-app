/** Web Push helpers for the customer tracking page. */

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushState = 'unsupported' | 'denied' | 'subscribed' | 'available';

export async function getPushState(): Promise<PushState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) return 'subscribed';
  } catch {
    return 'unsupported';
  }
  return 'available';
}

export async function isIOS(): Promise<boolean> {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua);
  // iPadOS reports as Mac; check touch points.
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return ios || iPadOS;
}

export async function isStandalone(): Promise<boolean> {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as any).standalone === true
  );
}

/**
 * Ask for notification permission and subscribe to Web Push for this order.
 * Returns a human-readable status for the UI.
 */
export async function enablePush(orderToken: string): Promise<{ ok: boolean; message: string }> {
  return subscribePush(
    '/api/notifications/subscribe',
    { token: orderToken },
    "You're all set — we'll notify you when your order is ready.",
    'You can still track your order on this page.'
  );
}

/**
 * Ask for notification permission and subscribe to Web Push for a waitlist entry.
 * Returns a human-readable status for the UI.
 */
export async function enableWaitlistPush(waitlistToken: string): Promise<{ ok: boolean; message: string }> {
  return subscribePush(
    '/api/waitlist/notifications/subscribe',
    { token: waitlistToken },
    "You're all set — we'll notify you when your table is almost ready.",
    'You can still watch your place in line on this page.'
  );
}

async function subscribePush(
  subscribeUrl: string,
  payload: Record<string, unknown>,
  okMessage: string,
  blockedFallback: string
): Promise<{ ok: boolean; message: string }> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, message: 'Push notifications are not supported in this browser.' };
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, message: `Notifications were blocked. ${blockedFallback}` };
  }
  try {
    const keyRes = await fetch('/api/notifications/vapid-key');
    const { publicKey, enabled } = await keyRes.json();
    if (!enabled || !publicKey) {
      return { ok: false, message: 'Push is not set up on the server yet.' };
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const device = (await isIOS()) ? 'ios' : 'android/other';
    const res = await fetch(subscribeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, subscription: sub.toJSON(), device_type: device }),
    });
    if (!res.ok) throw new Error('subscribe failed');
    return { ok: true, message: okMessage };
  } catch (e) {
    console.error('[push]', e);
    return { ok: false, message: 'Could not enable notifications, but this page still updates live.' };
  }
}
