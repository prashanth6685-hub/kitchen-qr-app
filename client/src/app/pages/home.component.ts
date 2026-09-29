import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="hero">
      <div class="hero-card">
        <div class="hero-mark">🍳</div>
        <h1>Kitchen QR</h1>
        <p class="muted">
          Counter ordering with live kitchen tracking. Customers scan a QR code —
          no app to install, no account needed.
        </p>
        <div class="hero-actions">
          <a *ngIf="!auth.user()" class="btn primary lg" routerLink="/login">Staff login →</a>
          <a *ngIf="auth.user()" class="btn primary lg" [routerLink]="homeFor(auth.role)">Open {{ homeLabel() }} →</a>
          <a *ngIf="auth.user()" class="btn lg" routerLink="/staff/waitlist" style="margin-left:0.6rem">🪑 Waitlist</a>
        </div>
        <div class="hero-steps">
          <div class="hero-step"><span>🧾</span><b>Counter</b> creates the order & takes payment</div>
          <div class="hero-step"><span>📱</span><b>Customer</b> scans the QR to track it live</div>
          <div class="hero-step"><span>👨‍🍳</span><b>Kitchen</b> updates status in real time</div>
        </div>
      </div>
    </div>
  `,
})
export class HomeComponent {
  auth = inject(AuthService);
  private router = inject(Router);

  constructor() {
    // Logged-in staff land straight on their workspace.
    const u = this.auth.user();
    if (u) this.router.navigate([this.homeFor(u.role)]);
  }

  homeFor(role: string): string {
    return role === 'KITCHEN_STAFF' ? '/kitchen' : '/staff';
  }

  homeLabel(): string {
    return this.auth.role === 'KITCHEN_STAFF' ? 'kitchen board' : 'dashboard';
  }
}
