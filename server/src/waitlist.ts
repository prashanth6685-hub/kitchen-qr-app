import { Router } from 'express';
import { all, row, run, now, db } from './db.js';
import { AuthRequest, requireAuth, requireRole } from './auth.js';
import {
  generatePublicToken,
  waitlistTrackingUrl,
  checkinUrl,
  qrPngBufferForUrl,
} from './qr.js';
import {
  sseInit,
  sseSend,
  subscribeToken,
  unsubscribeToken,
  subscribeWaitlistLocation,
  unsubscribeWaitlistLocation,
  broadcastWaitlistUpdate,
} from './sse.js';
import { saveWaitlistSubscription, notifyWaitlistStatus } from './push.js';

export const waitlistRouter = Router();

// ---------- Status machine ----------
const TRANSITIONS: Record<string, string[]> = {
  WAITING: ['ALMOST_READY', 'CALLED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'],
  ALMOST_READY: ['CALLED', 'SKIPPED', 'CANCELLED', 'NO_SHOW'],
  CALLED: ['SEATED', 'SKIPPED', 'NO_SHOW', 'CANCELLED', 'WAITING'],
  SKIPPED: ['WAITING', 'CALLED', 'CANCELLED', 'NO_SHOW'],
  SEATED: [],
  NO_SHOW: [],
  CANCELLED: [],
  EXPIRED: [],
};

const AHEAD_STATUSES = "status IN ('WAITING','ALMOST_READY')";
const ACTIVE_STATUSES = "status IN ('WAITING','ALMOST_READY','CALLED')";

interface LocationRow {
  id: number;
  org_id: number | null;
  name: string;
  slug: string | null;
  waitlist_prefix: string;
  avg_party_minutes: number;
  waitlist_enabled: number;
}

interface EntryRow {
  id: number;
  public_token: string;
  location_id: number;
  queue_seq: number;
  queue_number: string;
  customer_name: string;
  customer_phone: string | null;
  party_size: number;
  special_requirements: string | null;
  status: string;
  recall_count: number;
  check_in_time: string;
  called_time: string | null;
  seated_time: string | null;
  cancelled_time: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- Tiny in-memory rate limiter (per key, sliding window) ----------
const rateBuckets = new Map<string, number[]>();
function rateLimited(key: string, max: number, windowMs: number): boolean {
  const t = Date.now();
  const kept = (rateBuckets.get(key) || []).filter((x) => t - x < windowMs);
  if (kept.length >= max) return false;
  kept.push(t);
  rateBuckets.set(key, kept);
  return true;
}
function clientIp(req: any): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
}

// ---------- Lookups & derived data ----------
function locationById(id: number): LocationRow | undefined {
  return row<LocationRow>('SELECT * FROM locations WHERE id = ?', id);
}
function locationBySlug(slug: string): LocationRow | undefined {
  return row<LocationRow>('SELECT * FROM locations WHERE slug = ?', slug);
}
function restaurantNameFor(locationId: number): string {
  const r = row<{ name: string }>(
    `SELECT o.name AS name FROM organizations o
     JOIN locations l ON l.org_id = o.id WHERE l.id = ?`,
    locationId
  );
  return r?.name || 'Restaurant';
}
function partiesAhead(locationId: number, queueSeq: number): number {
  return row<{ c: number }>(
    `SELECT COUNT(*) AS c FROM waitlist_entries
     WHERE location_id = ? AND queue_seq < ? AND ${AHEAD_STATUSES}`,
    locationId,
    queueSeq
  )!.c;
}
function currentlyServing(locationId: number): string | null {
  const r =
    row<{ queue_number: string }>(
      `SELECT queue_number FROM waitlist_entries
       WHERE location_id = ? AND status = 'CALLED'
       ORDER BY called_time DESC, queue_seq DESC LIMIT 1`,
      locationId
    ) ||
    row<{ queue_number: string }>(
      `SELECT queue_number FROM waitlist_entries
       WHERE location_id = ? AND status = 'ALMOST_READY'
       ORDER BY updated_at DESC, queue_seq DESC LIMIT 1`,
      locationId
    );
  return r?.queue_number ?? null;
}
function waitEstimate(locationId: number, avgMinutes: number, parties: number) {
  const est = parties * Math.max(1, avgMinutes);
  const label =
    parties === 0 ? 'Less than 5 minutes' : `${Math.max(5, est - 5)}–${est + 5} minutes`;
  return { estimated_wait_min: est, estimated_wait_label: label };
}

