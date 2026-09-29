import { Component, inject, signal, OnDestroy, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { canSetStatus, finishOptions, statusLabel, type FinishOption } from '../core/status';
import { CompleteDialogComponent } from '../components/complete-dialog.component';
import type { OrderDetail, OrderSummary } from '../core/models';

const COLUMNS = ['RECEIVED', 'PREPARING', 'PARTIALLY_READY', 'READY'];

function elapsed(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

@Component({
  selector: 'app-kitchen',
  standalone: true,
  imports: [CommonModule, CompleteDialogComponent],
  template: `
    <div class="page-head">
      <div>
        <h2>Kitchen board</h2>
        <p class="muted"><span class="live-dot"></span> live · {{ activeCount() }} active orders</p>
      </div>
    </div>

    <p class="error" *ngIf="error()">{{ error() }}</p>

    <div class="kanban">
      <section class="kanban-col" *ngFor="let col of columns">
        <header class="kanban-head">
          <span class="pill st-{{ col }}">{{ label(col) }}</span>
          <span class="count">{{ byStatus(col).length }}</span>
        </header>
        <div class="kanban-cards">
          <article class="kcard" *ngFor="let o of byStatus(col)">
            <div class="kcard-top">
              <b class="kcard-num">#{{ o.order_number }}</b>
              <span class="muted sm">{{ elapsed(o.created_at) }}</span>
            </div>
            <div class="kcard-cust" *ngIf="o.customer_name">{{ o.customer_name }}</div>
            <button class="btn ghost sm block mt" (click)="toggleItems(o.id)">
              {{ expanded() === o.id ? 'Hide items ▴' : 'Show items (' + (o.item_count ?? 0) + ') ▾' }}
            </button>
            <ul class="kcard-items" *ngIf="expanded() === o.id">
              <li *ngFor="let it of itemsCache()[o.id] ?? []">
                <b>{{ it.quantity }}×</b> {{ it.item_name }}
              </li>
            </ul>
            <div class="kcard-actions">
              <button
                *ngIf="o.order_status === 'RECEIVED' && can('PREPARING')"
                class="btn sm primary block"
                [disabled]="busyId() === o.id"
                (click)="advance(o, 'PREPARING')"
              >
                Start preparing →
              </button>
              <button
                *ngIf="finishOpts(o).length"
                class="btn sm block"
                [class.primary]="o.order_status === 'RECEIVED'"
                [disabled]="busyId() === o.id"
                (click)="openDialog(o)"
              >
                {{ o.order_status === 'RECEIVED' ? 'Update status…' : 'Mark done ✓' }}
              </button>
            </div>
          </article>
          <p class="muted sm" *ngIf="!byStatus(col).length">—</p>
        </div>
      </section>
    </div>

    <app-complete-dialog
      *ngIf="dialogOrder()"
      [orderNumber]="dialogOrder()!.order_number"
      [options]="dialogOptions()"
      [busy]="dialogBusy()"
      [error]="dialogError()"
      (close)="closeDialog()"
      (picked)="onPicked($event)"
    ></app-complete-dialog>
  `,
})
export class KitchenComponent implements OnDestroy {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  columns = COLUMNS;
  orders = signal<OrderSummary[]>([]);
  error = signal<string | null>(null);
  busyId = signal<number | null>(null);
  expanded = signal<number | null>(null);
  itemsCache = signal<Record<number, { quantity: number; item_name: string }[]>>({});

  dialogOrder = signal<OrderSummary | null>(null);
  dialogOptions = signal<FinishOption[]>([]);
  dialogBusy = signal(false);
  dialogError = signal<string | null>(null);

  private es: EventSource | null = null;

  activeCount = computed(() => this.orders().length);
  label = statusLabel;

  constructor() {
    void this.load();
    this.es = this.api.staffEvents(() => void this.load());
  }

  ngOnDestroy(): void {
    this.es?.close();
    this.es = null;
  }

  can = (s: string): boolean => canSetStatus(this.auth.role, s);

  byStatus(s: string): OrderSummary[] {
    return this.orders().filter((o) => o.order_status === s);
  }

  elapsed = elapsed;

  finishOpts(o: OrderSummary): FinishOption[] {
    return finishOptions(o.order_status, this.auth.role);
  }

  private async load(): Promise<void> {
    try {
      const all = await this.api.get<OrderSummary[]>('/api/orders?limit=200');
      this.orders.set(all.filter((o) => COLUMNS.includes(o.order_status)));
    } catch (e: any) {
      this.error.set(e.message || 'Could not load kitchen board');
    }
  }

  async toggleItems(id: number): Promise<void> {
    if (this.expanded() === id) {
      this.expanded.set(null);
      return;
    }
    this.expanded.set(id);
    if (!this.itemsCache()[id]) {
      try {
        const d = await this.api.get<OrderDetail>(`/api/orders/${id}`);
        this.itemsCache.set({ ...this.itemsCache(), [id]: d.items });
      } catch {
        /* keep collapsed content empty */
      }
    }
  }

  async advance(o: OrderSummary, status: string): Promise<void> {
    this.busyId.set(o.id);
    this.error.set(null);
    try {
      await this.api.patch(`/api/orders/${o.id}/status`, { status });
      await this.load();
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.busyId.set(null);
    }
  }

  openDialog(o: OrderSummary): void {
    this.dialogOrder.set(o);
    this.dialogOptions.set(finishOptions(o.order_status, this.auth.role));
    this.dialogError.set(null);
  }

  closeDialog(): void {
    if (this.dialogBusy()) return;
    this.dialogOrder.set(null);
  }

  async onPicked(status: string): Promise<void> {
    const o = this.dialogOrder();
    if (!o) return;
    this.dialogBusy.set(true);
    this.dialogError.set(null);
    try {
      await this.api.patch(`/api/orders/${o.id}/status`, { status });
      this.dialogOrder.set(null);
      await this.load();
    } catch (e: any) {
      this.dialogError.set(e.message);
    } finally {
      this.dialogBusy.set(false);
    }
  }
}
