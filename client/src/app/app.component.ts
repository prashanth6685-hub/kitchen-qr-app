import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterOutlet],
  template: `
    <header class="topbar" *ngIf="showChrome()">
      <a class="brand" routerLink="/">
        <span class="brand-mark">🍳</span>
        <span class="brand-name">Kitchen QR</span>
      </a>
      <nav class="topnav" *ngIf="auth.user() as u">
        <a routerLink="/staff" *ngIf="u.role !== 'KITCHEN_STAFF'">Dashboard</a>
        <a routerLink="/staff/waitlist">Waitlist</a>
        <a routerLink="/staff/new" *ngIf="u.role === 'ADMIN' || u.role === 'COUNTER_STAFF'">New order</a>
        <a routerLink="/kitchen">Kitchen</a>
      </nav>
      <div class="topuser" *ngIf="auth.user() as u">
        <span class="user-chip">{{ u.username }} · {{ u.role.replace('_', ' ') | lowercase }}</span>
        <button class="btn ghost sm" (click)="logout()">Logout</button>
      </div>
    </header>
    <main class="page" [class.bare]="!showChrome()">
      <router-outlet></router-outlet>
    </main>
  `,
})
export class AppComponent {
  auth = inject(AuthService);
  private router = inject(Router);

  /** Hide the staff chrome on the login and customer-facing pages. */
  showChrome(): boolean {
    const p = this.router.url;
    return (
      this.auth.user() !== null &&
      !p.startsWith('/login') &&
      !p.startsWith('/order/') &&
      !p.startsWith('/checkin/') &&
      !p.startsWith('/wait/')
    );
  }

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
