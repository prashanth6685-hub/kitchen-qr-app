import { Component, inject, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { enableWebPush, pushCapability, type PushState } from '../core/push';
import type { WaitlistEntry, WaitlistLocation } from '../core/models';

@Component({
  selector: 'app-checkin',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="track-wrap">
      <!-- Check-in form -->
      <div class="track-card" *ngIf="!entry(); else doneTpl">
        <div class="track-head">
          <span class="track-emoji">🍽️</span>
          <div>
            <h2 *ngIf="location() as loc">{{ loc.restaurant_name }}</h2>
            <h2 *ngIf="!location() && !error()">Check in</h2>
            <p class="muted" *ngIf="location() as loc">{{ loc.name }} · Join the waiting list</p>
          </div>
          <span class="live-pill" *ngIf="location() as loc"><span class="live-dot"></span>{{ loc.parties_waiting }} waiting</span>
        </div>

        <p class="error" *ngIf="error()">{{ error() }}</p>

        <div *ngIf="location() as loc; else loadingTpl">
          <div class="info" *ngIf="!loc.waitlist_enabled">
            The waiting list is currently closed at this location. Please ask the host for help.
          </div>
          <form *ngIf="loc.waitlist_enabled" (ngSubmit)="checkIn()" #f="ngForm">
            <label class="field">
              <span>Name</span>
              <input name="customerName" [(ngModel)]="customerName" required maxlength="120"
                     placeholder="Your name" autocomplete="name" />
            </label>
            <label class="field">
              <span>Number of guests</span>
              <input name="partySize" [(ngModel)]="partySize" required type="number" min="1" max="30"
                     inputmode="numeric" />
            </label>
            <label class="field">
              <span>Phone number (optional)</span>
              <input name="customerPhone" [(ngModel)]="customerPhone" type="tel" maxlength="40"
                     placeholder="So we can find your spot if you check in twice" autocomplete="tel" />
            </label>
            <label class="field">
              <span>Special requirements (optional)</span>
              <textarea name="specialReq" [(ngModel)]="specialRequirements" rows="2" maxlength="500"
                        placeholder="High chair, wheelchair access, indoor/outdoor…"></textarea>
            </label>
            <button class="btn primary block lg" type="submit" [disabled]="busy() || !f.form.valid">
              {{ busy() ? 'Checking in…' : 'CHECK IN' }}
            </button>
            <p class="muted sm mt">Currently serving <b>{{ loc.currently_serving ?? '—' }}</b> ·
              estimated wait {{ loc.estimated_wait_label }}</p>
          </form>
        </div>
      </div>

      <!-- Success / duplicate confirmation -->
      <ng-template #doneTpl>
        <div class="track-card" *ngIf="entry() as e">
          <div class="track-head">
            <span class="track-emoji">{{ e.duplicate ? '🔁' : '✅' }}</span>
            <div>
              <h2>{{ e.restaurant_name }}</h2>
              <p class="muted">{{ e.duplicate ? 'You are already on the waiting list' : "You're checked in!" }}</p>
            </div>
          </div>

          <div class="queue-hero">
            <span class="muted sm">Your number</span>
            <div class="queue-num">{{ e.queue_number }}</div>
            <div class="queue-meta">
              <span>Party of {{ e.party_size }}</span>
              <span>·</span>
              <span>{{ e.parties_ahead }} {{ e.parties_ahead === 1 ? 'party' : 'parties' }} ahead</span>
              <span>·</span>
              <span>{{ e.estimated_wait_label }}</span>
            </div>
          </div>

          <div class="qr-wrap" *ngIf="qrUrl()">
            <img class="qr-img" [src]="qrUrl()" alt="Your waiting-list QR code" />
          </div>
          <p class="muted sm" style="text-align:center">Keep this page open — or scan the QR to return to it.</p>

          <div class="track-card mt" style="padding:1rem">
            <h3 style="margin-top:0">🔔 Get notified</h3>
            <div [ngSwitch]="pushState()">
              <p class="ok" *ngSwitchCase="'subscribed'" style="margin:0">You're all set — we'll notify you when your table is getting close.</p>
              <p class="muted" *ngSwitchCase="'denied'">Notifications are blocked in your browser settings. This page still updates live.</p>
              <p class="muted" *ngSwitchCase="'unsupported'">This browser doesn't support push — this page still updates live automatically.</p>
              <div *ngSwitchDefault>
                <p class="muted sm">We'll alert you when you're next — even if this tab is closed.</p>
                <button class="btn primary block" (click)="enablePush()" [disabled]="pushBusy()">
                  {{ pushBusy() ? 'Enabling…' : '🔔 Enable notifications' }}
                </button>
                <p class="muted sm mt" *ngIf="pushMsg()">{{ pushMsg() }}</p>
              </div>
            </div>
          </div>

          <a class="btn primary block lg mt" [routerLink]="['/wait', e.public_token]">
            View my spot →
          </a>
        </div>
      </ng-template>

      <ng-template #loadingTpl>
        <p class="muted" *ngIf="!error()">Loading…</p>
      </ng-template>
    </div>
  `,
})
export class CheckinComponent implements OnDestroy {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);

  location = signal<WaitlistLocation | null>(null);
  entry = signal<WaitlistEntry | null>(null);
  error = signal<string | null>(null);
  busy = signal(false);
  pushState = signal<PushState>('loading');
  pushBusy = signal(false);
  pushMsg = signal<string | null>(null);

  customerName = '';
  partySize: number | null = null;
  customerPhone = '';
  specialRequirements = '';

  private slug = '';

  constructor() {
    this.slug = this.route.snapshot.paramMap.get('slug') ?? '';
    void this.load();
  }

  ngOnDestroy(): void {
    /* nothing persistent */
  }

  qrUrl(): string | null {
    const t = this.entry()?.public_token;
    return t ? `/api/waitlist/token/${encodeURIComponent(t)}/qr.png` : null;
  }

  private async load(): Promise<void> {
    try {
      const loc = await this.api.get<WaitlistLocation>(
        `/api/waitlist/location/${encodeURIComponent(this.slug)}`
      );
      this.location.set(loc);
    } catch (e: any) {
      this.error.set(
        /404|failed \(404\)/i.test(String(e.message))
          ? 'This check-in link is invalid. Please scan the QR code at the restaurant entrance.'
          : e.message || 'Could not load this location.'
      );
    }
  }

  async checkIn(): Promise<void> {
    const name = this.customerName.trim();
    const size = Number(this.partySize);
    if (!name || !size || size < 1 || size > 30) {
      this.error.set('Please enter your name and a party size between 1 and 30.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const body: Record<string, unknown> = {
        slug: this.slug,
        customer_name: name,
        party_size: size,
      };
      const phone = this.customerPhone.trim();
      const req = this.specialRequirements.trim();
      if (phone) body['customer_phone'] = phone;
      if (req) body['special_requirements'] = req;
      const e = await this.api.post<WaitlistEntry>('/api/waitlist/check-in', body);
      this.entry.set(e);
      void pushCapability().then((s) => this.pushState.set(s));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e: any) {
      const msg = String(e.message || '');
      this.error.set(
        /429|too many check-ins/i.test(msg)
          ? 'Too many check-ins from this device — please wait a few minutes and try again.'
          : e.message || 'Check-in failed. Please try again.'
      );
    } finally {
      this.busy.set(false);
    }
  }

  async enablePush(): Promise<void> {
    const token = this.entry()?.public_token;
    if (!token) return;
    this.pushBusy.set(true);
    this.pushMsg.set(null);
    try {
      await enableWebPush(this.api, '/api/waitlist/notifications/subscribe', token);
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
}
