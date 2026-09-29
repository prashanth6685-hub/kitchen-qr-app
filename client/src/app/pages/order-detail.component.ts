import { Component, inject, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { canSetStatus, finishOptions, statusLabel, type FinishOption } from '../core/status';
import { CompleteDialogComponent } from '../components/complete-dialog.component';
import type { OrderDetail } from '../core/models';

@Component({
  selector: 'app-order-detail',
  standalone: true,
  imports: [CommonModule, RouterLink, CompleteDialogComponent],
  template: `
    <div *ngIf="order() as o; else loading">
      <div class="page-head">
        <div>
          <h2>Order #{{ o.order_number }}</h2>
          <p class="muted">
            <span class="pill st-{{ o.order_status }}">{{ label(o.order_status) }}</span>
            <span class="pill pay-{{ o.payment_status }}">{{ o.payment_status }}</span>
          </p>
        </div>
        <a class="btn ghost" routerLink="/staff">← Orders</a>
      </div>

      <p class="error" *ngIf="error()">{{ error() }}</p>

      <div class="two-col">
        <div class="card">
          <h3>Items</h3>
          <table class="table">
            <thead><tr><th>Item</th><th>Qty</th><th class="r">Price</th></tr></thead>
            <tbody>
              <tr *ngFor="let it of o.items">
                <td>{{ it.item_name }}</td>
                <td>{{ it.quantity }}</td>
                <td class="r">{{ money(it.total_price_cents) }}</td>
              </tr>
            </tbody>
          </table>
          <div class="cart-grand"><span>Total</span><b>{{ money(o.total_cents) }}</b></div>
          <dl class="kv mt">
            <div *ngIf="o.customer_name"><dt>Customer</dt><dd>{{ o.customer_name }}</dd></div>
            <div *ngIf="o.customer_phone"><dt>Phone</dt><dd>{{ o.customer_phone }}</dd></div>
            <div *ngIf="o.special_instructions"><dt>Notes</dt><dd>{{ o.special_instructions }}</dd></div>
            <div><dt>Placed</dt><dd>{{ o.created_at | date: 'medium' }}</dd></div>
          </dl>
        </div>

        <div>
          <!-- Payment -->
          <div class="card" *ngIf="o.payment_status !== 'PAID'">
            <h3>Payment</h3>
            <p class="muted">Payment must be confirmed before the QR code activates.</p>
            <div class="btn-row">
              <button class="btn primary" (click)="pay('cash')" [disabled]="busy()">💵 Cash</button>
              <button class="btn" (click)="pay('demo')" [disabled]="busy()">🧪 Demo card</button>
              <button class="btn" (click)="payStripe()" [disabled]="busy()">💳 Card (Stripe)</button>
            </div>
            <p class="muted sm mt">Demo payments are for testing only.</p>
          </div>

          <!-- QR -->
          <div class="card" *ngIf="o.payment_status === 'PAID'">
            <h3>Customer QR code</h3>
            <div class="qr-wrap"><img [src]="qrSrc()" alt="Order QR code" class="qr-img" /></div>
            <div class="btn-row">
              <a class="btn sm" [href]="qrSrc()" [download]="'order-' + o.order_number + '-qr.png'">⬇ Download</a>
              <button class="btn sm ghost" (click)="copyLink(o)">Copy tracking link</button>
            </div>
            <p class="muted sm mt" *ngIf="copied()">Link copied ✓</p>
          </div>

          <!-- Status -->
          <div class="card">
            <h3>Status</h3>
            <div class="btn-row">
              <button
                *ngIf="nextStep() as ns"
                class="btn sm"
                [disabled]="busy()"
                (click)="setStatus(ns)"
              >
                {{ nextLabel(ns) }}
              </button>
              <button
                *ngIf="finishOpts().length"
                class="btn sm primary"
                [disabled]="busy()"
                (click)="openDialog()"
              >
                Mark done ✓
              </button>
            </div>
            <h4 class="mt">History</h4>
            <ol class="history">
              <li *ngFor="let h of o.history">
                <span class="pill st-{{ h.new_status }} sm">{{ label(h.new_status) }}</span>
                <span class="muted sm">{{ h.changed_by }} · {{ h.changed_at | date: 'short' }}</span>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </div>

    <ng-template #loading><p class="muted">Loading order…</p></ng-template>

    <app-complete-dialog
      *ngIf="order() && dialogOpen()"
      [orderNumber]="order()!.order_number"
      [options]="finishOpts()"
      [busy]="busy()"
      [error]="dialogError()"
      (close)="dialogOpen.set(false)"
      (picked)="onPicked($event)"
    ></app-complete-dialog>
  `,
})
export class OrderDetailComponent implements OnDestroy {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);

  order = signal<OrderDetail | null>(null);
  error = signal<string | null>(null);
  busy = signal(false);
  dialogOpen = signal(false);
  dialogError = signal<string | null>(null);
  copied = signal(false);

  private es: EventSource | null = null;
  label = statusLabel;

  constructor() {
    const id = this.route.snapshot.paramMap.get('id')!;
    void this.load(id);
    // Keep the page fresh while kitchen updates the order elsewhere.
    this.es = this.api.staffEvents((msg) => {
      if (msg && (msg.id === Number(id) || msg.order?.id === Number(id))) void this.load(id, true);
    });
  }

  ngOnDestroy(): void {
    this.es?.close();
    this.es = null;
  }

  money(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  qrSrc(): string {
    const o = this.order();
    return o ? this.api.qrUrl(o.id) : '';
  }

  /** The single natural next step in the pipeline (besides the finish dialog). */
  nextStep(): string | null {
    const o = this.order();
    if (!o) return null;
    const role = this.auth.role;
    const step: Record<string, string> = {
      PAID: 'RECEIVED',
      RECEIVED: 'PREPARING',
      PARTIALLY_READY: 'READY',
    };
    const ns = step[o.order_status];
    return ns && canSetStatus(role, ns) ? ns : null;
  }

  nextLabel(s: string): string {
    return { RECEIVED: 'Mark received →', PREPARING: 'Start preparing →', READY: 'Mark fully ready →' }[s] ?? s;
  }

  finishOpts(): FinishOption[] {
    const o = this.order();
    return o ? finishOptions(o.order_status, this.auth.role) : [];
  }

  private async load(id: string, silent = false): Promise<void> {
    if (!silent) this.error.set(null);
    try {
      const o = await this.api.get<OrderDetail>(`/api/orders/${id}`);
      this.order.set(o);
    } catch (e: any) {
      this.error.set(e.message || 'Could not load order');
    }
  }

  async setStatus(status: string): Promise<void> {
    const o = this.order();
    if (!o) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.patch(`/api/orders/${o.id}/status`, { status });
      await this.load(String(o.id), true);
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }

  openDialog(): void {
    this.dialogError.set(null);
    this.dialogOpen.set(true);
  }

  async onPicked(status: string): Promise<void> {
    const o = this.order();
    if (!o) return;
    this.busy.set(true);
    this.dialogError.set(null);
    try {
      await this.api.patch(`/api/orders/${o.id}/status`, { status });
      this.dialogOpen.set(false);
      await this.load(String(o.id), true);
    } catch (e: any) {
      this.dialogError.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }

  async pay(kind: 'cash' | 'demo'): Promise<void> {
    const o = this.order();
    if (!o) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.post(`/api/orders/${o.id}/payments/${kind}`, {});
      await this.load(String(o.id), true);
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }

  async payStripe(): Promise<void> {
    const o = this.order();
    if (!o) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await this.api.post<{ checkout_url: string }>(`/api/orders/${o.id}/payments/stripe`, {});
      window.open(r.checkout_url, '_blank', 'noopener');
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }

  copyLink(o: OrderDetail): void {
    const url = `${location.origin}/order/${o.public_token}`;
    navigator.clipboard?.writeText(url).then(
      () => this.copied.set(true),
      () => this.copied.set(false)
    );
  }
}
