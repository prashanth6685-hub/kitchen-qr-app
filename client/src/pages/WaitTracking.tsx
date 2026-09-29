import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  TRACKING_STEPS,
  WaitlistEntryData,
  WAITLIST_STATUS_LABELS,
  isActiveWaitlistStatus,
  trackingStepIndex,
} from '../lib/waitlist';
import WaitlistNotify from '../components/WaitlistNotify';

const TERMINAL_COPY: Record<string, { emoji: string; title: string; body: string }> = {
  CANCELLED: {
    emoji: '❌',
    title: 'Wait cancelled',
    body: 'Your waitlist entry has been cancelled. Check in again any time.',
  },
  NO_SHOW: {
    emoji: '👋',
    title: 'Marked as no-show',
    body: 'We marked your entry as a no-show. Please check in again at the host stand.',
  },
  EXPIRED: {
    emoji: '⌛',
    title: 'Entry expired',
    body: 'This waitlist entry has expired. Please check in again.',
  },
  SKIPPED: {
    emoji: '⏭',
    title: 'Temporarily skipped',
    body: 'Your entry was skipped for now — the host may bring you back into the queue shortly.',
  },
};

export default function WaitTracking() {
  const { token } = useParams<{ token: string }>();
  const [entry, setEntry] = useState<WaitlistEntryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/waitlist/token/${token}`);
    if (res.status === 404) {
      const d = await res.json().catch(() => null);
      throw new Error(d?.error || 'This waitlist link is invalid or expired.');
    }
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      throw new Error(d?.error || 'Could not load your waitlist entry.');
    }
    const data = (await res.json()) as WaitlistEntryData;
    setEntry(data);
    return data;
  }, [token]);

  useEffect(() => {
    load().catch((e) => setError(e.message));

    // Real-time updates: SSE first, polling fallback.
    let es: EventSource | null = null;
    let pollFallback = false;
    try {
      es = new EventSource(`/api/waitlist/token/${token}/events`);
      es.addEventListener('waitlist', (ev: MessageEvent) => {
        const u = JSON.parse(ev.data) as WaitlistEntryData;
        setLive(true);
        setEntry(u);
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

  const onCancel = async () => {
    if (!window.confirm('Cancel your wait? You will lose your spot in line.')) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/waitlist/token/${token}/cancel`, { method: 'POST' });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error || 'Could not cancel.');
      await load();
    } catch (e: any) {
      setCancelError(e.message);
    } finally {
      setCancelling(false);
    }
  };

  if (error) {
    return (
      <div className="page">
        <div className="card" style={{ textAlign: 'center', marginTop: 40 }}>
          <h1>😕</h1>
          <h2>Waitlist entry not found</h2>
          <p className="sub">{error}</p>
        </div>
      </div>
    );
  }
  if (!entry) {
    return (
      <div className="page">
        <div className="card empty">Loading your place in line…</div>
      </div>
    );
  }

  const active = isActiveWaitlistStatus(entry.status);
  const terminal = TERMINAL_COPY[entry.status];
  const stepIndex = trackingStepIndex(entry.status);
  const canCancel = entry.status === 'WAITING' || entry.status === 'ALMOST_READY';
  const qrSrc = entry.qr_url || `/api/waitlist/token/${entry.public_token}/qr.png`;

  const statusHeadline =
    entry.status === 'WAITING'
      ? 'You’re on the waiting list!'
      : entry.status === 'ALMOST_READY'
      ? '🟡 You’re almost next!'
      : entry.status === 'CALLED'
      ? '🟢 Your table is ready!'
      : entry.status === 'SEATED'
      ? '🎉 Seated — enjoy your meal!'
      : WAITLIST_STATUS_LABELS[entry.status] || entry.status;

  return (
    <div className="page">
      <div className="topbar" style={{ position: 'static', borderRadius: 14, marginBottom: 4 }}>
        <div className="brand">
          <span>●</span> {entry.restaurant_name.toUpperCase()}
        </div>
        <span className="who">{live ? '● live' : '○ connecting…'}</span>
      </div>

      <div className={`card status-hero ${entry.status === 'CALLED' ? 'READY' : ''}`}>
        <div className="sub" style={{ margin: 0 }}>
          {entry.location_name} · {entry.customer_name}
        </div>
        <div className="sub" style={{ margin: 0 }}>Your number</div>
        <div className="big">{entry.queue_number}</div>
        <div className="eta">{statusHeadline}</div>
      </div>

      {active && (
        <div className="card">
          <div className="stat-row">
            <div className="stat">
              <b>{entry.party_size}</b>
              <span>Party size</span>
            </div>
            <div className="stat">
              <b>{entry.currently_serving || '—'}</b>
              <span>Currently serving</span>
            </div>
            <div className="stat">
              <b>{entry.parties_ahead}</b>
              <span>{entry.parties_ahead === 1 ? 'Party' : 'Parties'} ahead</span>
            </div>
            <div className="stat">
              <b style={{ fontSize: 16 }}>{entry.estimated_wait_label}</b>
              <span>Estimated wait</span>
            </div>
          </div>
        </div>
      )}

      {terminal && (
        <div className="card" style={{ textAlign: 'center' }}>
          <h1>{terminal.emoji}</h1>
          <h2>{terminal.title}</h2>
          <p className="sub">{terminal.body}</p>
        </div>
      )}

      {active && (
        <div className="card">
          <h2>Queue status</h2>
          <ul className="steps">
            {TRACKING_STEPS.map((s, i) => {
              const cls = i < stepIndex ? 'done' : i === stepIndex ? 'current' : '';
              return (
                <li key={s} className={cls}>
                  <span className="dot">{i < stepIndex ? '✓' : i + 1}</span>
                  <span>{s}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {entry.status === 'CALLED' && (
        <div className="ok" style={{ textAlign: 'center', fontSize: 16 }}>
          Please proceed to the host stand now.
        </div>
      )}

      <div className="card qr-box">
        <h2>Your QR code</h2>
        <img src={qrSrc} alt="Your waitlist QR code" />
        <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
          Keep this page open or scan the code to come back to your spot.
        </p>
      </div>

      {active && <WaitlistNotify token={entry.public_token} />}

      {canCancel && (
        <div className="card">
          {cancelError && <div className="error">{cancelError}</div>}
          <button className="btn secondary block" onClick={onCancel} disabled={cancelling}>
            {cancelling ? 'Cancelling…' : 'Cancel my wait'}
          </button>
        </div>
      )}

      <p className="sub" style={{ textAlign: 'center' }}>
        No need to watch this screen constantly — we'll notify you when your table is getting close.
      </p>
    </div>
  );
}
