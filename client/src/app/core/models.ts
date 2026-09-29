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
