import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { money, STATUS_LABELS, STATUS_STEPS } from '../lib/api';
import { enablePush, getPushState, isIOS, isStandalone, PushState } from '../lib/push';

interface OrderItem {
  item_name: string;
  quantity: number;
  unit_price_cents: number;
  total_price_cents: number;
}

interface CustomerOrderData {
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

export default function CustomerOrder() {
  const { token } = useParams<{ token: string }>();
  const [order, setOrder] = useState<CustomerOrderData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<PushState>('available');
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [showIOSHint, setShowIOSHint] = useState(false);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/orders/token/${token}`);
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      throw new Error(d?.error || 'Could not load this order.');
    }
    const data = (await res.json()) as CustomerOrderData;
    setOrder(data);
    return data;
  }, [token]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    getPushState().then(setPushState);
    isIOS().then(async (ios) => {
      if (ios && !(await isStandalone())) setShowIOSHint(true);
    });

    // Real-time updates: SSE first, polling fallback.
    let es: EventSource | null = null;
    let pollFallback = false;
    try {
      es = new EventSource(`/api/orders/token/${token}/events`);
      es.addEventListener('order', (ev: MessageEvent) => {
        const u = JSON.parse(ev.data);
        setLive(true);
        setOrder((prev) =>
          prev
            ? { ...prev, order_status: u.order_status, payment_status: u.payment_status, updated_at: u.updated_at }
            : prev
        );
      });
      es.onerror = () => {
        es?.close();
        if (!pollFallback) {
          pollFallback = true;
          pollRef.current = window.setInterval(() => {
            load().then(() => setLive(true)).catch(() => {});
          }, 5000);
        }
      };
    } catch {
      pollRef.current = window.setInterval(() => {
        load().then(() => setLive(true)).catch(() => {});
      }, 5000);
    }
    return () => {
      es?.close();
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [token, load]);

  const onEnablePush = async () => {
    setPushBusy(true);
    setPushMsg(null);
    const r = await enablePush(token!);
    setPushMsg(r.message);
    if (r.ok) setPushState('subscribed');
    else setPushState(await getPushState());
    setPushBusy(false);
  };

  if (error) {
    return (
      <div className="page">
        <div className="card" style={{ textAlign: 'center', marginTop: 40 }}>
          <h1>😕</h1>
          <h2>Order not found</h2>
          <p className="sub">{error} Please contact the kitchen counter.</p>
        </div>
      </div>
    );
  }
  if (!order) {
    return (
      <div className="page">
        <div className="card empty">Loading your order…</div>
      </div>
    );
  }

  const stepIndex = STATUS_STEPS.indexOf(order.order_status as any);
  const cancelled = order.order_status === 'CANCELLED';

  return (
    <div className="page">
      <div className="topbar" style={{ position: 'static', borderRadius: 14, marginBottom: 4 }}>
        <div className="brand">
          <span>●</span> YOUR KITCHEN
        </div>
        <span className="who">{live ? '● live' : '○ connecting…'}</span>
      </div>

      <div className={`card status-hero ${order.order_status === 'READY' ? 'READY' : ''}`}>
        <div className="sub" style={{ margin: 0 }}>
          Order #{order.order_number}
          {order.customer_name ? ` · ${order.customer_name}` : ''}
        </div>
        <div className="big">
          {cancelled ? '❌ Cancelled' : order.order_status === 'READY' ? '🟢 READY' : STATUS_LABELS[order.order_status]}
        </div>
        <div className="eta">
          {order.order_status === 'READY'
            ? 'Please come to the counter to pick up your order.'
            : order.order_status === 'COMPLETED'
            ? 'Thank you! Enjoy your meal.'
            : !cancelled
            ? 'Estimated pickup: 10–15 minutes'
            : 'Please contact the kitchen counter.'}
        </div>
      </div>

      {!cancelled && (
        <div className="card">
          <h2>Order status</h2>
          <ul className="steps">
            {STATUS_STEPS.map((s, i) => {
              const cls = i < stepIndex ? 'done' : i === stepIndex ? 'current' : '';
              return (
                <li key={s} className={cls}>
                  <span className="dot">{i < stepIndex ? '✓' : i + 1}</span>
                  <span>{STATUS_LABELS[s]}</span>
                </li>
              );
            })}
          </ul>
          <div className="sub" style={{ marginTop: 8 }}>
            Payment: {order.payment_status === 'PAID' ? '✓ Confirmed' : order.payment_status}
          </div>
        </div>
      )}

      {pushState !== 'subscribed' && !cancelled && (
        <div className="card">
          <h2>🔔 Get notified</h2>
          <p className="sub">We'll notify you the moment your order is ready.</p>
          {showIOSHint && (
            <div className="info">
              On iPhone, push notifications work best if you add this page to your Home Screen first
              (Share → Add to Home Screen), then tap the button below.
            </div>
          )}
          {pushState === 'denied' ? (
            <div className="info">
              Notifications are blocked for this site. You can still watch your order status update live on this page.
            </div>
          ) : pushState === 'unsupported' ? (
            <div className="info">
              This browser doesn't support push notifications — this page still updates live automatically.
            </div>
          ) : (
            <button className="btn block" onClick={onEnablePush} disabled={pushBusy}>
              {pushBusy ? 'Enabling…' : '🔔 Enable Notifications'}
            </button>
          )}
          {pushMsg && <div className={pushMsg.startsWith("You're") ? 'ok' : 'info'}>{pushMsg}</div>}
        </div>
      )}
      {pushState === 'subscribed' && (
        <div className="ok">🔔 Notifications on — we'll alert you when your order is ready.</div>
      )}

      <div className="card">
        <h2>Your items</h2>
        {order.items.map((it, i) => (
          <div className="item-row" key={i}>
            <span>
              {it.item_name} <b>×{it.quantity}</b>
            </span>
            <span>{money(it.total_price_cents)}</span>
          </div>
        ))}
        {order.special_instructions && (
          <div className="sub" style={{ marginTop: 8 }}>Note: {order.special_instructions}</div>
        )}
        <div className="total-row">
          <span>Total</span>
          <span>{money(order.total_cents)}</span>
        </div>
        <div className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
          Last updated: {new Date(order.updated_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </div>
      </div>

      <p className="sub" style={{ textAlign: 'center' }}>
        Keep this page or your QR code — you can come back anytime to check your order.
      </p>
    </div>
  );
}
