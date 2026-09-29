import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, getToken, getUser } from '../lib/api';
import {
  WaitlistAdminEntry,
  WaitlistAdminLocation,
  WaitlistSummary,
  WAITLIST_STATUS_LABELS,
} from '../lib/waitlist';

/** Staff actions per entry status. Label + endpoint suffix. */
const ENTRY_ACTIONS: Record<string, { label: string; action: string; kind?: 'warn' | 'danger' }[]> = {
  WAITING: [
    { label: 'ALMOST READY', action: 'almost-ready' },
    { label: 'CALL', action: 'call' },
    { label: 'NO SHOW', action: 'no-show', kind: 'warn' },
    { label: 'CANCEL', action: 'cancel', kind: 'danger' },
  ],
  ALMOST_READY: [
    { label: 'CALL', action: 'call' },
    { label: 'SKIP', action: 'skip', kind: 'warn' },
    { label: 'NO SHOW', action: 'no-show', kind: 'warn' },
    { label: 'CANCEL', action: 'cancel', kind: 'danger' },
  ],
  CALLED: [
    { label: 'SEATED', action: 'seated' },
    { label: 'RECALL', action: 'recall' },
    { label: 'SKIP', action: 'skip', kind: 'warn' },
    { label: 'NO SHOW', action: 'no-show', kind: 'warn' },
    { label: 'CANCEL', action: 'cancel', kind: 'danger' },
  ],
  SKIPPED: [
    { label: 'MOVE BACK TO WAITING', action: 'restore' },
    { label: 'CALL', action: 'call' },
    { label: 'NO SHOW', action: 'no-show', kind: 'warn' },
    { label: 'CANCEL', action: 'cancel', kind: 'danger' },
  ],
};

