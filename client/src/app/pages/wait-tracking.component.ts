import { Component, inject, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { ApiService } from '../core/api.service';
import { enableWebPush, pushCapability, type PushState } from '../core/push';
import type { WaitlistEntry } from '../core/models';

const STEPS = ['CHECKED_IN', 'WAITING', 'ALMOST_READY', 'CALLED', 'SEATED'];
const STEP_LABELS: Record<string, string> = {
  CHECKED_IN: 'Checked in',
  WAITING: 'Waiting',
  ALMOST_READY: 'Almost your turn',
  CALLED: 'Called',
  SEATED: 'Seated',
};

const HEADLINES: Record<string, { emoji: string; title: string; sub: string }> = {
  WAITING: { emoji: '🪑', title: "You're on the waiting list", sub: 'Feel free to step away — we will notify you.' },
  ALMOST_READY: { emoji: '🔔', title: "You're next!", sub: 'Your table is almost ready. Please stay near the restaurant.' },
  CALLED: { emoji: '🎉', title: 'Your table is ready!', sub: 'Please proceed to the host stand.' },
  SEATED: { emoji: '🍽️', title: "You're seated", sub: 'Enjoy your meal!' },
  SKIPPED: { emoji: '⏭️', title: 'Skipped', sub: 'Your number was passed — please check with the host.' },
  NO_SHOW: { emoji: '❔', title: 'Marked as no-show', sub: 'Please check with the host to rejoin.' },
  CANCELLED: { emoji: '🚫', title: 'Wait cancelled', sub: 'Your waiting-list entry was cancelled.' },
  EXPIRED: { emoji: '⌛', title: 'Wait expired', sub: 'Please check in again at the restaurant.' },
};

const TERMINAL = new Set(['CANCELLED', 'NO_SHOW', 'EXPIRED', 'SKIPPED']);

@Component({
  selector: 'app-wait-tracking',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="track-wrap" *ngIf="entry() as e; else loading">
      <div class="track-card">
        <div class="track-head">
          <span class="track-emoji">{{ headline(e.status).emoji }}</span>
          <div>
            <h2>{{ e.restaurant_name }}</h2>
            <p class="muted" *ngIf="e.customer_name">for {{ e.customer_name }}</p>
          </div>
          <span class="live-pill" *ngIf="!TERMINAL.has(e.status)"><span class="live-dot"></span>live</span>
        </div>

        <div class="headline">
          <b>{{ headline(e.status).title }}</b>
          <span class="muted">{{ headline(e.status).sub }}</span>
        </div>

        <div class="queue-hero" *ngIf="!TERMINAL.has(e.status)">
          <span class="muted sm">Your number</span>
          <div class="queue-num">{{ e.queue_number }}</div>
          <div class="queue-meta">
            <span>Party of {{ e.party_size }}</span>
            <span>·</span>
            <span>{{ e.parties_ahead }} {{ e.parties_ahead === 1 ? 'party' : 'parties' }} ahead</span>
          </div>
          <div class="queue-meta">
            <span>Currently serving <b>{{ e.currently_serving ?? '—' }}</b></span>
            <span>·</span>
            <span>Est. wait <b>{{ e.estimated_wait_label }}</b></span>
          </div>
        </div>

        <ol class="stepper" *ngIf="!TERMINAL.has(e.status)">
          <li
            *ngFor="let s of steps; let i = index"
            [class.done]="stepState(e.status, s) === 'done'"
            [class.active]="stepState(e.status, s) === 'active'"
          >
            <span class="step-dot">{{ stepState(e.status, s) === 'done' ? '✓' : i + 1 }}</span>
            <span class="step-lbl">{{ stepLabels[s] }}</span>
          </li>
        </ol>

        <div class="cancelled-banner" *ngIf="e.status === 'CANCELLED'">
          This wait was cancelled. Scan the restaurant QR code to check in again.
        </div>
        <div class="cancelled-banner" *ngIf="e.status === 'NO_SHOW' || e.status === 'EXPIRED'">
          This entry is no longer active. Please check with the host or check in again.
        </div>

        <div class="qr-wrap" *ngIf="qrUrl()">
          <img class="qr-img" [src]="qrUrl()" alt="Your waiting-list QR code" />
        </div>
        <p class="muted sm" style="text-align:center">Scan this QR anytime to return to this page.</p>

        <div class="btn-row mt" *ngIf="e.status === 'WAITING' || e.status === 'ALMOST_READY'">
          <button class="btn danger sm" (click)="cancelWait()" [disabled]="cancelBusy()">
            {{ cancelBusy() ? 'Cancelling…' : 'Cancel my wait' }}
          </button>
        </div>
        <p class="error mt" *ngIf="cancelError()">{{ cancelError() }}</p>
      </div>

      <div class="track-card" *ngIf="!TERMINAL.has(e.status)">
        <h3>🔔 Get notified</h3>
        <div [ngSwitch]="pushState()">
          <p class="ok" *ngSwitchCase="'subscribed'">You're all set — we'll notify you when your table is getting close.</p>
          <p class="muted" *ngSwitchCase="'denied'">Notifications are blocked in your browser settings. This page still updates live.</p>
          <p class="muted" *ngSwitchCase="'unsupported'">This browser doesn't support push — this page still updates live automatically.</p>
          <div *ngSwitchDefault>
            <p class="muted">We'll alert you when you're next — even if this tab is closed.</p>
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
          <p class="muted" *ngIf="!error()">Finding your waitlist entry…</p>
          <p class="error" *ngIf="error()">{{ error() }}</p>
        </div>
      </div>
    </ng-template>
  `,
})
export class WaitTrackingComponent implements OnDestroy {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);

  entry = signal<WaitlistEntry | null>(null);
  error = signal<string | null>(null);
  pushState = signal<PushState>('loading');
  pushBusy = signal(false);
  pushMsg = signal<string | null>(null);
  cancelBusy = signal(false);
  cancelError = signal<string | null>(null);

  steps = STEPS;
  stepLabels = STEP_LABELS;
  TERMINAL = TERMINAL;

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
    return HEADLINES[s] ?? { emoji: '🪑', title: s, sub: '' };
  }

  /** Map the 8 waitlist statuses onto the 5 visible steps. */
  stepState(current: string, step: string): 'done' | 'active' | 'todo' {
    const order = ['CHECKED_IN', 'WAITING', 'ALMOST_READY', 'CALLED', 'SEATED'];
    const cur = current === 'WAITING' ? 1 : order.indexOf(current);
    const si = order.indexOf(step);
    if (cur < 0) return 'todo';
    if (si < cur) return 'done';
    if (si === cur) return 'active';
    return 'todo';
  }

  qrUrl(): string | null {
    return this.entry() ? `/api/waitlist/token/${encodeURIComponent(this.token)}/qr.png` : null;
  }

  private async init(): Promise<void> {
    try {
      const e = await this.api.get<WaitlistEntry>(
        `/api/waitlist/token/${encodeURIComponent(this.token)}`
      );
      this.entry.set(e);
      this.es = this.api.waitlistEvents(this.token, (msg) => {
        if (msg && typeof msg.status === 'string') this.entry.set(msg as WaitlistEntry);
      });
      this.pushState.set(await pushCapability());
    } catch (e: any) {
      this.error.set(
        /404|invalid or expired/i.test(String(e.message))
          ? 'This waitlist link is invalid or expired. Please scan the restaurant QR code to check in again.'
          : e.message || 'Could not load your waitlist entry.'
      );
    }
  }

  async enablePush(): Promise<void> {
    this.pushBusy.set(true);
    this.pushMsg.set(null);
    try {
      await enableWebPush(this.api, '/api/waitlist/notifications/subscribe', this.token);
      this.pushState.set('subscribed');
    } catch (e: any) {
      if (e.message === 'denied') {
        this.pushMsg.set('Notifications were blocked. This page still updates live.');
        this.pushState.set('denied');
      } else {
        this.pushMsg.set('Could not enable notifications, but this page still updates live.');
      }
    } finally {
      this.pushBusy.set(false);
    }
  }

  async cancelWait(): Promise<void> {
    if (!confirm('Cancel your wait? You will lose your place in line.')) return;
    this.cancelBusy.set(true);
    this.cancelError.set(null);
    try {
      await this.api.post<{ ok: boolean; status: string }>(
        `/api/waitlist/token/${encodeURIComponent(this.token)}/cancel`,
        {}
      );
      const cur = this.entry();
      if (cur) this.entry.set({ ...cur, status: 'CANCELLED' });
    } catch (e: any) {
      this.cancelError.set(e.message || 'Could not cancel. Please ask the host for help.');
    } finally {
      this.cancelBusy.set(false);
    }
  }
}