function publicEntryJson(e: EntryRow, loc: LocationRow) {
  const ahead = partiesAhead(e.location_id, e.queue_seq);
  const { estimated_wait_min, estimated_wait_label } = waitEstimate(
    e.location_id,
    loc.avg_party_minutes,
    ahead
  );
  return {
    public_token: e.public_token,
    queue_number: e.queue_number,
    queue_seq: e.queue_seq,
    customer_name: e.customer_name,
    customer_phone: e.customer_phone,
    party_size: e.party_size,
    special_requirements: e.special_requirements,
    status: e.status,
    position: ahead + 1,
    parties_ahead: ahead,
    currently_serving: currentlyServing(e.location_id),
    estimated_wait_min,
    estimated_wait_label,
    restaurant_name: restaurantNameFor(e.location_id),
    location_name: loc.name,
    location_slug: loc.slug,
    check_in_time: e.check_in_time,
    called_time: e.called_time,
    seated_time: e.seated_time,
    recall_count: e.recall_count,
    tracking_url: waitlistTrackingUrl(e.public_token),
    qr_url: `/api/waitlist/token/${e.public_token}/qr.png`,
  };
}

function adminEntryJson(e: EntryRow) {
  const waitedMin = Math.max(
    0,
    Math.round((Date.now() - Date.parse(e.check_in_time)) / 60000)
  );
  return {
    id: e.id,
    queue_number: e.queue_number,
    queue_seq: e.queue_seq,
    customer_name: e.customer_name,
    party_size: e.party_size,
    customer_phone: e.customer_phone,
    special_requirements: e.special_requirements,
    status: e.status,
    check_in_time: e.check_in_time,
    called_time: e.called_time,
    recall_count: e.recall_count,
    waited_min: waitedMin,
  };
}

