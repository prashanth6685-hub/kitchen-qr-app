import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="auth-wrap">
      <form class="auth-card" (ngSubmit)="submit()" #f="ngForm">
        <div class="auth-mark">🍳</div>
        <h2>Kitchen QR</h2>
        <p class="muted">Sign in with your staff account.</p>
        <label class="field">
          <span>Username</span>
          <input name="username" [(ngModel)]="username" required autocomplete="username" autofocus />
        </label>
        <label class="field">
          <span>Password</span>
          <input name="password" type="password" [(ngModel)]="password" required autocomplete="current-password" />
        </label>
        <p class="error" *ngIf="error()">{{ error() }}</p>
        <button class="btn primary block" type="submit" [disabled]="busy() || !f.valid">
          {{ busy() ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </div>
  `,
})
export class LoginComponent {
  private auth = inject(AuthService);
  private router = inject(Router);

  username = '';
  password = '';
  busy = signal(false);
  error = signal<string | null>(null);

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.login(this.username.trim(), this.password);
      const role = this.auth.role;
      this.router.navigate([role === 'KITCHEN_STAFF' ? '/kitchen' : '/staff']);
    } catch (e: any) {
      this.error.set(e.message || 'Login failed');
    } finally {
      this.busy.set(false);
    }
  }
}
