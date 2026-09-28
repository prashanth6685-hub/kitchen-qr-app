const TOKEN_KEY = 'kqr_staff_token';
const USER_KEY = 'kqr_staff_user';

export interface StaffUser {
  id: number;
  username: string;
  role: 'ADMIN' | 'KITCHEN_STAFF' | 'COUNTER_STAFF';
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): StaffUser | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as StaffUser) : null;
}

export function saveSession(token: string, user: StaffUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data as T;
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid',
  RECEIVED: 'Order received',
  PREPARING: 'Preparing',
  READY: 'Ready',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const STATUS_STEPS = ['RECEIVED', 'PREPARING', 'READY', 'COMPLETED'] as const;
