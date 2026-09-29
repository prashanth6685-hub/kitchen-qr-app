// Order-status helpers: labels, pill colors, and the "finish order" dialog options.
// Mirrors the backend rules in server/src/orders.ts (TRANSITIONS) and auth.ts.

export const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid',
  RECEIVED: 'Received',
  PREPARING: 'Preparing',
  PARTIALLY_READY: 'Partially ready',
  READY: 'Ready',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export function statusLabel(s: string): string {
  return STATUS_LABELS[s] ?? s;
}

/** Frontend mirror of the backend canSetStatus() — the API still enforces it. */
export function canSetStatus(role: string, status: string): boolean {
  if (role === 'ADMIN') return true;
  if (role === 'KITCHEN_STAFF') {
    return ['RECEIVED', 'PREPARING', 'PARTIALLY_READY', 'READY', 'COMPLETED'].includes(status);
  }
  if (role === 'COUNTER_STAFF') {
    return ['PAID', 'RECEIVED', 'PARTIALLY_READY', 'CANCELLED', 'COMPLETED'].includes(status);
  }
  return false;
}

export interface FinishOption {
  status: string;
  label: string;
  desc: string;
  emoji: string;
  danger?: boolean;
}

/**
 * The 2–3 choices shown when staff tap "Mark done" on an order.
 * Only transitions that are valid from the current status — and allowed for
 * the staff member's role — are offered.
 */
export function finishOptions(currentStatus: string, role: string): FinishOption[] {
  const opts: FinishOption[] = [];
  const terminal = currentStatus === 'COMPLETED' || currentStatus === 'CANCELLED';
  if (!terminal && (currentStatus === 'PREPARING' || currentStatus === 'PARTIALLY_READY')) {
    if (currentStatus === 'PREPARING' && canSetStatus(role, 'PARTIALLY_READY')) {
      opts.push({
        status: 'PARTIALLY_READY',
        label: 'Partially ready',
        desc: 'Some items are ready now — the rest are still cooking',
        emoji: '⏳',
      });
    }
    if (currentStatus === 'PARTIALLY_READY' && canSetStatus(role, 'READY')) {
      opts.push({
        status: 'READY',
        label: 'Fully ready',
        desc: 'Everything is ready for pickup',
        emoji: '🎉',
      });
    }
    if (canSetStatus(role, 'COMPLETED')) {
      opts.push({
        status: 'COMPLETED',
        label: 'Completely done',
        desc: 'Order finished and handed over',
        emoji: '✅',
      });
    }
  } else if (!terminal && currentStatus === 'READY' && canSetStatus(role, 'COMPLETED')) {
    opts.push({
      status: 'COMPLETED',
      label: 'Completely done',
      desc: 'Order finished and handed over',
      emoji: '✅',
    });
  }
  if (!terminal && canSetStatus(role, 'CANCELLED')) {
    opts.push({
      status: 'CANCELLED',
      label: 'Cancel order',
      desc: 'Cancel the whole order',
      emoji: '🚫',
      danger: true,
    });
  }
  return opts;
}

/** Timeline steps shown on the customer tracking page. */
export const TRACKING_STEPS = ['RECEIVED', 'PREPARING', 'PARTIALLY_READY', 'READY', 'COMPLETED'];
