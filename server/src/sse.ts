import type { Response } from 'express';

// token -> set of open SSE response streams (customer pages + kitchen screens)
const channels = new Map<string, Set<Response>>();
const globalListeners = new Set<Response>();

function addTo<K>(map: Map<K, Set<Response>>, key: K, res: Response) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(res);
}

function removeFrom<K>(map: Map<K, Set<Response>>, key: K, res: Response) {
  const set = map.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) map.delete(key);
}

export function subscribeToken(token: string, res: Response) {
  addTo(channels, token, res);
}

export function unsubscribeToken(token: string, res: Response) {
  removeFrom(channels, token, res);
}

export function subscribeAll(res: Response) {
  globalListeners.add(res);
}

export function unsubscribeAll(res: Response) {
  globalListeners.delete(res);
}

export function sseInit(res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
}

export function sseSend(res: Response, event: string, data: unknown) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // client disconnected; cleanup happens on 'close'
  }
}

/** Broadcast an order update to its customer page(s) and to staff screens. */
export function broadcastOrderUpdate(order: {
  id: number;
  public_token: string;
  order_number: number;
  order_status: string;
  payment_status: string;
  updated_at: string;
}) {
  const set = channels.get(order.public_token);
  if (set) {
    for (const res of set) sseSend(res, 'order', order);
  }
  for (const res of globalListeners) sseSend(res, 'order', order);
}

// ---------- Module 2: waiting-list channels ----------

// location id -> set of open SSE streams (staff waitlist dashboards)
const waitlistChannels = new Map<number, Set<Response>>();

export function subscribeWaitlistLocation(locationId: number, res: Response) {
  addTo(waitlistChannels, locationId, res);
}

export function unsubscribeWaitlistLocation(locationId: number, res: Response) {
  removeFrom(waitlistChannels, locationId, res);
}

/** Broadcast a waitlist change to the affected customer page(s) and staff screens. */
export function broadcastWaitlistUpdate(
  publicToken: string,
  locationId: number,
  payload: unknown
) {
  const set = channels.get(publicToken);
  if (set) {
    for (const res of set) sseSend(res, 'waitlist', payload);
  }
  const locSet = waitlistChannels.get(locationId);
  if (locSet) {
    for (const res of locSet) sseSend(res, 'waitlist', payload);
  }
}
