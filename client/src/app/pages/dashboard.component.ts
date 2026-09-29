import {
  Component,
  ElementRef,
  ViewChild,
  inject,
  signal,
  AfterViewInit,
  OnDestroy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { Grid, html } from 'gridjs';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { statusLabel } from '../core/status';
import type { OrderSummary as OS } from '../core/models';

const FILTERS = [
  'ALL',
  'PENDING_PAYMENT',
  'PAID',
  'RECEIVED',
  'PREPARING',
  'PARTIALLY_READY',
  'READY',
  'COMPLETED',
  'CANCELLED',
];

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="page-head">
      <div>
        <h2>Orders</h2>
        <p class="muted">{{ total() }} orders · updates live</p>
      </div>
      <a
        class="btn primary"
        routerLink="/staff/new"
        *ngIf="auth.role === 'ADMIN' || auth.role === 'COUNTER_STAFF'"
        >＋ New order</a
      >
    </div>

    <div class="stat-row">
      <div class="stat"><span class="stat-num">{{ stats().active }}</span><span class="stat-lbl">In kitchen</span></div>
      <div class="stat"><span class="stat-num">{{ stats().unpaid }}</span><span class="stat-lbl">Awaiting payment</span></div>
      <div class="stat"><span class="stat-num">{{ stats().ready }}</span><span class="stat-lbl">Ready / partial</span></div>
    </div>

    <div class="chips">
      <button
        *ngFor="let f of filters"
        class="chip"
        [class.on]="filter() === f"
        (click)="setFilter(f)"
      >
        {{ f === 'ALL' ? 'All' : label(f) }}
      </button>
    </div>

    <p class="error" *ngIf="error()">{{ error() }}</p>

    <div class="grid-card">
      <div #gridEl></div>
    </div>
  `,
})
export class DashboardComponent implements AfterViewInit, OnDestroy {
  private api = inject(ApiService);
  private router = inject(Router);
  auth = inject(AuthService);

  @ViewChild('gridEl', { static: false }) gridEl!: ElementRef<HTMLDivElement>;

  filters = FILTERS;
  filter = signal('ALL');
  total = signal(0);
  error = signal<string | null>(null);
  stats = signal({ active: 0, unpaid: 0, ready: 0 });

  private grid: Grid | null = null;
  private es: EventSource | null = null;
  private clickHandler = (e: Event): void => {
    const btn = (e.target as HTMLElement).closest?.('[data-open]');
    if (btn) this.router.navigate(['/staff/orders', btn.getAttribute('data-open')]);
  };

  label = statusLabel;

  ngAfterViewInit(): void {
    this.grid = new Grid({
      columns: [
        {
          name: 'Order',
          formatter: (cell: number) => html(`<b>#${cell}</b>`),
        },
        {
          name: 'Customer',
          formatter: (cell: string | null) => html(esc(cell) || '<span class="muted">—</span>'),
        },
        { name: 'Items', width: '70px' },
        {
          name: 'Total',
          formatter: (cell: number) => html(money(cell)),
        },
        {
          name: 'Payment',
          formatter: (cell: string) =>
            html(`<span class="pill pay-${cell}">${esc(cell)}</span>`),
        },
        {
          name: 'Status',
          formatter: (cell: string) =>
            html(`<span class="pill st-${cell}">${esc(statusLabel(cell))}</span>`),
        },
        {
          name: 'Updated',
          formatter: (cell: string) => html(`<span class="muted">${esc(timeAgo(cell))}</span>`),
        },
        {
          name: '',
          sort: false,
          formatter: (cell: number) =>
            html(`<button class="btn ghost sm" data-open="${cell}">Open →</button>`),
        },
      ],
      data: [],
      search: true,
      sort: true,
      pagination: { limit: 12 },
      className: { table: 'kqr-grid' },
      language: { search: { placeholder: '🔍 Search orders…' }, noRecordsFound: 'No orders found.' },
    }).render(this.gridEl.nativeElement);

    this.gridEl.nativeElement.addEventListener('click', this.clickHandler);
    void this.load();
    this.es = this.api.staffEvents(() => void this.load(true));
  }

  ngOnDestroy(): void {
    this.es?.close();
    this.es = null;
    if (this.gridEl) this.gridEl.nativeElement.removeEventListener('click', this.clickHandler);
  }

  setFilter(f: string): void {
    this.filter.set(f);
    void this.load();
  }

  private async load(silent = false): Promise<void> {
    if (!silent) this.error.set(null);
    try {
      const f = this.filter();
      const q = f === 'ALL' ? '' : `?status=${encodeURIComponent(f)}`;
      const rows = await this.api.get<OS[]>(`/api/orders${q}`);
      this.total.set(rows.length);
      const active = rows.filter((r) =>
        ['RECEIVED', 'PREPARING', 'PARTIALLY_READY'].includes(r.order_status)
      ).length;
      const unpaid = rows.filter((r) => r.payment_status !== 'PAID').length;
      const ready = rows.filter((r) => ['READY', 'PARTIALLY_READY'].includes(r.order_status)).length;
      this.stats.set({ active, unpaid, ready });
      this.grid
        ?.updateConfig({
          data: rows.map((r) => [
            r.order_number,
            r.customer_name,
            r.item_count ?? 0,
            r.total_cents,
            r.payment_status,
            r.order_status,
            r.created_at,
            r.id,
          ]),
        })
        .forceRender();
    } catch (e: any) {
      this.error.set(e.message || 'Could not load orders');
    }
  }
}
