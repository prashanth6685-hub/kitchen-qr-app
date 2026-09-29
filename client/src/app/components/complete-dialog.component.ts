import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { FinishOption } from '../core/status';

/**
 * "Finish order" dialog: offers Partially ready / Completely done /
 * Cancel order (only the options valid for the order's status + staff role
 * are passed in via [options]).
 */
@Component({
  selector: 'app-complete-dialog',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="modal-backdrop" (click)="onBackdrop($event)">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Finish order">
        <div class="modal-head">
          <h3>Finish order #{{ orderNumber }}</h3>
          <button class="icon-btn" (click)="close.emit()" aria-label="Close">✕</button>
        </div>
        <p class="muted">How should this order be closed out?</p>
        <div class="finish-options">
          <button
            *ngFor="let opt of options"
            class="finish-opt"
            [class.danger]="opt.danger"
            [disabled]="busy"
            (click)="picked.emit(opt.status)"
          >
            <span class="finish-emoji">{{ opt.emoji }}</span>
            <span class="finish-text">
              <span class="finish-label">{{ opt.label }}</span>
              <span class="finish-desc">{{ opt.desc }}</span>
            </span>
            <span class="finish-go">→</span>
          </button>
        </div>
        <p class="error" *ngIf="error">{{ error }}</p>
        <div class="modal-foot">
          <button class="btn ghost" (click)="close.emit()" [disabled]="busy">Back</button>
        </div>
      </div>
    </div>
  `,
})
export class CompleteDialogComponent {
  @Input() orderNumber: number | null = null;
  @Input() options: FinishOption[] = [];
  @Input() busy = false;
  @Input() error: string | null = null;
  @Output() close = new EventEmitter<void>();
  @Output() picked = new EventEmitter<string>();

  onBackdrop(e: MouseEvent): void {
    if ((e.target as HTMLElement).classList.contains('modal-backdrop')) this.close.emit();
  }
}
