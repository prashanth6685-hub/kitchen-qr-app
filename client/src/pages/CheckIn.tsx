import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WaitlistEntryData, WaitlistLocationInfo } from '../lib/waitlist';
import WaitlistNotify from '../components/WaitlistNotify';

async function readError(res: Response): Promise<string> {
  const d = await res.json().catch(() => null);
  return d?.error || `Request failed (${res.status})`;
}

export default function CheckIn() {
  const { slug } = useParams<{ slug: string }>();
  const [loc, setLoc] = useState<WaitlistLocationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [partySize, setPartySize] = useState(2);
  const [phone, setPhone] = useState('');
  const [special, setSpecial] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [entry, setEntry] = useState<WaitlistEntryData | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/waitlist/location/${encodeURIComponent(slug || '')}`);
        if (res.status === 404) {
          throw new Error('This check-in link is invalid. Please scan the QR code at the restaurant entrance again.');
        }
        if (!res.ok) throw new Error(await readError(res));
        setLoc((await res.json()) as WaitlistLocationInfo);
      } catch (e: any) {
        setLoadError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [slug]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    const customerName = name.trim();
    if (!customerName) {
      setSubmitError('Please enter your name.');
      return;
    }
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 30) {
      setSubmitError('Party size must be between 1 and 30.');
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        slug,
        customer_name: customerName,
        party_size: partySize,
      };
      if (phone.trim()) body.customer_phone = phone.trim();
      if (special.trim()) body.special_requirements = special.trim();
      const res = await fetch('/api/waitlist/check-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 404) {
        throw new Error('Check-in is not available for this location right now. Please ask the host stand for help.');
      }
      if (res.status === 429) {
        throw new Error('Too many check-ins right now — please wait a minute and try again.');
      }
      if (!res.ok) throw new Error(await readError(res));
      setEntry((await res.json()) as WaitlistEntryData);
      window.scrollTo(0, 0);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <div className="card empty">Loading check-in…</div>
      </div>
    );
  }

  if (loadError || !loc) {
    return (
      <div className="page">
        <div className="card" style={{ textAlign: 'center', marginTop: 40 }}>
          <h1>😕</h1>
          <h2>Check-in unavailable</h2>
          <p className="sub">{loadError || 'Could not load this check-in page.'}</p>
        </div>
      </div>
    );
  }

  if (!loc.waitlist_enabled) {
    return (
      <div className="page">
        <div className="topbar" style={{ position: 'static', borderRadius: 14, marginBottom: 4 }}>
          <div className="brand">
            <span>●</span> {loc.restaurant_name.toUpperCase()}
          </div>
        </div>
        <div className="card" style={{ textAlign: 'center', marginTop: 24 }}>
          <h2>The waiting list is closed</h2>
          <p className="sub">This location is not taking waitlist check-ins right now. Please ask the host stand for help.</p>
        </div>
      </div>
    );
  }

  if (entry) {
    const qrSrc = entry.qr_url || `/api/waitlist/token/${entry.public_token}/qr.png`;
    return (
      <div className="page">
        <div className="topbar" style={{ position: 'static', borderRadius: 14, marginBottom: 4 }}>
          <div className="brand">
            <span>●</span> {entry.restaurant_name.toUpperCase()}
          </div>
        </div>

        <div className="status-hero">
          <div className="sub" style={{ margin: 0 }}>
            {entry.duplicate ? 'You’re already on the waiting list!' : 'You’re checked in! ✓'}
          </div>
          <div className="sub" style={{ margin: 0 }}>Your number</div>
          <div className="big">{entry.queue_number}</div>
          <div className="eta">
            Party of {entry.party_size} · {entry.parties_ahead} {entry.parties_ahead === 1 ? 'party' : 'parties'} ahead
            <br />
            Estimated wait: <b>{entry.estimated_wait_label}</b>
          </div>
        </div>

        <div className="card qr-box">
          <h2>Your QR code</h2>
          <img src={qrSrc} alt="Your waitlist QR code" />
          <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
            Screenshot or bookmark it — if you close this page, scan it again to get back to your spot.
          </p>
        </div>

        <WaitlistNotify token={entry.public_token} />

        <div className="card" style={{ textAlign: 'center' }}>
          <Link className="btn block" to={`/wait/${entry.public_token}`}>
            See my place in line →
          </Link>
          <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
            We'll notify you when your table is getting close.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="topbar" style={{ position: 'static', borderRadius: 14, marginBottom: 4 }}>
        <div className="brand">
          <span>●</span> {loc.restaurant_name.toUpperCase()}
        </div>
        <span className="who">{loc.name}</span>
      </div>

      <div className="card">
        <h1>Join the Waiting List</h1>
        <p className="sub">
          {loc.parties_waiting > 0
            ? `${loc.parties_waiting} ${loc.parties_waiting === 1 ? 'party' : 'parties'} waiting · about ${loc.estimated_wait_label}`
            : 'No wait right now — check in and we’ll seat you soon.'}
        </p>

        {submitError && <div className="error">{submitError}</div>}

        <form onSubmit={onSubmit}>
          <label className="field">
            <span>Name *</span>
            <input
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoComplete="name"
            />
          </label>

          <label className="field">
            <span>Number of guests *</span>
            <div className="qty">
              <button type="button" onClick={() => setPartySize((p) => Math.max(1, p - 1))} aria-label="Fewer guests">
                −
              </button>
              <b style={{ fontSize: 20 }}>{partySize}</b>
              <button type="button" onClick={() => setPartySize((p) => Math.min(30, p + 1))} aria-label="More guests">
                +
              </button>
            </div>
          </label>

          <label className="field">
            <span>Phone number (optional)</span>
            <input
              placeholder="For faster check-in next time"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={40}
              inputMode="tel"
              autoComplete="tel"
            />
          </label>

          <label className="field">
            <span>Special requirements (optional)</span>
            <textarea
              placeholder="High chair, wheelchair access, indoor/outdoor preference…"
              value={special}
              onChange={(e) => setSpecial(e.target.value)}
              maxLength={500}
              rows={2}
            />
          </label>

          <button className="btn block" type="submit" disabled={submitting}>
            {submitting ? 'Checking in…' : '✓ CHECK IN'}
          </button>
        </form>
      </div>

      <p className="sub" style={{ textAlign: 'center' }}>
        No account, no app download — just your name and party size.
      </p>
    </div>
  );
}
