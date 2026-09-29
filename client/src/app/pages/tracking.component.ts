import { Component, inject, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { ApiService } from '../core/api.service';
import type { PublicOrder } from '../core/models';

type PushState = 'loading' | 'available' | 'subscribed' | 'denied' | 'unsupported';

const STEPS = ['RECEIVED', 'PREPARING', 'READY', 'COMPLETED'];
const STEP_LABELS: Record<string, string> = {
  RECEIVED: 'Received',
  PREPARING: 'Preparing',
  READY: 'Ready',
  COMPLETED: 'Completed',
};

const HEADLINES: Record<string, { emoji: string; title: string; sub: string }> = {
  PENDING_PAYMENT: { emoji: '💳', title: 'Awaiting payment', sub: 'Please complete payment at the counter.' },
  PAID: { emoji: '✅', title: 'Payment confirmed', sub: 'The kitchen has your order and will start soon.' },
  RECEIVED: { emoji: '🧾', title: 'Order received', sub: 'The kitchen has your order.' },
  PREPARING: { emoji: '👨‍🍳', title: 'Being prepared', sub: 'Our cooks are on it — not long now.' },
  PARTIALLY_READY: { emoji: '⏳', title: 'Partially ready', sub: 'Some of your items are ready — the rest are on the way!' },
  READY: { emoji: '🎉', title: 'Ready for pickup!', sub: 'Your order is ready. Please collect it from the counter.' },
  COMPLETED: { emoji: '🙏', title: 'Completed', sub: 'Thanks for ordering with us!' },
  CANCELLED: { emoji: '🚫', title: 'Order cancelled', sub: 'Please contact the counter for help.' },
};

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

@Component({
  selector: 'app-tracking',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="track-wrap" *ngIf="order() as o; else loading">
      <div class="track-card">
        <div class="track-head">
          <span class="track-emoji">{{ headline(o.order_status).emoji }}</span>
          <div>
            <h2>Order #{{ o.order_number }}</h2>
            <p class="muted" *ngIf="o.customer_name">for {{ o.customer_name }}</p>
          </div>
          <span class="live-pill"><span class="live-dot"></span>live</span>
        </div>

        <div class="headline">
          <b>{{ headline(o.order_status).title }}</b>
          <span class="muted">{{ headline(o.order_status).sub }}</span>
        </div>

        <ol class="stepper" *ngIf="!terminal(o.order_status)">
          <li
            *ngFor="let s of steps; let i = index"
            [class.done]="stepState(o.order_status, s) === 'done'"
            [class.active]="stepState(o.order_status, s) === 'active'"
          >
            <span class="step-dot">{{ stepState(o.order_status, s) === 'done' ? '✓' : i + 1 }}</span>
            <span class="step-lbl">{{ stepLabels[s] }}</span>
            <span class="step-partial" *ngIf="s === 'PREPARING' && o.order_status === 'PARTIALLY_READY'">
              ⏳ partially ready
            </span>
          </li>
        </ol>

        <div class="cancelled-banner" *ngIf="o.order_status === 'CANCELLED'">
          This order was cancelled. Please contact the counter.
        </div>

        <h3 class="mt">Your items</h3>
        <ul class="titems">
          <li *ngFor="let it of o.items">
            <span><b>{{ it.quantity }}×</b> {{ it.item_name }}</span>
            <span>{{ money(it.total_price_cents) }}</span>
          </li>
        </ul>
        <div class="cart-grand"><span>Total paid</span><b>{{ money(o.total_cents) }}</b></div>
        <p class="muted sm mt" *ngIf="o.special_instructions">Note: {{ o.special_instructions }}</p>
      </div>

      <div class="track-card">
        <h3>🔔 Get notified</h3>
        <div [ngSwitch]="pushState()">
          <p class="ok" *ngSwitchCase="'subscribed'">You're all set — we'll notify you when your order is ready.</p>
          <p class="muted" *ngSwitchCase="'denied'">Notifications are blocked in your browser settings. This page still updates live.</p>
          <p class="muted" *ngSwitchCase="'unsupported'">This browser doesn't support push — this page still updates live automatically.</p>
          <div *ngSwitchDefault>
            <p class="muted">We'll alert you the moment your order is ready — even if this tab is closed.</p>
            <button class="btn primary block" (click)="enablePush()" [disabled]="pushBusy()">
              {{ pushBusy() ? 'Enabling…' : '🔔 Enable notifications' }}
            </button>
            <p class="muted sm mt" *ngIf="pushMsg()">{{ pushMsg() }}</p>
          </div>
        </div>
      </div>
    </div>

    <ng-template #loading>
      <div class="track-wrap">
        <div class="track-card">
          <p class="muted" *ngIf="!error()">Finding your order…</p>
          <p class="error" *ngIf="error()">{{ error() }}</p>
        </div>
      </div>
    </ng-template>
  `,
})
export class TrackingComponent implements OnDestroy {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);

  order = signal<PublicOrder | null>(null);
  error = signal<string | null>(null);
  pushState = signal<PushState>('loading');
  pushBusy = signal(false);
  pushMsg = signal<string | null>(null);

  steps = STEPS;
  stepLabels = STEP_LABELS;

  private es: EventSource | null = null;
  private token = '';

  constructor() {
    this.token = this.route.snapshot.paramMap.get('token') ?? '';
    void this.init();
  }

  ngOnDestroy(): void {
    this.es?.close();
    this.es = null;
  }

  headline(s: string): { emoji: string; title: string; sub: string } {
    return HEADLINES[s] ?? { emoji: '🧾', title: s, sub: '' };
  }

  terminal(s: string): boolean {
    return s === 'CANCELLED';
  }

  stepState(current: string, step: string): 'done' | 'active' | 'todo' {
    if (current === 'PARTIALLY_READY') {
      if (step === 'RECEIVED' || step === 'PREPARING') return 'done';
      return 'todo';
    }
    const order = ['RECEIVED', 'PREPARING', 'READY', 'COMPLETED'];
    const ci = order.indexOf(current);
    const si = order.indexOf(step);
    if (ci < 0) return 'todo';
    if (si < ci) return 'done';
    if (si === ci) return 'active';
    return 'todo';
  }

  money(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  private async init(): Promise<void> {
    try {
      const o = await this.api.get<PublicOrder>(`/api/orders/token/${encodeURIComponent(this.token)}`);
      this.order.set(o);
      this.es = this.api.orderEvents(this.token, (msg) => {
        if (msg && typeof msg.order_status === 'string') {
          this.order.set({ ...(this.order() as PublicOrder), order_status: msg.order_status });
          void this.refresh();
        }
      });
      void this.checkPush();
    } catch (e: any) {
      this.error.set(e.message || 'This order link is invalid or expired.');
    }
  }

  private async refresh(): Promise<void> {
    try {
      const o = await this.api.get<PublicOrder>(`/api/orders/token/${encodeURIComponent(this.token)}`);
      this.order.set(o);
    } catch {
      /* keep last known state */
    }
  }

  private async checkPush(): Promise<void> {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      this.pushState.set('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      this.pushState.set('denied');
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      this.pushState.set(sub ? 'subscribed' : 'available');
    } catch {
      this.pushState.set('unsupported');
    }
  }

  async enablePush(): Promise<void> {
    this.pushBusy.set(true);
    this.pushMsg.set(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        this.pushMsg.set('Notifications were blocked. This page still updates live.');
        this.pushState.set('denied');
        return;
      }
      const keyRes = await fetch('/api/notifications/vapid-key').then((r) => r.json());
      if (!keyRes.enabled || !keyRes.publicKey) {
        this.pushMsg.set('Push is not set up on the server yet.');
        return;
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
      const res = await fetch('/api/notifications/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: this.token,
          subscription: sub.toJSON(),
          device_type: isIOS ? 'ios' : 'android/other',
        }),
      });
      if (!res.ok) throw new Error('subscribe failed');
      this.pushState.set('subscribed');
    } catch (e) {
      console.error('[push]', e);
      this.pushMsg.set('Could not enable notifications, but this page still updates live.');
    } finally {
      this.pushBusy.set(false);
    }
  }
}
