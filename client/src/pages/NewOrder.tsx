import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money } from '../lib/api';

interface MenuItem {
  id: number;
  name: string;
  price: number;
}

interface Line {
  name: string;
  qty: number;
  unit_price: number;
}

interface CreatedOrder {
  id: number;
  order_number: number;
  total_cents: number;
  checkout_url: string | null;
  stripe_configured: boolean;
  demo_payments: boolean;
}

export default function NewOrder() {
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [lines, setLines] = useState<Record<number, number>>({});
  const [customName, setCustomName] = useState('');
  const [customPrice, setCustomPrice] = useState('');
  const [customLines, setCustomLines] = useState<Line[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedOrder | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api<MenuItem[]>('/api/menu').then(setMenu).catch((e) => setError(e.message));
  }, []);

  const setQty = (id: number, qty: number) => {
    setLines((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[id];
      else next[id] = qty;
      return next;
    });
  };

  const addCustom = () => {
    const name = customName.trim();
    const price = Math.round(Number(customPrice) * 100);
    if (!name || !Number.isFinite(price) || price < 0) {
      setError('Enter a valid custom item name and price.');
      return;
    }
    setCustomLines((prev) => [...prev, { name, qty: 1, unit_price: price }]);
    setCustomName('');
    setCustomPrice('');
    setError(null);
  };

  const items: Line[] = [
    ...menu.filter((m) => lines[m.id]).map((m) => ({ name: m.name, qty: lines[m.id], unit_price: m.price })),
    ...customLines,
  ];
  const total = items.reduce((s, i) => s + i.qty * i.unit_price, 0);

  const submit = async () => {
    if (items.length === 0) {
      setError('Add at least one item.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await api<CreatedOrder>('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: customerName.trim() || undefined,
          customer_phone: customerPhone.trim() || undefined,
          special_instructions: notes.trim() || undefined,
          items: items.map((i) => ({ name: i.name, qty: i.qty, unit_price: i.unit_price })),
        }),
      });
      setCreated(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const collectPayment = async (kind: 'cash' | 'demo') => {
    if (!created) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ warning?: string }>(`/api/orders/${created.id}/payments/${kind}`, {
        method: 'POST',
      });
      void data.warning;
      navigate(`/staff/orders/${created.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="page">
        <div className="card" style={{ textAlign: 'center', marginTop: 24 }}>
          <h1>Order #{created.order_number}</h1>
          <div className="big" style={{ fontSize: 34, fontWeight: 800, margin: '8px 0' }}>
            {money(created.total_cents)}
          </div>
          <p className="sub">Collect payment, then show the customer the QR code.</p>
          {error && <div className="error">{error}</div>}
          <div className="btn-row">
            {created.checkout_url && (
              <a className="btn" href={created.checkout_url} target="_blank" rel="noreferrer">
                💳 Pay by card (Stripe)
              </a>
            )}
            <button className="btn" disabled={busy} onClick={() => collectPayment('cash')}>
              💵 Cash received
            </button>
            {created.demo_payments && (
              <button className="btn warn" disabled={busy} onClick={() => collectPayment('demo')}>
                🧪 Demo card payment
              </button>
            )}
          </div>
          {!created.stripe_configured && (
            <p className="sub" style={{ marginTop: 12 }}>
              Stripe isn't configured — add STRIPE_SECRET_KEY to accept real card payments.
            </p>
          )}
          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn secondary" onClick={() => navigate(`/staff/orders/${created.id}`)}>
              View order →
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>New order</h1>
      <p className="sub">Enter the customer's items, then take payment.</p>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <h2>Menu</h2>
        <div className="menu-grid">
          {menu.map((m) => (
            <div className="menu-item" key={m.id}>
              <div>
                <div className="name">{m.name}</div>
                <div className="price">{money(m.price)}</div>
              </div>
              <div className="qty">
                <button onClick={() => setQty(m.id, (lines[m.id] || 0) - 1)} aria-label="decrease">−</button>
                <b>{lines[m.id] || 0}</b>
                <button onClick={() => setQty(m.id, (lines[m.id] || 0) + 1)} aria-label="increase">+</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Custom item</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="Item name" value={customName} onChange={(e) => setCustomName(e.target.value)} />
          <input
            placeholder="$0.00"
            inputMode="decimal"
            style={{ maxWidth: 120 }}
            value={customPrice}
            onChange={(e) => setCustomPrice(e.target.value)}
          />
          <button className="btn secondary" onClick={addCustom}>Add</button>
        </div>
        {customLines.map((l, i) => (
          <div className="item-row" key={i}>
            <span>{l.name} <b>×{l.qty}</b></span>
            <span>
              {money(l.qty * l.unit_price)}{' '}
              <button className="link" style={{ border: 'none', background: 'none', cursor: 'pointer' }} onClick={() => setCustomLines((p) => p.filter((_, j) => j !== i))}>
                remove
              </button>
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Customer</h2>
        <label className="field">
          <span>Name (optional)</span>
          <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
        </label>
        <label className="field">
          <span>Phone (optional)</span>
          <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} inputMode="tel" />
        </label>
        <label className="field">
          <span>Special instructions</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. less spicy" />
        </label>
      </div>

      <div className="card">
        <div className="total-row">
          <span>Total</span>
          <span>{money(total)}</span>
        </div>
        <div className="btn-row">
          <button className="btn block" onClick={submit} disabled={busy || items.length === 0}>
            {busy ? 'Creating…' : `Create order · ${money(total)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
