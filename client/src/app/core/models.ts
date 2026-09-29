// Shared API shapes (mirror the Express responses in server/src/orders.ts).

export interface StaffUser {
  id: number;
  username: string;
  role: 'ADMIN' | 'KITCHEN_STAFF' | 'COUNTER_STAFF';
}

export interface MenuItem {
  id: number;
  name: string;
  price: number; // cents
}

export interface OrderItem {
  item_name: string;
  quantity: number;
  unit_price_cents: number;
  total_price_cents: number;
}

export interface OrderSummary {
  id: number;
  order_number: number;
  customer_name: string | null;
  order_status: string;
  payment_status: string;
  total_cents: number;
  created_at: string;
  item_count?: number;
}

export interface OrderDetail extends OrderSummary {
  public_token: string;
  customer_phone: string | null;
  special_instructions: string | null;
  updated_at: string;
  items: OrderItem[];
  tracking_url: string;
  history: { old_status: string | null; new_status: string; changed_by: string; changed_at: string }[];
}

export interface PublicOrder {
  order_number: number;
  order_status: string;
  payment_status: string;
  customer_name: string | null;
  special_instructions: string | null;
  total_cents: number;
  currency: string;
  created_at: string;
  updated_at: string;
  items: OrderItem[];
}

export interface CreatedOrder {
  id: number;
  order_number: number;
  public_token: string;
  total_cents: number;
  checkout_url: string | null;
  stripe_configured: boolean;
  demo_payments: boolean;
}

// ---- Module 2: restaurant check-in & digital waiting list ----

export interface WaitlistLocation {
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

/** Public customer entry shape: check-in response, /token/:token, SSE payload. */
export interface WaitlistEntry {
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

export interface WaitlistAdminLocation {
  id: number;
  name: string;
  slug: string;
  restaurant_name: string;
  waitlist_enabled: boolean;
  active_count: number;
}