/** Atomic per-location, per-day queue sequence (safe under concurrent check-ins). */
function nextQueueSeq(locationId: number): number {
  const day = new Date().toISOString().slice(0, 10); // UTC day
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = row<{ last_number: number }>(
      'SELECT last_number FROM waitlist_sequences WHERE location_id = ? AND day = ?',
      locationId,
      day
    );
    const next = (cur?.last_number ?? 0) + 1;
    if (cur) {
      run('UPDATE waitlist_sequences SET last_number = ? WHERE location_id = ? AND day = ?', next, locationId, day);
    } else {
      run('INSERT INTO waitlist_sequences (location_id, day, last_number) VALUES (?, ?, ?)', locationId, day, next);
    }
    db.exec('COMMIT');
    return next;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function logQueueEvent(
  entryId: number,
  eventType: string,
  oldStatus: string | null,
  newStatus: string | null,
  performedBy: string
) {
  run(
    'INSERT INTO queue_events (waitlist_entry_id, event_type, old_status, new_status, performed_by) VALUES (?, ?, ?, ?, ?)',
    entryId,
    eventType,
    oldStatus,
    newStatus,
    performedBy
  );
}

class HttpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Move an entry to a new status: validates the transition, records the event,
 * broadcasts the live update, and fires the push notification (fire-and-forget).
 */
function doTransition(
  entryId: number,
  newStatus: string,
  performedBy: string,
  eventType: string
): EntryRow {
  const entry = row<EntryRow>('SELECT * FROM waitlist_entries WHERE id = ?', entryId);
  if (!entry) throw new HttpError(404, 'Waitlist entry not found');
  const allowed = TRANSITIONS[entry.status] || [];
  if (!allowed.includes(newStatus)) {
    throw new HttpError(409, `Cannot move entry from ${entry.status} to ${newStatus}`);
  }
  const ts = now();
  const sets: string[] = ['status = ?', 'updated_at = ?'];
  const params: any[] = [newStatus, ts];
  if (newStatus === 'CALLED') {
    sets.push('called_time = ?');
    params.push(ts);
  }
  if (newStatus === 'SEATED') {
    sets.push('seated_time = ?');
    params.push(ts);
  }
  if (newStatus === 'CANCELLED') {
    sets.push('cancelled_time = ?');
    params.push(ts);
  }
  if (newStatus === 'WAITING') {
    // Re-queued: allow "you're next" / "table ready" pushes again on the next call.
    sets.push('notified_almost_ready = 0', 'notified_called = 0');
  }
  params.push(entry.id);
  run(`UPDATE waitlist_entries SET ${sets.join(', ')} WHERE id = ?`, ...params);
  logQueueEvent(entry.id, eventType, entry.status, newStatus, performedBy);
  const updated = row<EntryRow>('SELECT * FROM waitlist_entries WHERE id = ?', entry.id)!;
  const loc = locationById(updated.location_id)!;
  broadcastWaitlistUpdate(updated.public_token, updated.location_id, publicEntryJson(updated, loc));
  const notifyStatus = eventType === 'RECALLED' ? 'RECALLED' : newStatus;
  notifyWaitlistStatus(
    updated.id,
    updated.queue_number,
    notifyStatus,
    updated.public_token,
    restaurantNameFor(updated.location_id)
  ).catch((e) => console.error('[waitlist] push notify failed', e?.message));
  return updated;
}

function resolveLocation(slug?: unknown, locationId?: unknown): LocationRow {
  let loc: LocationRow | undefined;
  if (typeof slug === 'string' && slug.trim()) loc = locationBySlug(slug.trim());
  else if (locationId !== undefined && locationId !== null && String(locationId).trim() !== '') {
    loc = locationById(Number(locationId));
  }
  if (!loc) throw new HttpError(404, 'Restaurant location not found');
  if (!loc.waitlist_enabled) throw new HttpError(400, 'The waiting list is not enabled for this location');
  return loc;
}

// ---------- Public: check-in ----------
waitlistRouter.post('/check-in', (req, res) => {
  try {
    if (!rateLimited(`checkin:${clientIp(req)}`, 10, 10 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many check-ins. Please wait a few minutes and try again.' });
    }
    const { slug, location_id, customer_name, party_size, customer_phone, special_requirements } = req.body ?? {};
    const loc = resolveLocation(slug, location_id);

    const name = String(customer_name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'Please enter your name' });
    const partySize = Math.floor(Number(party_size));
    if (!Number.isFinite(partySize) || partySize < 1 || partySize > 30) {
      return res.status(400).json({ error: 'Party size must be between 1 and 30' });
    }
    const phone = String(customer_phone || '').trim().slice(0, 40) || null;
    const notes = String(special_requirements || '').trim().slice(0, 500) || null;

    // Duplicate protection: same phone + already waiting -> return the existing entry.
    if (phone) {
      const existing = row<EntryRow>(
        `SELECT * FROM waitlist_entries
         WHERE location_id = ? AND customer_phone = ? AND ${ACTIVE_STATUSES}
         ORDER BY queue_seq LIMIT 1`,
        loc.id,
        phone
      );
      if (existing) {
        return res.json({ duplicate: true, ...publicEntryJson(existing, loc) });
      }
    }

    const seq = nextQueueSeq(loc.id);
    const prefix = String(loc.waitlist_prefix || '').trim().slice(0, 4);
    const queueNumber = `${prefix}${seq}`;
    const token = generatePublicToken();
    const ts = now();
    const insert = run(
      `INSERT INTO waitlist_entries
        (public_token, location_id, queue_seq, queue_number, customer_name, customer_phone,
         party_size, special_requirements, status, check_in_time, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'WAITING', ?, ?, ?)`,
      token,
      loc.id,
      seq,
      queueNumber,
      name,
      phone,
      partySize,
      notes,
      ts,
      ts,
      ts
    );
    const entry = row<EntryRow>('SELECT * FROM waitlist_entries WHERE id = ?', Number(insert.lastInsertRowid))!;
    logQueueEvent(entry.id, 'CHECKED_IN', null, 'WAITING', 'customer');
    broadcastWaitlistUpdate(entry.public_token, entry.location_id, publicEntryJson(entry, loc));
    res.status(201).json(publicEntryJson(entry, loc));
  } catch (e: any) {
    if (e instanceof HttpError) return res.status(e.code).json({ error: e.message });
    console.error('[waitlist] check-in failed', e);
    res.status(500).json({ error: 'Check-in failed. Please try again.' });
  }
});

// ---------- Public: location info ----------
waitlistRouter.get('/location/:slug', (req, res) => {
  const loc = locationBySlug(req.params.slug);
  if (!loc) return res.status(404).json({ error: 'Restaurant location not found' });
  const ahead = row<{ c: number }>(
    `SELECT COUNT(*) AS c FROM waitlist_entries WHERE location_id = ? AND ${AHEAD_STATUSES}`,
    loc.id
  )!.c;
  const { estimated_wait_min, estimated_wait_label } = waitEstimate(loc.id, loc.avg_party_minutes, ahead);
  res.json({
    id: loc.id,
    name: loc.name,
    slug: loc.slug,
    restaurant_name: restaurantNameFor(loc.id),
    waitlist_enabled: Boolean(loc.waitlist_enabled),
    queue_length: ahead,
    parties_waiting: ahead,
    currently_serving: currentlyServing(loc.id),
    estimated_wait_min,
    estimated_wait_label,
    queue_prefix: loc.waitlist_prefix,
    checkin_url: checkinUrl(loc.slug || String(loc.id)),
  });
});

// ---------- Public: permanent restaurant QR (encodes the check-in URL) ----------
waitlistRouter.get('/location/:slug/qr.png', async (req, res) => {
  const loc = locationBySlug(req.params.slug);
  if (!loc) return res.status(404).json({ error: 'Restaurant location not found' });
  try {
    const buf = await qrPngBufferForUrl(checkinUrl(loc.slug || String(loc.id)));
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch {
    res.status(500).json({ error: 'Could not generate QR code' });
  }
});

// ---------- Public: entry lookup ----------
waitlistRouter.get('/token/:token', (req, res) => {
  const entry = row<EntryRow>('SELECT * FROM waitlist_entries WHERE public_token = ?', req.params.token);
  if (!entry) return res.status(404).json({ error: 'This waitlist link is invalid or expired.' });
  const loc = locationById(entry.location_id)!;
  res.json(publicEntryJson(entry, loc));
});

// ---------- Public: live updates for the customer page ----------
waitlistRouter.get('/token/:token/events', (req, res) => {
  const entry = row<EntryRow>('SELECT * FROM waitlist_entries WHERE public_token = ?', req.params.token);
  if (!entry) return res.status(404).end();
  const loc = locationById(entry.location_id)!;
  sseInit(res);
  subscribeToken(entry.public_token, res);
  sseSend(res, 'waitlist', publicEntryJson(entry, loc));
  req.on('close', () => unsubscribeToken(entry.public_token, res));
});

// ---------- Public: customer QR (encodes the tracking URL) ----------
waitlistRouter.get('/token/:token/qr.png', async (req, res) => {
  const entry = row<EntryRow>('SELECT * FROM waitlist_entries WHERE public_token = ?', req.params.token);
  if (!entry) return res.status(404).json({ error: 'This waitlist link is invalid or expired.' });
  try {
    const buf = await qrPngBufferForUrl(waitlistTrackingUrl(entry.public_token));
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch {
    res.status(500).json({ error: 'Could not generate QR code' });
  }
});

// ---------- Public: customer cancels their own wait ----------
waitlistRouter.post('/token/:token/cancel', (req, res) => {
  const entry = row<EntryRow>('SELECT * FROM waitlist_entries WHERE public_token = ?', req.params.token);
  if (!entry) return res.status(404).json({ error: 'This waitlist link is invalid or expired.' });
  try {
    const updated = doTransition(entry.id, 'CANCELLED', 'customer', 'CANCELLED');
    res.json({ ok: true, status: updated.status });
  } catch (e: any) {
    if (e instanceof HttpError) return res.status(e.code).json({ error: e.message });
    res.status(500).json({ error: 'Cancellation failed. Please try again.' });
  }
});

// ---------- Public: web-push subscription for a waitlist entry ----------
waitlistRouter.post('/notifications/subscribe', (req, res) => {
  if (!rateLimited(`wlsub:${clientIp(req)}`, 20, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  const { token, subscription, device_type } = req.body ?? {};
  if (!token || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const entry = row<EntryRow>('SELECT id FROM waitlist_entries WHERE public_token = ?', token);
  if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });
  saveWaitlistSubscription(entry.id, subscription, device_type);
  res.json({ ok: true });
});

// ---------- Staff: locations ----------
waitlistRouter.get('/admin/locations', requireAuth, (req: AuthRequest, res) => {
  const orgId = req.user!.org_id;
  const locs = (
    orgId
      ? all<LocationRow>('SELECT * FROM locations WHERE org_id = ? ORDER BY id', orgId)
      : all<LocationRow>('SELECT * FROM locations ORDER BY id')
  ).map((l) => ({
    id: l.id,
    name: l.name,
    slug: l.slug,
    restaurant_name: restaurantNameFor(l.id),
    waitlist_enabled: Boolean(l.waitlist_enabled),
    queue_prefix: l.waitlist_prefix,
    checkin_url: checkinUrl(l.slug || String(l.id)),
    active_count:
      row<{ c: number }>(
        `SELECT COUNT(*) AS c FROM waitlist_entries WHERE location_id = ? AND ${ACTIVE_STATUSES}`,
        l.id
      )!.c,
  }));
  res.json(locs);
});

// ---------- Staff: entries ----------
waitlistRouter.get('/admin/entries', requireAuth, (req: AuthRequest, res) => {
  const locationId = Number(req.query.location_id);
  if (!Number.isFinite(locationId)) return res.status(400).json({ error: 'location_id is required' });
  const status = String(req.query.status || 'active');
  let where = 'location_id = ?';
  const params: any[] = [locationId];
  let order = 'ORDER BY queue_seq';
  if (status === 'active') {
    where += ` AND ${ACTIVE_STATUSES}`;
  } else if (status === 'all') {
    order = 'ORDER BY check_in_time DESC LIMIT 200';
  } else if (TRANSITIONS[status]) {
    where += ' AND status = ?';
    params.push(status);
  } else {
    return res.status(400).json({ error: 'Invalid status filter' });
  }
  const entries = all<EntryRow>(
    `SELECT * FROM waitlist_entries WHERE ${where} ${order}`,
    ...params
  ).map(adminEntryJson);
  res.json(entries);
});

// ---------- Staff: dashboard summary ----------
waitlistRouter.get('/admin/summary', requireAuth, (req: AuthRequest, res) => {
  const locationId = Number(req.query.location_id);
  if (!Number.isFinite(locationId)) return res.status(400).json({ error: 'location_id is required' });
  const entries = all<EntryRow>(
    `SELECT * FROM waitlist_entries WHERE location_id = ? AND ${ACTIVE_STATUSES} ORDER BY queue_seq`,
    locationId
  );
  const counts: Record<string, number> = { WAITING: 0, ALMOST_READY: 0, CALLED: 0 };
  for (const e of entries) counts[e.status] = (counts[e.status] || 0) + 1;
  res.json({
    location_id: locationId,
    now_serving: currentlyServing(locationId),
    next_up: entries.filter((e) => e.status === 'WAITING').slice(0, 3).map((e) => e.queue_number),
    counts,
    entries: entries.map(adminEntryJson),
  });
});

// ---------- Staff: live feed for dashboards ----------
waitlistRouter.get('/admin/events', requireAuth, (req: AuthRequest, res) => {
  const locationId = Number(req.query.location_id);
  if (!Number.isFinite(locationId)) return res.status(400).end();
  sseInit(res);
  subscribeWaitlistLocation(locationId, res);
  sseSend(res, 'waitlist', { type: 'connected', location_id: locationId });
  req.on('close', () => unsubscribeWaitlistLocation(locationId, res));
});

// ---------- Staff: call next (oldest WAITING -> CALLED) ----------
const staffWrite = [requireAuth, requireRole('ADMIN')];

waitlistRouter.post('/admin/call-next', ...staffWrite, (req: AuthRequest, res) => {
  const locationId = Number(req.body?.location_id);
  if (!Number.isFinite(locationId)) return res.status(400).json({ error: 'location_id is required' });
  const next = row<EntryRow>(
    `SELECT * FROM waitlist_entries
     WHERE location_id = ? AND status = 'WAITING'
     ORDER BY queue_seq LIMIT 1`,
    locationId
  );
  if (!next) return res.status(404).json({ error: 'No waiting customers' });
  try {
    const updated = doTransition(next.id, 'CALLED', req.user!.username, 'CALLED');
    res.json({ id: updated.id, queue_number: updated.queue_number, status: updated.status, updated_at: updated.updated_at });
  } catch (e: any) {
    if (e instanceof HttpError) return res.status(e.code).json({ error: e.message });
    res.status(500).json({ error: 'Call failed. Please try again.' });
  }
});

// ---------- Staff: per-entry actions ----------
function staffAction(path: string, newStatus: string | null, eventType: string) {
  // Note: registered after all /admin/* and /token/* routes so ':id' never
  // shadows them.
  waitlistRouter.post(`/:id${path}`, ...staffWrite, (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid entry id' });
    try {
      if (newStatus === null) {
        // RECALL: re-notify without changing status.
        const entry = row<EntryRow>('SELECT * FROM waitlist_entries WHERE id = ?', id);
        if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });
        if (entry.status !== 'CALLED') {
          return res.status(409).json({ error: 'Only a called entry can be recalled' });
        }
        const ts = now();
        run('UPDATE waitlist_entries SET recall_count = recall_count + 1, updated_at = ? WHERE id = ?', ts, id);
        logQueueEvent(id, 'RECALLED', 'CALLED', 'CALLED', req.user!.username);
        const updated = row<EntryRow>('SELECT * FROM waitlist_entries WHERE id = ?', id)!;
        const loc = locationById(updated.location_id)!;
        broadcastWaitlistUpdate(updated.public_token, updated.location_id, publicEntryJson(updated, loc));
        notifyWaitlistStatus(
          updated.id,
          updated.queue_number,
          'RECALLED',
          updated.public_token,
          restaurantNameFor(updated.location_id)
        ).catch((e) => console.error('[waitlist] push notify failed', e?.message));
        return res.json({
          id: updated.id,
          queue_number: updated.queue_number,
          status: updated.status,
          recall_count: updated.recall_count,
          updated_at: ts,
        });
      }
      const updated = doTransition(id, newStatus, req.user!.username, eventType);
      res.json({
        id: updated.id,
        queue_number: updated.queue_number,
        status: updated.status,
        updated_at: updated.updated_at,
      });
    } catch (e: any) {
      if (e instanceof HttpError) return res.status(e.code).json({ error: e.message });
      console.error('[waitlist] action failed', e);
      res.status(500).json({ error: 'Action failed. Please try again.' });
    }
  });
}

staffAction('/almost-ready', 'ALMOST_READY', 'ALMOST_READY');
staffAction('/call', 'CALLED', 'CALLED');
staffAction('/recall', null, 'RECALLED');
staffAction('/seated', 'SEATED', 'SEATED');
staffAction('/skip', 'SKIPPED', 'SKIPPED');
staffAction('/restore', 'WAITING', 'RESTORED');
staffAction('/no-show', 'NO_SHOW', 'NO_SHOW');
staffAction('/cancel', 'CANCELLED', 'CANCELLED');