export default function WaitlistAdmin() {
  const user = getUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const [locations, setLocations] = useState<WaitlistAdminLocation[]>([]);
  const [locationId, setLocationId] = useState<number | null>(null);
  const [summary, setSummary] = useState<WaitlistSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showSelectGuest, setShowSelectGuest] = useState(false);
  const [selectedGuestId, setSelectedGuestId] = useState<number | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [inactiveEntries, setInactiveEntries] = useState<WaitlistAdminEntry[]>([]);

  const canMutate = user?.role === 'ADMIN' || user?.role === 'COUNTER_STAFF';

  // Load locations once.
  useEffect(() => {
    (async () => {
      try {
        const locs = await api<WaitlistAdminLocation[]>('/api/waitlist/admin/locations');
        setLocations(locs);
        const fromQuery = Number(searchParams.get('location_id'));
        const initial = locs.find((l) => l.id === fromQuery) || locs[0];
        setLocationId(initial ? initial.id : null);
        if (initial && !searchParams.get('location_id')) {
          setSearchParams({ location_id: String(initial.id) }, { replace: true });
        }
      } catch (e: any) {
        setError(e.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSummary = useCallback(async () => {
    if (locationId == null) return;
    try {
      const s = await api<WaitlistSummary>(`/api/waitlist/admin/summary?location_id=${locationId}`);
      setSummary(s);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [locationId]);

  const loadInactive = useCallback(async () => {
    if (locationId == null) return;
    try {
      const entries = await api<WaitlistAdminEntry[]>(
        `/api/waitlist/admin/entries?location_id=${locationId}&status=all`
      );
      setInactiveEntries(
        entries.filter((e) => !['WAITING', 'ALMOST_READY', 'CALLED', 'SKIPPED'].includes(e.status))
      );
    } catch (e: any) {
      setError(e.message);
    }
  }, [locationId]);

  // Initial + live summary refresh.
  useEffect(() => {
    loadSummary();
    if (locationId == null) return;
    let es: EventSource | null = null;
    try {
      const token = getToken();
      es = new EventSource(
        `/api/waitlist/admin/events?location_id=${locationId}&token=${encodeURIComponent(token || '')}`
      );
      es.addEventListener('waitlist', () => {
        loadSummary();
        if (showInactive) loadInactive();
      });
      es.onerror = () => es?.close();
    } catch {
      /* summary loads cover it */
    }
    return () => es?.close();
  }, [locationId, loadSummary, loadInactive, showInactive]);

  const pickLocation = (id: number) => {
    setLocationId(id);
    setSummary(null);
    setShowInactive(false);
    setShowSelectGuest(false);
    setNotice(null);
    setSearchParams({ location_id: String(id) }, { replace: true });
  };

  const mutate = async (action: string, entryId: number, busyKey: string) => {
    setBusy(busyKey);
    setNotice(null);
    setError(null);
    try {
      const res = await api<{ id: number; queue_number: string; status: string }>(
        `/api/waitlist/${entryId}/${action}`,
        { method: 'POST' }
      );
      setNotice(`${res.queue_number} → ${WAITLIST_STATUS_LABELS[res.status] || res.status}`);
      await loadSummary();
      if (showInactive) await loadInactive();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const callNext = async () => {
    if (locationId == null) return;
    setBusy('call-next');
    setNotice(null);
    setError(null);
    try {
      const res = await api<{ id: number; queue_number: string; status: string }>(
        '/api/waitlist/admin/call-next',
        { method: 'POST', body: JSON.stringify({ location_id: locationId }) }
      );
      setNotice(`Called ${res.queue_number}`);
      await loadSummary();
      if (showInactive) await loadInactive();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const activeLocation = locations.find((l) => l.id === locationId) || null;
  const entries = summary?.entries || [];
  const waitingEntries = entries.filter((e) => e.status === 'WAITING');
  const checkinDisplayUrl = activeLocation
    ? `${window.location.origin}/checkin/${activeLocation.slug}`
    : '';

  return (
    <div className="page wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h1>Waiting List</h1>
        {!canMutate && (
          <div className="info" style={{ margin: 0 }}>
            View only — queue actions need an admin or counter-staff account.
          </div>
        )}
      </div>

      {locations.length > 0 && (
        <div className="filterbar">
          {locations.map((l) => (
            <button
              key={l.id}
              className={`chip${l.id === locationId ? ' active' : ''}`}
              onClick={() => pickLocation(l.id)}
            >
              {l.restaurant_name} · {l.name} ({l.active_count})
            </button>
          ))}
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {notice && <div className="ok">{notice}</div>}

      {locationId == null ? (
        <div className="card empty">No locations found.</div>
      ) : !summary ? (
        <div className="card empty">Loading the waiting list…</div>
      ) : (
        <>
          <div className="card" style={{ textAlign: 'center' }}>
            <div className="sub" style={{ margin: 0 }}>NOW SERVING</div>
            <div className="qn-big">{summary.now_serving || '—'}</div>
            <div className="sub" style={{ marginBottom: 0 }}>
              NEXT UP:{' '}
              {summary.next_up.length > 0 ? summary.next_up.join(' · ') : '—'}
            </div>
          </div>

          <div className="btn-row" style={{ margin: '4px 0 12px' }}>
            <button
              className="btn"
              style={{ minHeight: 64, fontSize: 20 }}
              onClick={callNext}
              disabled={!canMutate || busy === 'call-next' || waitingEntries.length === 0}
            >
              {busy === 'call-next' ? 'Calling…' : '📢 CALL NEXT'}
            </button>
            <button
              className="btn secondary"
              style={{ minHeight: 64, fontSize: 20 }}
              onClick={() => {
                setSelectedGuestId(null);
                setShowSelectGuest(true);
              }}
              disabled={!canMutate || waitingEntries.length === 0}
            >
              SELECT GUEST
            </button>
          </div>

          <div className="card" style={{ padding: 8 }}>
            <h2 style={{ padding: '8px 8px 0' }}>Waiting ({entries.length})</h2>
            {entries.length === 0 ? (
              <div className="empty">Nobody waiting right now.</div>
            ) : (
              <table className="orders">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Guest</th>
                    <th>Party</th>
                    <th>Status</th>
                    <th>Waited</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <b>{e.queue_number}</b>
                      </td>
                      <td>
                        {e.customer_name}
                        {e.special_requirements && (
                          <div className="sub" style={{ margin: 0, fontSize: 12 }}>
                            {e.special_requirements}
                          </div>
                        )}
                      </td>
                      <td>{e.party_size}</td>
                      <td>
                        <span className={`badge ${e.status}`}>
                          {WAITLIST_STATUS_LABELS[e.status] || e.status}
                        </span>
                        {e.recall_count > 0 && (
                          <div className="sub" style={{ margin: 0, fontSize: 12 }}>
                            recalled ×{e.recall_count}
                          </div>
                        )}
                      </td>
                      <td>{e.waited_min} min</td>
                      <td>
                        <div className="btn-row" style={{ marginTop: 0, gap: 6 }}>
                          {(ENTRY_ACTIONS[e.status] || []).map((a) => (
                            <button
                              key={a.action}
                              className={`btn${a.kind ? ' ' + a.kind : ' secondary'}`}
                              style={{ minHeight: 36, padding: '6px 10px', fontSize: 12 }}
                              onClick={() => mutate(a.action, e.id, `${a.action}-${e.id}`)}
                              disabled={!canMutate || busy === `${a.action}-${e.id}`}
                            >
                              {a.label}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <h2>Restaurant check-in QR</h2>
            <p className="sub">
              Print this and place it at the entrance or host stand — customers scan it to join the waitlist.
            </p>
            <div className="qr-box">
              <img
                src={`/api/waitlist/location/${activeLocation?.slug}/qr.png`}
                alt="Restaurant check-in QR code"
              />
            </div>
            <div className="mono" style={{ marginTop: 12 }}>
              {checkinDisplayUrl}
            </div>
          </div>

          <div className="card">
            <button
              className="btn secondary block"
              onClick={() => {
                const next = !showInactive;
                setShowInactive(next);
                if (next) loadInactive();
              }}
            >
              {showInactive ? 'Hide completed entries' : 'Show completed entries'}
            </button>
            {showInactive && (
              <table className="orders" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Guest</th>
                    <th>Party</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {inactiveEntries.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="empty">
                        No completed entries.
                      </td>
                    </tr>
                  ) : (
                    inactiveEntries.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <b>{e.queue_number}</b>
                        </td>
                        <td>{e.customer_name}</td>
                        <td>{e.party_size}</td>
                        <td>
                          <span className={`badge ${e.status}`}>
                            {WAITLIST_STATUS_LABELS[e.status] || e.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {showSelectGuest && (
        <div className="modal-overlay" onClick={() => setShowSelectGuest(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Select guest</h2>
            <p className="sub">Pick a waiting guest to call — useful when a table fits a particular party size.</p>
            {waitingEntries.map((e) => (
              <div
                key={e.id}
                className={`guest-pick${selectedGuestId === e.id ? ' selected' : ''}`}
                onClick={() => setSelectedGuestId(e.id)}
              >
                <b>{e.queue_number}</b>
                <span>
                  {e.customer_name} — {e.party_size} {e.party_size === 1 ? 'guest' : 'guests'}
                </span>
              </div>
            ))}
            <div className="btn-row">
              <button className="btn secondary" onClick={() => setShowSelectGuest(false)}>
                Close
              </button>
              <button
                className="btn"
                disabled={selectedGuestId == null || busy != null}
                onClick={async () => {
                  if (selectedGuestId == null) return;
                  await mutate('call', selectedGuestId, `call-${selectedGuestId}`);
                  setShowSelectGuest(false);
                }}
              >
                {busy ? 'Calling…' : 'CALL SELECTED'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
