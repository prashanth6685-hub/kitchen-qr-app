import { Component, inject, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import type { WaitlistAdminEntry, WaitlistAdminLocation, WaitlistLocation, WaitlistSummary } from '../core/models';

function waitedLabel(iso: string): string {
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

@Component({
  selector: 'app-waitlist-admin',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="page-head">
      <div>
        <h2>Waiting list</h2>
        <p class="muted">Live queue management <span class="live-dot"></span></p>
      </div>
      <label class="field" style="min-width:220px;margin:0" *ngIf="locations().length > 1">
        <span>Location</span>
        <select [ngModel]="locationId()" (ngModelChange)="pickLocation($event)">
          <option *ngFor="let l of locations()" [value]="l.id">
            {{ l.restaurant_name }} · {{ l.name }} ({{ l.active_count }})
          </option>
        </select>
      </label>
    </div>

    <p class="error" *ngIf="error()">{{ error() }}</p>
    <p class="muted" *ngIf="!summary() && !error()">Loading waiting list…</p>

    <ng-container *ngIf="summary() as s">
      <!-- Now serving / next up -->
      <div class="stat-row">
        <div class="stat">
          <span class="stat-lbl">Now serving</span>
          <span class="stat-num">{{ s.now_serving ?? '—' }}</span>
        </div>
        <div class="stat">
          <span class="stat-lbl">Next up</span>
          <span class="stat-num sm" style="font-size:1.1rem">{{ s.next_up.join(', ') || '—' }}</span>
        </div>
        <div class="stat">
          <span class="stat-lbl">Waiting</span>
          <span class="stat-num">{{ s.counts['WAITING'] ?? 0 }}</span>
        </div>
      </div>

      <div class="btn-row mb">
        <button class="btn primary lg" (click)="callNext()" [disabled]="!canMutate() || busy()">
          {{ busy() ? 'Calling…' : '📢 CALL NEXT' }}
        </button>
        <button class="btn lg" (click)="openPicker()" [disabled]="!canMutate() || !waitingEntries().length">
          👆 SELECT GUEST
        </button>
      </div>

      <!-- Serving now -->
      <div class="card" *ngIf="calledEntries().length">
        <h3>Now serving</h3>
        <div class="wl-rows">
          <div class="wl-row" *ngFor="let e of calledEntries()">
            <div class="wl-main">
              <b class="wl-qn">{{ e.queue_number }}</b>
              <span class="wl-name">{{ e.customer_name }}</span>
              <span class="muted sm">{{ e.party_size }} guests · waiting {{ waitedLabel(e.check_in_time) }}</span>
              <span class="pill st-CALLED" *ngIf="e.recall_count">recalled ×{{ e.recall_count }}</span>
            </div>
            <div class="wl-actions">
              <button class="btn sm primary" *ngIf="canMutate()" [disabled]="busyId() === e.id" (click)="mutate(e, 'seated')">Seated ✓</button>
              <button class="btn sm" *ngIf="canMutate()" [disabled]="busyId() === e.id" (click)="mutate(e, 'recall')">Recall</button>
              <button class="btn sm ghost" *ngIf="canMutate()" [disabled]="busyId() === e.id" (click)="mutate(e, 'skip')">Skip</button>
              <button class="btn sm ghost" *ngIf="canMutate()" [disabled]="busyId() === e.id" (click)="mutate(e, 'no-show')">No show</button>
              <button class="btn sm danger" *ngIf="canMutate()" [disabled]="busyId() === e.id" (click)="mutate(e, 'cancel')">Cancel</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Waiting queue -->
      <div class="card">
        <h3>Waiting ({{ waitingEntries().length }})</h3>
        <div class="wl-rows" *ngIf="waitingEntries().length; else emptyTpl">
          <div class="wl-row" *ngFor="let e of waitingEntries()">
            <div class="wl-main">
              <b class="wl-qn">{{ e.queue_number }}</b>
              <span class="wl-name">{{ e.customer_name }}</span>
              <span class="muted sm">{{ e.party_size }} guests · waiting {{ waitedLabel(e.check_in_time) }}</span>
              <span class="pill" *ngIf="e.status === 'ALMOST_READY'">almost ready</span>
              <span class="muted sm" *ngIf="e.special_requirements">📝 {{ e.special_requirements }}</span>
            </div>
            <div class="wl-actions">
              <button class="btn sm" *ngIf="canMutate() && e.status === 'WAITING'" [disabled]="busyId() === e.id" (click)="mutate(e, 'almost-ready')">Almost ready</button>
              <button class="btn sm primary" *ngIf="canMutate()" [disabled]="busyId() === e.id" (click)="mutate(e, 'call')">Call</button>
              <button class="btn sm ghost" *ngIf="canMutate() && e.status === 'ALMOST_READY'" [disabled]="busyId() === e.id" (click)="mutate(e, 'skip')">Skip</button>
              <button class="btn sm ghost" *ngIf="canMutate()" [disabled]="busyId() === e.id" (click)="mutate(e, 'no-show')">No show</button>
              <button class="btn sm danger" *ngIf="canMutate()" [disabled]="busyId() === e.id" (click)="mutate(e, 'cancel')">Cancel</button>
            </div>
          </div>
        </div>
        <ng-template #emptyTpl><p class="muted">No one waiting right now.</p></ng-template>
      </div>

      <!-- Skipped -->
      <div class="card" *ngIf="skippedEntries().length">
        <h3>Skipped</h3>
        <div class="wl-rows">
          <div class="wl-row" *ngFor="let e of skippedEntries()">
            <div class="wl-main">
              <b class="wl-qn">{{ e.queue_number }}</b>
              <span class="wl-name">{{ e.customer_name }}</span>
              <span class="muted sm">{{ e.party_size }} guests</span>
            </div>
            <div class="wl-actions">
              <button class="btn sm" *ngIf="canMutate()" [disabled]="busyId() === e.id" (click)="mutate(e, 'restore')">Move back to waiting</button>
              <button class="btn sm primary" *ngIf="canMutate()" [disabled]="busyId() === e.id" (click)="mutate(e, 'call')">Call</button>
              <button class="btn sm ghost" *ngIf="canMutate()" [disabled]="busyId() === e.id" (click)="mutate(e, 'no-show')">No show</button>
              <button class="btn sm danger" *ngIf="canMutate()" [disabled]="busyId() === e.id" (click)="mutate(e, 'cancel')">Cancel</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Restaurant check-in QR -->
      <div class="card" *ngIf="locationSlug()">
        <h3>Restaurant check-in QR</h3>
        <p class="muted sm">Print and display at the entrance — customers scan to join the waiting list.</p>
        <div class="qr-wrap">
          <img class="qr-img" [src]="restaurantQrUrl()" alt="Restaurant check-in QR code" />
        </div>
        <p class="muted sm" style="text-align:center;word-break:break-all">{{ checkinUrl() }}</p>
      </div>
    </ng-container>

    <!-- Select guest modal -->
    <div class="modal-backdrop" *ngIf="pickerOpen()">
      <div class="modal">
        <div class="modal-head">
          <h3>Select guest to call</h3>
          <button class="icon-btn" (click)="closePicker()">✕</button>
        </div>
        <div class="finish-options">
          <button
            *ngFor="let e of waitingEntries()"
            class="finish-opt"
            [class.selected]="selectedId() === e.id"
            (click)="selectedId.set(e.id)"
          >
            <span class="finish-emoji">🧍</span>
            <span class="finish-text">
              <span class="finish-label">{{ e.queue_number }} — {{ e.customer_name }}</span>
              <span class="finish-desc">{{ e.party_size }} guests · waiting {{ waitedLabel(e.check_in_time) }}</span>
            </span>
            <span class="finish-go">{{ selectedId() === e.id ? '●' : '○' }}</span>
          </button>
        </div>
        <p class="error" *ngIf="pickerError()">{{ pickerError() }}</p>
        <div class="btn-row">
          <button class="btn primary block" [disabled]="!selectedId() || busy()" (click)="callSelected()">
            {{ busy() ? 'Calling…' : '📢 CALL SELECTED' }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class WaitlistAdminComponent implements OnDestroy {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  auth = inject(AuthService);

  locations = signal<WaitlistAdminLocation[]>([]);
  locationId = signal<number | null>(null);
  summary = signal<WaitlistSummary | null>(null);
  error = signal<string | null>(null);
  busy = signal(false);
  busyId = signal<number | null>(null);
  private publicLocation = signal<WaitlistLocation | null>(null);

  pickerOpen = signal(false);
  selectedId = signal<number | null>(null);
  pickerError = signal<string | null>(null);

  private es: EventSource | null = null;

  waitedLabel = waitedLabel;

  constructor() {
    void this.init();
  }

  ngOnDestroy(): void {
    this.closeStream();
  }

  canMutate(): boolean {
    const r = this.auth.role;
    return r === 'ADMIN' || r === 'COUNTER_STAFF';
  }

  calledEntries(): WaitlistAdminEntry[] {
    return this.summary()?.entries.filter((e) => e.status === 'CALLED') ?? [];
  }

  waitingEntries(): WaitlistAdminEntry[] {
    return this.summary()?.entries.filter((e) => e.status === 'WAITING' || e.status === 'ALMOST_READY') ?? [];
  }

  skippedEntries(): WaitlistAdminEntry[] {
    return this.summary()?.entries.filter((e) => e.status === 'SKIPPED') ?? [];
  }

  locationSlug(): string {
    return this.locations().find((l) => l.id === this.locationId())?.slug ?? '';
  }

  restaurantQrUrl(): string {
    return `/api/waitlist/location/${encodeURIComponent(this.locationSlug())}/qr.png`;
  }

  checkinUrl(): string {
    return this.publicLocation()?.checkin_url ?? '';
  }

  pickLocation(id: number): void {
    this.locationId.set(Number(id));
    this.summary.set(null);
    void this.refresh();
    this.openStream();
  }

  private async init(): Promise<void> {
    try {
      const locs = await this.api.get<WaitlistAdminLocation[]>('/api/waitlist/admin/locations');
      this.locations.set(locs);
      const q = Number(this.route.snapshot.queryParamMap.get('location_id'));
      const first = locs.find((l) => l.id === q) ?? locs[0];
      if (!first) {
        this.error.set('No restaurant locations found for your organization.');
        return;
      }
      this.locationId.set(first.id);
      await this.refresh();
      this.openStream();
    } catch (e: any) {
      this.error.set(e.message || 'Could not load the waiting list.');
    }
  }

  private async refresh(): Promise<void> {
    const id = this.locationId();
    if (!id) return;
    try {
      const [s, pub] = await Promise.all([
        this.api.get<WaitlistSummary>(`/api/waitlist/admin/summary?location_id=${id}`),
        this.api
          .get<WaitlistLocation>(`/api/waitlist/location/${encodeURIComponent(this.locationSlug())}`)
          .catch(() => null),
      ]);
      this.summary.set(s);
      this.publicLocation.set(pub);
      this.error.set(null);
    } catch (e: any) {
      this.error.set(e.message || 'Could not load the waiting list.');
    }
  }

  private openStream(): void {
    this.closeStream();
    const id = this.locationId();
    if (!id) return;
    this.es = this.api.waitlistStaffEvents(id, () => void this.refresh());
  }

  private closeStream(): void {
    this.es?.close();
    this.es = null;
  }

  async callNext(): Promise<void> {
    const id = this.locationId();
    if (!id || !this.canMutate()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.post('/api/waitlist/admin/call-next', { location_id: id });
      await this.refresh();
    } catch (e: any) {
      this.error.set(e.message || 'Could not call the next guest.');
    } finally {
      this.busy.set(false);
    }
  }

  openPicker(): void {
    this.selectedId.set(null);
    this.pickerError.set(null);
    this.pickerOpen.set(true);
  }

  closePicker(): void {
    this.pickerOpen.set(false);
  }

  async callSelected(): Promise<void> {
    const id = this.selectedId();
    if (!id || !this.canMutate()) return;
    this.busy.set(true);
    this.pickerError.set(null);
    try {
      await this.api.post(`/api/waitlist/${id}/call`, {});
      this.closePicker();
      await this.refresh();
    } catch (e: any) {
      this.pickerError.set(e.message || 'Could not call this guest.');
    } finally {
      this.busy.set(false);
    }
  }

  async mutate(e: WaitlistAdminEntry, action: string): Promise<void> {
    if (!this.canMutate()) return;
    if (action === 'cancel' && !confirm(`Cancel ${e.queue_number} (${e.customer_name})?`)) return;
    this.busyId.set(e.id);
    this.error.set(null);
    try {
      await this.api.post(`/api/waitlist/${e.id}/${action}`, {});
      await this.refresh();
    } catch (e2: any) {
      this.error.set(e2.message || 'Action failed.');
    } finally {
      this.busyId.set(null);
    }
  }
}
