import { Injectable } from '@angular/core';
import { AuthService } from './auth.service';

/** Thin fetch wrapper: JSON, auth header, and staff-friendly errors. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  constructor(private auth: AuthService) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    const t = this.auth.token();
    if (t) h['Authorization'] = `Bearer ${t}`;
    return h;
  }

  private async handle<T>(res: Response): Promise<T> {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as any).error || `Request failed (${res.status})`);
    return data as T;
  }

  get<T>(path: string): Promise<T> {
    return fetch(path, { headers: this.headers() }).then((r) => this.handle<T>(r));
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return fetch(path, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }).then((r) => this.handle<T>(r));
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return fetch(path, {
      method: 'PATCH',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }).then((r) => this.handle<T>(r));
  }

  /** Staff live feed (SSE). EventSource can't set headers, so the token rides along as ?token=. */
  staffEvents(onMessage: (data: any) => void): EventSource {
    const t = this.auth.token();
    const es = new EventSource(`/api/orders/events?token=${encodeURIComponent(t ?? '')}`);
    es.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    return es;
  }

  /** Customer live order feed (public token, no login). */
  orderEvents(publicToken: string, onMessage: (data: any) => void): EventSource {
    const es = new EventSource(`/api/orders/token/${encodeURIComponent(publicToken)}/events`);
    es.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    return es;
  }

  /** Customer live waitlist feed (public token, no login). Listens for `waitlist` events. */
  waitlistEvents(publicToken: string, onMessage: (data: any) => void): EventSource {
    const es = new EventSource(`/api/waitlist/token/${encodeURIComponent(publicToken)}/events`);
    es.addEventListener('waitlist', (e) => {
      try {
        onMessage(JSON.parse((e as MessageEvent).data));
      } catch {
        /* ignore malformed frames */
      }
    });
    return es;
  }

  /** Staff live waitlist feed for one location. EventSource can't set headers, so the token rides along as ?token=. */
  waitlistStaffEvents(locationId: number, onMessage: (data: any) => void): EventSource {
    const t = this.auth.token();
    const es = new EventSource(
      `/api/waitlist/admin/events?location_id=${locationId}&token=${encodeURIComponent(t ?? '')}`
    );
    es.addEventListener('waitlist', (e) => {
      try {
        onMessage(JSON.parse((e as MessageEvent).data));
      } catch {
        /* ignore malformed frames */
      }
    });
    return es;
  }

  qrUrl(orderId: number): string {
    const t = this.auth.token();
    return `/api/orders/${orderId}/qr.png?token=${encodeURIComponent(t ?? '')}`;
  }
}
