import { Injectable, signal } from '@angular/core';
import type { StaffUser } from './models';

const TOKEN_KEY = 'kqr.token';
const USER_KEY = 'kqr.user';

/** Session state: JWT + logged-in staff user, persisted in localStorage. */
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly user = signal<StaffUser | null>(null);
  readonly token = signal<string | null>(null);

  constructor() {
    try {
      const t = localStorage.getItem(TOKEN_KEY);
      const u = localStorage.getItem(USER_KEY);
      if (t && u) {
        this.token.set(t);
        this.user.set(JSON.parse(u) as StaffUser);
      }
    } catch {
      /* storage unavailable */
    }
  }

  get role(): string {
    return this.user()?.role ?? '';
  }

  async login(username: string, password: string): Promise<void> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Login failed');
    this.token.set(data.token);
    this.user.set(data.user);
    try {
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    } catch {
      /* ignore */
    }
  }

  logout(): void {
    this.token.set(null);
    this.user.set(null);
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {
      /* ignore */
    }
  }
}
