import { ApiService } from './api.service';

/** Shared web-push flow for the customer-facing modules (orders, waitlist).
 *  Reuses the app's service worker; the only per-module bit is the subscribe endpoint. */

export type PushState = 'loading' | 'available' | 'subscribed' | 'denied' | 'unsupported';

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Where does this browser stand on push? Does not prompt the user. */
export async function pushCapability(): Promise<PushState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'subscribed' : 'available';
  } catch {
    return 'unsupported';
  }
}

/**
 * Prompt for permission, subscribe via the service worker, and POST the
 * subscription to the module's subscribe endpoint. Resolves on success;
 * throws an Error with a user-safe message otherwise.
 */
export async function enableWebPush(api: ApiService, subscribePath: string, token: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('denied');
  const keyRes = await api.get<{ publicKey: string; enabled: boolean }>('/api/notifications/vapid-key');
  if (!keyRes.enabled || !keyRes.publicKey) {
    throw new Error('Push is not set up on the server yet.');
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyRes.publicKey),
    });
  }
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  await api.post(subscribePath, {
    token,
    subscription: sub.toJSON(),
    device_type: isIOS ? 'ios' : 'android/other',
  });
}
