import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { AuthService } from './core/auth.service';
import { HomeComponent } from './pages/home.component';
import { LoginComponent } from './pages/login.component';
import { DashboardComponent } from './pages/dashboard.component';
import { NewOrderComponent } from './pages/new-order.component';
import { KitchenComponent } from './pages/kitchen.component';
import { OrderDetailComponent } from './pages/order-detail.component';
import { TrackingComponent } from './pages/tracking.component';

const staffGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.user() ? true : router.createUrlTree(['/login']);
};

const counterGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const u = auth.user();
  if (!u) return router.createUrlTree(['/login']);
  return u.role === 'ADMIN' || u.role === 'COUNTER_STAFF'
    ? true
    : router.createUrlTree(['/staff']);
};

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'login', component: LoginComponent },
  { path: 'order/:token', component: TrackingComponent },
  { path: 'staff', component: DashboardComponent, canActivate: [staffGuard] },
  { path: 'staff/new', component: NewOrderComponent, canActivate: [counterGuard] },
  { path: 'staff/orders/:id', component: OrderDetailComponent, canActivate: [staffGuard] },
  { path: 'kitchen', component: KitchenComponent, canActivate: [staffGuard] },
  { path: '**', redirectTo: '' },
];
