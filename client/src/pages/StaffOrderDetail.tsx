import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, money, getToken } from '../lib/api';

interface OrderDetail {
  id: number;
  order_number: number;
  customer_name: string | null;
  customer_phone: string | null;
  special_instructions: string | null;
  total_cents: number;
  payment_status: string;
  order_status: string;
  created_at: string;
  items: { item_name: string; quantity: number; unit_price_cents: number; total_price_cents: number }[];
  tracking_url: string;
  history: { old_status: string | null; new_status: string; changed_by: string; changed_at: string }[];
}

export default function StaffOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<OrderDetail>(`/api/orders/${id}`);
      setOrder(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    load();
    if (searchParams.get('paid')) {
      setNotice('Returned from checkout — confirming payment status…');
      const t = window.setTimeout(() => {
        load();
        setNotice(null);
        setSearchParams({});
      }, 2500);
      return () => window.clearTimeout(t);
    }
    // Live refresh while the payment/order changes.
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, [load, searchParams, setSearchParams]);

  const pay = async (kind: 'cash' | 'demo' | 'stripe') => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'stripe') {
        const data = await api<{ checkout_url: string }>(`/api/orders/${id}/payments/stripe`, {
          method: 'POST',
        });
        window.open(data.checkout_url, '_blank', 'noopener');
        setNotice('Stripe Checkout opened — the QR code appears here once payment is confirmed.');
        return;
      }
      const data = await api<{ warning?: string }>(`/api/orders/${id}/payments/${kind}`, { method: 'POST' });
      if (data.warning) setNotice(data.warning);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !order) {
    return (
      <div className="page">
        <div className="error">{error}</div>
      </div>
    );
  }
  if (!order) {
    return (
      <div className="page">
        <div className="card empty">Loading…</div>
      </div>
    );
  }

  const paid = order.payment_status === 'PAID';
  // <img> can't send Authorization headers, so the staff token rides in the query string.
  const qrSrc = `/api/orders/${order.id}/qr.png?token=${encodeURIComponent(getToken() || '')}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(order.tracking_url);
      setNotice('Tracking link copied.');
    } catch {
      setNotice(order.tracking_url);
    }
  };

  return (
    <div className="page">
      <h1>Order #{order.order_number}</h1>
      {error && <div className="error">{error}</div>}
      {notice && <div className="ok">{notice}</div>}

      <div className="card">
        <div className="btn-row" style={{ marginTop: 0, marginBottom: 12 }}>
          <span className={`badge ${order.order_status}`}>{order.order_status.replace('_', ' ')}</span>
          <span className={`badge ${paid ? 'READY' : 'PENDING_PAYMENT'}`}>
            {paid ? 'PAID' : order.payment_status}
          </span>
        </div>
        {order.items.map((it, i) => (
          <div className="item-row" key={i}>
            <span>{it.item_name} <b>×{it.quantity}</b></span>
            <span>{money(it.total_price_cents)}</span>
          </div>
        ))}
        <div className="total-row">
          <span>Total</span>
          <span>{money(order.total_cents)}</span>
        </div>
        <div className="sub" style={{ marginTop: 10 }}>
          {order.customer_name && <div>Customer: {order.customer_name}</div>}
          {order.customer_phone && <div>Phone: {order.customer_phone}</div>}
          {order.special_instructions && <div>Note: {order.special_instructions}</div>}
          <div>Created: {new Date(order.created_at).toLocaleString()}</div>
        </div>
      </div>

      {!paid && (
        <div className="card">
          <h2>Take payment</h2>
          <p className="sub">The QR code is generated only after payment is confirmed.</p>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => pay('stripe')}>
              💳 Card (Stripe)
            </button>
            <button className="btn secondary" disabled={busy} onClick={() => pay('cash')}>
              💵 Cash received
            </button>
            <button className="btn warn" disabled={busy} onClick={() => pay('demo')}>
              🧪 Demo card payment
            </button>
          </div>
          <p className="sub" style={{ marginTop: 10 }}>
            Card payments via Stripe Checkout open automatically when Stripe keys are configured. Demo payments are
            for testing only and must be disabled in production (DEMO_PAYMENTS=false).
          </p>
        </div>
      )}

      {paid && (
        <div className="card qr-box">
          <h2>✅ Payment confirmed</h2>
          <p className="sub">Show this QR code to the customer — scanning opens their live order page.</p>
          <img src={qrSrc} alt={`QR code for order ${order.order_number}`} />
          <div className="mono" style={{ marginTop: 12 }}>{order.tracking_url}</div>
          <div className="btn-row no-print">
            <button className="btn secondary" onClick={() => window.print()}>🖨 Print</button>
            <a className="btn secondary" href={qrSrc} download={`order-${order.order_number}-qr.png`}>⬇ Download</a>
            <button className="btn secondary" onClick={copyLink}>🔗 Copy link</button>
          </div>
        </div>
      )}

      <div className="card no-print">
        <h2>Status history</h2>
        {order.history.map((h, i) => (
          <div className="item-row" key={i}>
            <span>
              {h.old_status ? `${h.old_status} → ` : ''}<b>{h.new_status}</b> <span className="sub">by {h.changed_by}</span>
            </span>
            <span className="sub">{new Date(h.changed_at).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
