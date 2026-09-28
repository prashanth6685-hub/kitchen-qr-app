import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, getUser } from '../lib/api';

interface OrderSummary {
  id: number;
  order_number: number;
  customer_name: string | null;
  order_status: string;
  payment_status: string;
  total_cents: number;
  created_at: string;
  item_count: number;
}

const FILTERS = ['ALL', 'PENDING_PAYMENT', 'PAID', 'RECEIVED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];

export default function StaffDashboard() {
  const user = getUser();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [filter, setFilter] = useState('ALL');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filter !== 'ALL') params.set('status', filter);
      if (q.trim()) params.set('q', q.trim());
      const data = await api<OrderSummary[]>(`/api/orders?${params}`);
      setOrders(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [filter, q]);

  useEffect(() => {
    load();
    const t = window.setInterval(load, 4000);
    // Live updates via SSE (token in query string — EventSource can't set headers).
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

  return (
    <div className="page wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h1>Orders</h1>
        {(user?.role === 'ADMIN' || user?.role === 'COUNTER_STAFF') && (
          <Link className="btn" to="/staff/new">+ New order</Link>
        )}
      </div>

      <div className="filterbar">
        <input
          className="search"
          placeholder="Search name or order #…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="filterbar">
        {FILTERS.map((f) => (
          <button key={f} className={`chip${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'ALL' ? 'All' : f.replace('_', ' ')}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card" style={{ padding: 8 }}>
        {orders.length === 0 ? (
          <div className="empty">No orders found.</div>
        ) : (
          <table className="orders">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Total</th>
                <th>Payment</th>
                <th>Status</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} onClick={() => (window.location.href = `/staff/orders/${o.id}`)}>
                  <td><b>#{o.order_number}</b></td>
                  <td>{o.customer_name || '—'}</td>
                  <td>{o.item_count}</td>
                  <td>{money(o.total_cents)}</td>
                  <td>
                    <span className={`badge ${o.payment_status === 'PAID' ? 'READY' : 'PENDING_PAYMENT'}`}>
                      {o.payment_status}
                    </span>
                  </td>
                  <td><span className={`badge ${o.order_status}`}>{o.order_status.replace('_', ' ')}</span></td>
                  <td>{new Date(o.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
