import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import type { CreatedOrder, MenuItem } from '../core/models';

interface CartLine {
  name: string;
  qty: number;
  unit_price: number; // cents
}

@Component({
  selector: 'app-new-order',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="page-head">
      <div>
        <h2>New order</h2>
        <p class="muted">Add items, take payment, then share the QR code.</p>
      </div>
      <a class="btn ghost" routerLink="/staff">← Orders</a>
    </div>

    <!-- Step 1: build the order -->
    <div class="two-col" *ngIf="!created()">
      <div class="card">
        <h3>Menu</h3>
        <p class="error" *ngIf="error()">{{ error() }}</p>
        <div class="menu-list">
          <div class="menu-row" *ngFor="let m of menu()">
            <div><b>{{ m.name }}</b><div class="muted sm">{{ money(m.price) }}</div></div>
            <button class="btn sm" (click)="addMenu(m)">Add</button>
          </div>
          <p class="muted" *ngIf="!menu().length && !error()">No menu items yet.</p>
        </div>
        <h3 class="mt">Custom item</h3>
        <div class="inline-form">
          <input placeholder="Item name" [(ngModel)]="customName" />
          <input placeholder="$" inputmode="decimal" [(ngModel)]="customPrice" class="w-24" />
          <button class="btn sm" (click)="addCustom()" [disabled]="!customName.trim()">Add</button>
        </div>
      </div>

      <div class="card">
        <h3>Order</h3>
        <div class="cart" *ngIf="cart().length; else emptyCart">
          <div class="cart-row" *ngFor="let l of cart(); let i = index">
            <div class="cart-name">{{ l.name }}<div class="muted sm">{{ money(l.unit_price) }} each</div></div>
            <div class="qty">
              <button class="icon-btn" (click)="dec(i)">−</button>
              <span>{{ l.qty }}</span>
              <button class="icon-btn" (click)="inc(i)">＋</button>
            </div>
            <div class="cart-total">{{ money(l.qty * l.unit_price) }}</div>
          </div>
        </div>
        <ng-template #emptyCart><p class="muted">Cart is empty — add something from the menu.</p></ng-template>

        <div class="cart-grand" *ngIf="cart().length">
          <span>Total</span><b>{{ money(total()) }}</b>
        </div>

        <div class="mt" *ngIf="cart().length">
          <label class="field"><span>Customer name</span><input [(ngModel)]="customerName" placeholder="e.g. Priya" /></label>
          <label class="field"><span>Phone (optional)</span><input [(ngModel)]="customerPhone" inputmode="tel" /></label>
          <label class="field"><span>Notes (optional)</span><textarea [(ngModel)]="notes" rows="2"></textarea></label>
          <button class="btn primary block lg" (click)="submit()" [disabled]="busy()">
            {{ busy() ? 'Creating…' : 'Create order →' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Step 2: payment -->
    <div class="card narrow" *ngIf="created() as c">
      <h3>Order #{{ c.order_number }} created</h3>
      <p class="big-total">{{ money(c.total_cents) }}</p>
      <div *ngIf="!paid()">
        <p class="muted">Take payment to activate the customer QR code.</p>
        <p class="error" *ngIf="error()">{{ error() }}</p>
        <div class="btn-row">
          <button class="btn primary" (click)="pay('cash')" [disabled]="busy()">💵 Cash</button>
          <button class="btn" *ngIf="c.demo_payments" (click)="pay('demo')" [disabled]="busy()">🧪 Demo card</button>
        </div>
        <a class="btn block mt" *ngIf="c.checkout_url" [href]="c.checkout_url" target="_blank" rel="noopener">
          💳 Pay by card (Stripe)
        </a>
        <p class="muted sm mt" *ngIf="c.demo_payments">Demo payments are for testing only.</p>
      </div>

      <!-- Step 3: QR code -->
      <div *ngIf="paid()">
        <div class="ok">✅ Payment confirmed — QR code is active.</div>
        <div class="qr-wrap">
          <img [src]="qrSrc()" alt="Order QR code" class="qr-img" />
        </div>
        <div class="btn-row">
          <a class="btn" [href]="qrSrc()" [download]="'order-' + c.order_number + '-qr.png'">⬇ Download</a>
          <button class="btn ghost" (click)="copyLink(c)">Copy tracking link</button>
        </div>
        <p class="muted sm mt" *ngIf="copied()">Link copied ✓</p>
        <a class="btn primary block mt" [routerLink]="['/staff/orders', orderId()]">Open order →</a>
      </div>
    </div>
  `,
})
export class NewOrderComponent {
  private api = inject(ApiService);
  private router = inject(Router);
  auth = inject(AuthService);

  menu = signal<MenuItem[]>([]);
  cart = signal<CartLine[]>([]);
  customName = '';
  customPrice = '';
  customerName = '';
  customerPhone = '';
  notes = '';
  busy = signal(false);
  error = signal<string | null>(null);
  created = signal<CreatedOrder | null>(null);
  orderId = signal<number | null>(null);
  paid = signal(false);
  copied = signal(false);

  total = computed(() => this.cart().reduce((s, l) => s + l.qty * l.unit_price, 0));
  qrSrc = computed(() => (this.orderId() ? this.api.qrUrl(this.orderId()!) : ''));

  constructor() {
    void this.loadMenu();
  }

  money(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  private async loadMenu(): Promise<void> {
    try {
      this.menu.set(await this.api.get<MenuItem[]>('/api/menu'));
    } catch (e: any) {
      this.error.set(e.message);
    }
  }

  addMenu(m: MenuItem): void {
    this.addLine({ name: m.name, qty: 1, unit_price: m.price });
  }

  addCustom(): void {
    const name = this.customName.trim();
    const price = Math.round(parseFloat(this.customPrice) * 100);
    if (!name || !Number.isFinite(price) || price < 0) return;
    this.addLine({ name, qty: 1, unit_price: price });
    this.customName = '';
    this.customPrice = '';
  }

  private addLine(line: CartLine): void {
    const cart = [...this.cart()];
    const ix = cart.findIndex((l) => l.name === line.name && l.unit_price === line.unit_price);
    if (ix >= 0) cart[ix] = { ...cart[ix], qty: Math.min(99, cart[ix].qty + line.qty) };
    else cart.push(line);
    this.cart.set(cart);
  }

  inc(i: number): void {
    const cart = [...this.cart()];
    cart[i] = { ...cart[i], qty: Math.min(99, cart[i].qty + 1) };
    this.cart.set(cart);
  }

  dec(i: number): void {
    const cart = [...this.cart()];
    cart[i].qty -= 1;
    this.cart.set(cart.filter((l) => l.qty > 0));
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const c = await this.api.post<CreatedOrder>('/api/orders', {
        customer_name: this.customerName.trim() || undefined,
        customer_phone: this.customerPhone.trim() || undefined,
        special_instructions: this.notes.trim() || undefined,
        items: this.cart().map((l) => ({ name: l.name, qty: l.qty, unit_price: l.unit_price })),
      });
      this.created.set(c);
      this.orderId.set(c.id);
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }

  async pay(kind: 'cash' | 'demo'): Promise<void> {
    const id = this.orderId();
    if (!id) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.post(`/api/orders/${id}/payments/${kind}`, {});
      this.paid.set(true);
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }

  copyLink(c: CreatedOrder): void {
    const url = `${location.origin}/order/${c.public_token}`;
    navigator.clipboard?.writeText(url).then(
      () => this.copied.set(true),
      () => this.copied.set(false)
    );
  }
}
