/** Shared types for the restaurant check-in / digital waiting-list module (MODULE 2). */

export interface WaitlistEntryData {
  public_token: string;
  queue_number: string;
  queue_seq: number;
  customer_name: string;
  party_size: number;
  status: string;
  position: number;
  parties_ahead: number;
  currently_serving: string | null;
  estimated_wait_min: number;
  estimated_wait_label: string;
  tracking_url: string;
  restaurant_name: string;
  location_name: string;
  check_in_time: string;
  customer_phone?: string | null;
  special_requirements?: string | null;
  called_time?: string | null;
  recall_count?: number;
  qr_url?: string;
  duplicate?: boolean;
}

export interface WaitlistLocationInfo {
  id: number;
  name: string;
  slug: string;
  restaurant_name: string;
  waitlist_enabled: boolean;
  queue_length: number;
  parties_waiting: number;
  currently_serving: string | null;
  estimated_wait_min: number;
  estimated_wait_label: string;
  queue_prefix: string;
  checkin_url: string;
}

export interface WaitlistAdminLocation {
  id: number;
  name: string;
  slug: string;
  restaurant_name: string;
  waitlist_enabled: boolean;
  active_count: number;
}

export interface WaitlistAdminEntry {
  id: number;
  queue_number: string;
  queue_seq: number;
  customer_name: string;
  party_size: number;
  customer_phone: string | null;
  special_requirements: string | null;
  status: string;
  check_in_time: string;
  called_time: string | null;
  recall_count: number;
  waited_min: number;
}

export interface WaitlistSummary {
  location_id: number;
  now_serving: string | null;
  next_up: string[];
  counts: Record<string, number>;
  entries: WaitlistAdminEntry[];
}

export const WAITLIST_STATUS_LABELS: Record<string, string> = {
  WAITING: 'Waiting',
  ALMOST_READY: 'Almost ready',
  CALLED: 'Called',
  SEATED: 'Seated',
  SKIPPED: 'Skipped',
  NO_SHOW: 'No show',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

export const TRACKING_STEPS = [
  'Checked in',
  'Waiting',
  'Almost your turn',
  'Called',
  'Seated',
] as const;

/** Map a waitlist status to its index on the customer tracking stepper. */
export function trackingStepIndex(status: string): number {
  switch (status) {
    case 'WAITING':
      return 1;
    case 'ALMOST_READY':
      return 2;
    case 'CALLED':
      return 3;
    case 'SEATED':
      return 4;
    default:
      return -1;
  }
}

export function isActiveWaitlistStatus(status: string): boolean {
  return status === 'WAITING' || status === 'ALMOST_READY' || status === 'CALLED';
}
