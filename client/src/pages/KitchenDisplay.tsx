import { useCallback, useEffect, useState } from 'react';
import { api, getUser } from '../lib/api';

interface KitchenOrder {
  id: number;
  order_number: number;
  customer_name: string | null;
  special_instructions: string | null;
  order_status: string;
  payment_status: string;
  total_cents: number;
  created_at: string;
  items: { item_name: string; quantity: number }[];
}

const ACTIVE = ['RECEIVED', 'PREPARING', 'READY'];

export default function KitchenDisplay() {
  const user = getUser();
  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const summaries = await api<{ id: number }[]>('/api/orders?limit=100');
      const detailed = await Promise.all(
        summaries
          .filter((s: any) => ACTIVE.includes(s.order_status))
          .map((s) => api<KitchenOrder>(`/api/orders/${s.id}`))
      );
      detailed.sort(
        (a, b) => ACTIVE.indexOf(a.order_status) - ACTIVE.indexOf(b.order_status) || a.id - b.id
      );
      setOrders(detailed);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = window.setInterval(load, 5000);
    let es: EventSource | null = null;
    try {
      const token = localStorage.getItem('kqr_staff_token');
      es = new EventSource(`/api/orders/events?token=${encodeURIComponent(token || '')}`);
      es.addEventListener('order', () => load());
      es.onerror = () => es?.close();
    } catch {
      /* polling covers it */
    }
    return () => {
      window.clearInterval(t);
      es?.close();
    };
  }, [load]);

  const setStatus = async (id: number, status: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const canUpdate = user?.role === 'ADMIN' || user?.role === 'KITCHEN_STAFF';

  return (
    <div className="page wide">
      <h1>🍳 Kitchen display</h1>
      <p className="sub">Tap a card's button the moment the status changes — the customer is notified instantly.</p>
      {error && <div className="error">{error}</div>}
      {orders.length === 0 ? (
        <div className="card empty">No active orders. New paid orders appear here automatically.</div>
      ) : (
        <div className="kitchen-grid">
          {orders.map((o) => (
            <div className={`kcard ${o.order_status}`} key={o.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div className="num">#{o.order_number}</div>
                <span className={`badge ${o.order_status}`}>{o.order_status}</span>
              </div>
              {o.customer_name && <div className="sub">{o.customer_name}</div>}
              <div className="items">
                {o.items.map((it, i) => (
                  <div key={i}>
                    <b>{it.item_name}</b> ×{it.quantity}
                  </div>
                ))}
              </div>
              {o.special_instructions && <div className="special">📝 {o.special_instructions}</div>}
              <div className="time">
                {new Date(o.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </div>
              {canUpdate && (
                <div className="btn-row" style={{ marginTop: 12 }}>
                  {o.order_status === 'RECEIVED' && (
                    <button className="btn warn block" disabled={busyId === o.id} onClick={() => setStatus(o.id, 'PREPARING')}>
                      Start preparing
                    </button>
                  )}
                  {o.order_status === 'PREPARING' && (
                    <button className="btn block" disabled={busyId === o.id} onClick={() => setStatus(o.id, 'READY')}>
                      ✅ MARK READY
                    </button>
                  )}
                  {o.order_status === 'READY' && (
                    <button className="btn secondary block" disabled={busyId === o.id} onClick={() => setStatus(o.id, 'COMPLETED')}>
                      Complete
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
