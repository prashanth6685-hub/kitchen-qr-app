/* Kitchen QR — zero-dependency client (no build step, no bundler).
   Plain ES module loaded directly by the browser. */

/* ============================== utils ============================== */

const root = document.getElementById('root');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

const TOKEN_KEY = 'kqr_staff_token';
const USER_KEY = 'kqr_staff_user';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function getUser() {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}
function saveSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(VIEW_KEY);
}

// --- role views ---
// Admins can switch between the Admin view (orders) and the Kitchen view
// (food prep) from the top-right menu, using the same login. Everyone else
// is locked to their own role.
const VIEW_KEY = 'kqr_view_role';
const VIEW_ROLES = ['ADMIN', 'KITCHEN_STAFF'];
function getViewRole() {
  const user = getUser();
  if (!user) return null;
  if (user.role !== 'ADMIN') return user.role;
  const v = localStorage.getItem(VIEW_KEY);
  return VIEW_ROLES.includes(v) ? v : user.role;
}
function setViewRole(role) {
  if (VIEW_ROLES.includes(role)) localStorage.setItem(VIEW_KEY, role);
  render();
}
function roleLabel(role) {
  return role === 'ADMIN' ? 'Admin' : 'Kitchen';
}
function displayName(username) {
  const u = String(username || '');
  return u.charAt(0).toUpperCase() + u.slice(1);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

const STATUS_LABELS = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid',
  RECEIVED: 'Order received',
  PREPARING: 'Preparing',
  READY: 'Ready',
  PARTIALLY_COMPLETED: 'Partially completed',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const STATUS_STEPS = ['RECEIVED', 'PREPARING', 'READY', 'PARTIALLY_COMPLETED', 'COMPLETED'];

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/* ============================== push ============================== */

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getPushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) return 'subscribed';
  } catch {
    return 'unsupported';
  }
  return 'available';
}

function isIOS() {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua);
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return ios || iPadOS;
}

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  );
}

async function enablePush(token, opts = {}) {
  const {
    subscribePath = '/api/notifications/subscribe',
    doneMessage = "You're all set — we'll notify you when your order is ready.",
  } = opts;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, message: 'Push notifications are not supported in this browser.' };
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, message: 'Notifications were blocked. You can still track your order on this page.' };
  }
  try {
    const keyRes = await fetch('/api/notifications/vapid-key');
    const { publicKey, enabled } = await keyRes.json();
    if (!enabled || !publicKey) {
      return { ok: false, message: 'Push is not set up on the server yet.' };
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const res = await fetch(subscribePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        subscription: sub.toJSON(),
        device_type: isIOS() ? 'ios' : 'android/other',
      }),
    });
    if (!res.ok) throw new Error('subscribe failed');
    return { ok: true, message: doneMessage };
  } catch (e) {
    console.error('[push]', e);
    return { ok: false, message: 'Could not enable notifications, but this page still updates live.' };
  }
}

// Register the service worker (needed for Web Push + PWA install).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[sw]', e));
  });
}

/* ============================== router ============================== */

let pageCleanup = null;

function go(path) {
  history.pushState({}, '', path);
  render();
}

const routes = [
  { re: /^\/$/, page: HomePage },
  { re: /^\/login$/, page: LoginPage },
  { re: /^\/order\/([^/]+)$/, page: CustomerOrderPage, params: ['token'] },
  { re: /^\/checkin\/([^/]+)$/, page: CheckinPage, params: ['slug'] },
  { re: /^\/wait\/([^/]+)$/, page: WaitlistTrackingPage, params: ['token'] },
  { re: /^\/staff$/, page: StaffDashboardPage, staff: true },
  { re: /^\/staff\/waitlist$/, page: StaffWaitlistPage, staff: true },
  { re: /^\/staff\/new$/, page: NewOrderPage, staff: true },
  { re: /^\/staff\/menu$/, page: MenuPage, staff: true },
  { re: /^\/staff\/discounts$/, page: DiscountsPage, staff: true },
  { re: /^\/staff\/orders\/(\d+)$/, page: StaffOrderDetailPage, staff: true, params: ['id'] },
  { re: /^\/kitchen$/, page: KitchenDisplayPage, staff: true },
];

function render() {
  if (pageCleanup) {
    try {
      pageCleanup();
    } catch {}
    pageCleanup = null;
  }
  const path = location.pathname;
  for (const r of routes) {
    const m = path.match(r.re);
    if (!m) continue;
    if (r.staff && !getUser()) {
      go('/login');
      return;
    }
    const params = {};
    (r.params || []).forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1]);
    });
    pageCleanup = r.page(params) || null;
    window.scrollTo(0, 0);
    return;
  }
  go('/');
}

// Client-side navigation for in-app links (skip API, downloads, new tabs).
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (
    !href ||
    !href.startsWith('/') ||
    href.startsWith('/api/') ||
    a.hasAttribute('download') ||
    a.target === '_blank' ||
    e.metaKey ||
    e.ctrlKey ||
    e.shiftKey
  ) {
    return;
  }
  e.preventDefault();
  if (href !== location.pathname + location.search) go(href);
});

window.addEventListener('popstate', render);

function topBar() {
  const user = getUser();
  if (!user) return '';
  const viewRole = getViewRole();
  const canOrder = viewRole === 'ADMIN';
  const initial = esc((user.username || '?').charAt(0).toUpperCase());
  return `
  <div class="topbar">
    <div class="brand"><span>●</span> Kitchen Orders</div>
    <nav class="mainnav">
      <a class="nav-pill nav-orders" href="/staff">Orders</a>
      ${canOrder ? '<a class="nav-pill nav-new" href="/staff/new">New</a>' : ''}
      <a class="nav-pill nav-kitchen" href="/kitchen">Kitchen</a>
      <a class="nav-pill nav-waitlist" href="/staff/waitlist">Waitlist</a>
      <div class="menu-wrap">
        <button class="user-chip" id="user-chip" aria-haspopup="true">
          <span class="avatar">${initial}</span>
          <span><span class="nm">${esc(displayName(user.username))}</span><br><span class="rl">${esc(roleLabel(viewRole))}</span></span>
        </button>
        <div class="user-menu" id="user-menu" style="display:none">
          <div class="head">
            <div class="nm">${esc(displayName(user.username))}</div>
            <div class="un">@${esc(user.username)} · ID ${esc(user.id)} · ${esc(roleLabel(user.role))}</div>
          </div>
          ${
            user.role === 'ADMIN'
              ? `<div class="sec">Switch role view</div>
                 ${VIEW_ROLES.map(
                   (r) => `<button class="role-opt${r === viewRole ? ' current' : ''}" data-view-role="${r}">
                     ${r === 'ADMIN' ? '🧾' : '👨‍🍳'} ${esc(roleLabel(r))} view
                     ${r === viewRole ? '<span class="tick">✓</span>' : ''}
                   </button>`
                 ).join('')}`
              : ''
          }
          <div class="foot">
            <button class="btn secondary block sm" id="logout-btn" style="width:100%">Log out</button>
          </div>
        </div>
      </div>
    </nav>
  </div>`;
}

function wireTopBar() {
  const chip = document.getElementById('user-chip');
  const menu = document.getElementById('user-menu');
  if (chip && menu) {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) menu.style.display = 'none';
    });
    menu.querySelectorAll('[data-view-role]').forEach((b) => {
      b.addEventListener('click', () => setViewRole(b.getAttribute('data-view-role')));
    });
  }
  const btn = document.getElementById('logout-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      clearSession();
      go('/login');
    });
  }
}

/* ============================== pages ============================== */

function HomePage() {
  const user = getUser();
  root.innerHTML = `
  ${topBar()}
  <div class="page">
    <div class="card" style="text-align:center;margin-top:40px">
      <h1>Kitchen Orders</h1>
      <p class="sub">QR-based counter ordering with live customer notifications.</p>
      <div class="btn-row" style="justify-content:center">
        ${
          user
            ? '<a class="btn" href="/staff">Staff dashboard</a><a class="btn secondary" href="/kitchen">Kitchen display</a><a class="btn secondary" href="/staff/waitlist">Waitlist</a>'
            : '<a class="btn" href="/login">Staff log in</a>'
        }
      </div>
    </div>
  </div>`;
  wireTopBar();
}

const LOGIN_HEROES = ['/img/login-hero.jpg', '/img/login-hero-2.jpg', '/img/login-hero-3.jpg', '/img/login-hero-4.jpg'];

function LoginPage() {
  const hero = LOGIN_HEROES[Math.floor(Math.random() * LOGIN_HEROES.length)];
  root.innerHTML = `
  <div class="login-wrap">
    <div class="login-hero" style="background-image:url('${hero}')">
      <div class="tag">
        <h2>From order to table,<br>without the chaos.</h2>
        <p>Live kitchen display, QR ordering & table waitlist â all in one place.</p>
      </div>
    </div>
    <div class="login-panel">
      <div class="login-logo">🍽️</div>
      <h1>Kitchen Orders</h1>
      <p class="sub">Staff sign in â admins take orders, kitchen fires them up.</p>
      <div class="error" id="login-error" style="display:none"></div>
      <form id="login-form">
        <label class="field">
          <span>Username</span>
          <input id="login-user" autocomplete="username" placeholder="e.g. admin" />
        </label>
        <label class="field">
          <span>Password</span>
          <input id="login-pass" type="password" autocomplete="current-password" placeholder="••••••••" />
        </label>
        <button class="btn block" id="login-btn" type="submit">Log in</button>
      </form>
      <div class="login-accounts">
        <b>Demo accounts</b><br>
        Admin &mdash; <b>admin / admin123</b> (takes orders, manages everything)<br>
        Kitchen &mdash; <b>kitchen / kitchen123</b> (prepares &amp; marks ready)
      </div>
      <p class="sub" style="text-align:center;margin-top:18px"><a class="link" href="/">← Back to home</a></p>
    </div>
  </div>`;

  const form = document.getElementById('login-form');
  const errBox = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Signing in…';
    errBox.style.display = 'none';
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('login-user').value,
          password: document.getElementById('login-pass').value,
        }),
      });
      saveSession(data.token, data.user);
      go('/staff');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Log in';
    }
  });
}

/* ------------------------- staff dashboard ------------------------- */

const DASH_TABS = [
  { id: 'pending', label: 'Pending', statuses: ['PENDING_PAYMENT', 'PAID', 'RECEIVED', 'PREPARING', 'READY', 'PARTIALLY_COMPLETED'] },
  { id: 'completed', label: 'Completed', statuses: ['COMPLETED'] },
  { id: 'cancelled', label: 'Cancelled', statuses: ['CANCELLED'] },
];

function StaffDashboardPage() {
  const user = getUser();
  const canOrder = getViewRole() === 'ADMIN';
  let orders = [];
  let tab = 'pending';
  let q = '';
  let error = null;
  let debounce = null;
  let lastSig = '';

  function tabStatuses(id) {
    return (DASH_TABS.find((t) => t.id === id) || DASH_TABS[0]).statuses;
  }

  async function load() {
    try {
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (q.trim()) params.set('q', q.trim());
      const all = await api(`/api/orders?${params}`);
      const want = tabStatuses(tab);
      orders = all.filter((o) => want.includes(o.order_status));
      error = null;
    } catch (e) {
      error = e.message;
    }
    const sig = JSON.stringify({ orders, error, tab });
    if (sig !== lastSig) {
      lastSig = sig;
      renderList();
      renderTabs();
    }
  }

  function renderList() {
    const box = document.getElementById('orders-list');
    if (!box) return;
    let html = '';
    if (error) html += `<div class="error">${esc(error)}</div>`;
    if (orders.length === 0) {
      html += '<div class="empty">No orders found.</div>';
    } else {
      html += `<table class="orders"><thead><tr>
        <th>Order</th><th>Customer</th><th>Items</th><th>Total</th>
        <th>Payment</th><th>Status</th><th>Time</th>
      </tr></thead><tbody>`;
      for (const o of orders) {
        html += `<tr data-id="${o.id}">
          <td><b>#${o.order_number}</b></td>
          <td>${esc(o.customer_name || '—')}</td>
          <td>${o.item_count}</td>
          <td>${money(o.total_cents)}</td>
          <td><span class="badge ${o.payment_status === 'PAID' ? 'READY' : 'PENDING_PAYMENT'}">${esc(o.payment_status)}</span></td>
          <td><span class="badge ${esc(o.order_status)}">${esc(o.order_status.replace('_', ' '))}</span></td>
          <td>${timeOf(o.created_at)}</td>
        </tr>`;
      }
      html += '</tbody></table>';
    }
    box.innerHTML = html;
    box.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => go(`/staff/orders/${tr.dataset.id}`));
    });
  }

  async function tabCounts() {
    try {
      const all = await api('/api/orders?limit=200');
      const counts = {};
      for (const t of DASH_TABS) counts[t.id] = all.filter((o) => t.statuses.includes(o.order_status)).length;
      return counts;
    } catch {
      return {};
    }
  }

  async function renderTabs() {
    const bar = document.getElementById('filter-chips');
    if (!bar) return;
    const counts = await tabCounts();
    bar.className = 'tabs';
    bar.innerHTML = DASH_TABS.map(
      (t) =>
        `<button class="tab${tab === t.id ? ' active' : ''}" data-t="${t.id}">${esc(t.label)}<span class="count">${counts[t.id] ?? ''}</span></button>`
    ).join('');
    bar.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        tab = b.dataset.t;
        lastSig = '';
        load();
      });
    });
  }

  root.innerHTML = `
  ${topBar()}
  <div class="page wide">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <h1>Orders</h1>
      <div class="btn-row" style="margin:0">
        ${canOrder ? '<a class="btn secondary" href="/staff/menu">Menu</a>' : ''}
        ${canOrder ? '<a class="btn secondary" href="/staff/discounts">Discounts</a>' : ''}
        ${canOrder ? '<a class="btn" href="/staff/new">New order</a>' : ''}
      </div>
    </div>
    <div class="filterbar">
      <input class="search" id="dash-q" placeholder="Search name or order #…" />
    </div>
    <div class="filterbar" id="filter-chips"></div>
    <div class="card" style="padding:8px"><div id="orders-list"></div></div>
  </div>`;
  wireTopBar();
  renderTabs();

  document.getElementById('dash-q').addEventListener('input', (e) => {
    q = e.target.value;
    clearTimeout(debounce);
    debounce = setTimeout(load, 350);
  });

  load();
  const t = window.setInterval(load, 4000);
  let es = null;
  try {
    es = new EventSource(`/api/orders/events?token=${encodeURIComponent(getToken() || '')}`);
    es.addEventListener('order', () => load());
    es.onerror = () => es && es.close();
  } catch {
    /* polling covers it */
  }

  return () => {
    window.clearInterval(t);
    clearTimeout(debounce);
    if (es) es.close();
  };
}

/* ------------------------- new order ------------------------- */

function NewOrderPage() {
  let menu = [];
  let lines = {};
  let customLines = [];
  let error = null;
  let busy = false;
  let created = null;

  async function init() {
    try {
      menu = await api('/api/menu');
    } catch (e) {
      error = e.message;
    }
    render();
  }

  function items() {
    const fromMenu = menu
      .filter((m) => lines[m.id])
      .map((m) => ({ name: m.name, qty: lines[m.id], unit_price: m.price }));
    return [...fromMenu, ...customLines];
  }
  function total() {
    return items().reduce((s, i) => s + i.qty * i.unit_price, 0);
  }

  function setError(msg) {
    error = msg;
    const box = document.getElementById('form-error');
    if (!box) return;
    if (msg) {
      box.textContent = msg;
      box.style.display = 'block';
    } else {
      box.style.display = 'none';
    }
  }

  function render() {
    if (created) return renderCreated();

    const list = items();
    const tot = total();
    root.innerHTML = `
    ${topBar()}
    <div class="page">
      <h1>New order</h1>
      <p class="sub">Enter the customer's items, then take payment.</p>
      <div class="error" id="form-error" style="display:${error ? 'block' : 'none'}">${esc(error || '')}</div>

      <div class="card">
        <h2>Menu</h2>
        <div class="menu-grid">
          ${menu
            .map(
              (m) => `
            <div class="menu-item">
              <div><div class="name">${esc(m.name)}</div><div class="price">${money(m.price)}</div></div>
              <div class="qty">
                <button data-dec="${m.id}" aria-label="decrease">−</button>
                <b>${lines[m.id] || 0}</b>
                <button data-inc="${m.id}" aria-label="increase">+</button>
              </div>
            </div>`
            )
            .join('')}
        </div>
      </div>

      <div class="card">
        <h2>Custom item</h2>
        <div style="display:flex;gap:8px">
          <input id="custom-name" placeholder="Item name" />
          <input id="custom-price" placeholder="$0.00" inputmode="decimal" style="max-width:120px" />
          <button class="btn secondary" id="custom-add">Add</button>
        </div>
        <div id="custom-lines">
          ${customLines
            .map(
              (l, i) => `
            <div class="item-row">
              <span>${esc(l.name)} <b>×${l.qty}</b></span>
              <span>${money(l.qty * l.unit_price)} <button class="link" data-rm="${i}" style="border:none;background:none;cursor:pointer">remove</button></span>
            </div>`
            )
            .join('')}
        </div>
      </div>

      <div class="card">
        <h2>Customer</h2>
        <label class="field"><span>Name (optional)</span><input id="cust-name" /></label>
        <label class="field"><span>Phone (optional)</span><input id="cust-phone" inputmode="tel" /></label>
        <label class="field"><span>Special instructions</span><textarea id="cust-notes" rows="2" placeholder="e.g. less spicy"></textarea></label>
      </div>

      <div class="card">
        <div class="total-row"><span>Total</span><span>${money(tot)}</span></div>
        <div class="btn-row">
          <button class="btn block" id="create-btn" ${busy || list.length === 0 ? 'disabled' : ''}>
            ${busy ? 'Creating…' : `Create order · ${money(tot)}`}
          </button>
        </div>
      </div>
    </div>`;
    wireTopBar();

    // Keep the customer fields the user already typed across re-renders.
    root.querySelectorAll('[data-dec]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = Number(b.dataset.dec);
        const v = (lines[id] || 0) - 1;
        if (v <= 0) delete lines[id];
        else lines[id] = v;
        preserveAndRender();
      })
    );
    root.querySelectorAll('[data-inc]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = Number(b.dataset.inc);
        lines[id] = (lines[id] || 0) + 1;
        preserveAndRender();
      })
    );
    document.getElementById('custom-add').addEventListener('click', () => {
      const name = document.getElementById('custom-name').value.trim();
      const price = Math.round(Number(document.getElementById('custom-price').value) * 100);
      if (!name || !Number.isFinite(price) || price < 0) {
        setError('Enter a valid custom item name and price.');
        return;
      }
      customLines.push({ name, qty: 1, unit_price: price });
      setError(null);
      preserveAndRender();
    });
    root.querySelectorAll('[data-rm]').forEach((b) =>
      b.addEventListener('click', () => {
        customLines = customLines.filter((_, j) => j !== Number(b.dataset.rm));
        preserveAndRender();
      })
    );
    document.getElementById('create-btn').addEventListener('click', submit);
  }

  // Re-render without losing typed customer fields / custom inputs.
  function preserveAndRender() {
    const keep = {};
    for (const id of ['cust-name', 'cust-phone', 'cust-notes', 'custom-name', 'custom-price']) {
      const el = document.getElementById(id);
      if (el) keep[id] = el.value;
    }
    render();
    for (const [id, v] of Object.entries(keep)) {
      const el = document.getElementById(id);
      if (el) el.value = v;
    }
  }

  async function submit() {
    const list = items();
    if (list.length === 0) {
      setError('Add at least one item.');
      return;
    }
    busy = true;
    setError(null);
    const payload = {
      customer_name: document.getElementById('cust-name').value.trim() || undefined,
      customer_phone: document.getElementById('cust-phone').value.trim() || undefined,
      special_instructions: document.getElementById('cust-notes').value.trim() || undefined,
      items: list.map((i) => ({ name: i.name, qty: i.qty, unit_price: i.unit_price })),
    };
    render();
    try {
      created = await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
      busy = false;
      render();
    } catch (e) {
      busy = false;
      error = e.message;
      preserveAndRender();
    }
  }

  async function collectPayment(kind) {
    if (!created) return;
    busy = true;
    setError(null);
    render();
    try {
      await api(`/api/orders/${created.id}/payments/${kind}`, { method: 'POST' });
      go(`/staff/orders/${created.id}`);
    } catch (e) {
      busy = false;
      error = e.message;
      render();
    }
  }

  function renderCreated() {
    root.innerHTML = `
    ${topBar()}
    <div class="page">
      <div class="card" style="text-align:center;margin-top:24px">
        <h1>Order #${created.order_number}</h1>
        <div class="big" style="font-size:34px;font-weight:800;margin:8px 0">${money(created.total_cents)}</div>
        <p class="sub">Collect payment, then show the customer the QR code.</p>
        <div class="error" id="form-error" style="display:${error ? 'block' : 'none'}">${esc(error || '')}</div>
        <div class="btn-row">
          ${
            created.checkout_url
              ? `<a class="btn" href="${esc(created.checkout_url)}" target="_blank" rel="noreferrer">💳 Pay by card (Stripe)</a>`
              : ''
          }
          <button class="btn" id="pay-cash" ${busy ? 'disabled' : ''}>💵 Cash received</button>
          ${
            created.demo_payments
              ? `<button class="btn warn" id="pay-demo" ${busy ? 'disabled' : ''}>🧪 Demo card payment</button>`
              : ''
          }
        </div>
        ${
          !created.stripe_configured
            ? `<p class="sub" style="margin-top:12px">Stripe isn't configured — add STRIPE_SECRET_KEY to accept real card payments.</p>`
            : ''
        }
        <div class="btn-row" style="margin-top:16px">
          <a class="btn secondary" href="/staff/orders/${created.id}">View order →</a>
        </div>
      </div>
    </div>`;
    wireTopBar();
    document.getElementById('pay-cash').addEventListener('click', () => collectPayment('cash'));
    const demo = document.getElementById('pay-demo');
    if (demo) demo.addEventListener('click', () => collectPayment('demo'));
  }

  init();
}

/* ------------------------- menu management (admin) ------------------------- */

function MenuPage() {
  if (getViewRole() !== 'ADMIN') {
    go('/staff');
    return () => {};
  }
  let items = [];
  let error = null;
  let busy = false;
  let notice = null;
  let editingId = null;
  let lastSig = '';

  async function load() {
    try {
      const data = await api('/api/menu');
      error = null;
      const sig = JSON.stringify(data);
      if (sig !== lastSig) {
        lastSig = sig;
        items = data;
        render();
      }
    } catch (e) {
      error = e.message;
      render();
    }
  }

  function showNotice(msg) {
    notice = msg;
    render();
    window.setTimeout(() => {
      notice = null;
      const box = document.getElementById('menu-notice');
      if (box) box.style.display = 'none';
    }, 3000);
  }

  async function addItem() {
    const nameEl = document.getElementById('menu-new-name');
    const priceEl = document.getElementById('menu-new-price');
    const name = nameEl.value.trim().slice(0, 120);
    const price = Math.round(Number(priceEl.value) * 100);
    if (!name || !Number.isFinite(price) || price < 0) {
      error = 'Enter an item name and a valid price.';
      render();
      return;
    }
    busy = true;
    error = null;
    render();
    try {
      await api('/api/menu', { method: 'POST', body: JSON.stringify({ name, price_cents: price }) });
      busy = false;
      lastSig = '';
      showNotice(`"${name}" added to the menu.`);
      await load();
    } catch (e) {
      busy = false;
      error = e.message;
      render();
    }
  }

  async function saveEdit(id) {
    const nameEl = document.getElementById(`menu-edit-name-${id}`);
    const priceEl = document.getElementById(`menu-edit-price-${id}`);
    const name = nameEl.value.trim().slice(0, 120);
    const price = Math.round(Number(priceEl.value) * 100);
    if (!name || !Number.isFinite(price) || price < 0) {
      error = 'Enter a valid name and price.';
      render();
      return;
    }
    busy = true;
    error = null;
    render();
    try {
      await api(`/api/menu/${id}`, { method: 'PUT', body: JSON.stringify({ name, price_cents: price }) });
      busy = false;
      editingId = null;
      lastSig = '';
      showNotice('Menu item updated.');
      await load();
    } catch (e) {
      busy = false;
      error = e.message;
      render();
    }
  }

  async function deleteItem(id, name) {
    if (!window.confirm(`Remove "${name}" from the menu?`)) return;
    busy = true;
    render();
    try {
      await api(`/api/menu/${id}`, { method: 'DELETE' });
      busy = false;
      lastSig = '';
      showNotice(`"${name}" removed.`);
      await load();
    } catch (e) {
      busy = false;
      error = e.message;
      render();
    }
  }

  function render() {
    root.innerHTML = `
    ${topBar()}
    <div class="page">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h1>Menu</h1>
        <a class="btn secondary" href="/staff">← Orders</a>
      </div>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      <div class="ok" id="menu-notice" style="display:${notice ? 'block' : 'none'}">${esc(notice || '')}</div>

      <div class="card">
        <h2>Add item</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input id="menu-new-name" placeholder="Item name" style="flex:2;min-width:140px" />
          <input id="menu-new-price" placeholder="$0.00" inputmode="decimal" style="flex:1;min-width:100px" />
          <button class="btn" id="menu-add" ${busy ? 'disabled' : ''}>${busy ? 'Adding…' : 'Add'}</button>
        </div>
      </div>

      <div class="card">
        <h2>Items (${items.length})</h2>
        ${items.length === 0 ? '<div class="empty">No menu items yet — add your first one above.</div>' : ''}
        ${items
          .map((m) =>
            editingId === m.id
              ? `
            <div class="item-row" style="align-items:center">
              <span style="flex:2;display:flex;gap:8px">
                <input id="menu-edit-name-${m.id}" value="${esc(m.name)}" style="flex:2" />
                <input id="menu-edit-price-${m.id}" value="${(m.price / 100).toFixed(2)}" inputmode="decimal" style="flex:1;max-width:110px" />
              </span>
              <span class="btn-row" style="margin:0">
                <button class="btn secondary" data-menu-save="${m.id}">Save</button>
                <button class="btn secondary" data-menu-cancel>Cancel</button>
              </span>
            </div>`
              : `
            <div class="item-row" style="align-items:center">
              <span><b>${esc(m.name)}</b> <span class="sub">${money(m.price)}</span></span>
              <span class="btn-row" style="margin:0">
                <button class="btn secondary" data-menu-edit="${m.id}">Edit</button>
                <button class="btn secondary" data-menu-del="${m.id}" data-menu-name="${esc(m.name)}">Delete</button>
              </span>
            </div>`
          )
          .join('')}
      </div>
    </div>`;
    wireTopBar();

    document.getElementById('menu-add').addEventListener('click', addItem);
    root.querySelectorAll('[data-menu-edit]').forEach((b) =>
      b.addEventListener('click', () => {
        editingId = Number(b.dataset.menuEdit);
        render();
      })
    );
    root.querySelectorAll('[data-menu-cancel]').forEach((b) =>
      b.addEventListener('click', () => {
        editingId = null;
        render();
      })
    );
    root.querySelectorAll('[data-menu-save]').forEach((b) =>
      b.addEventListener('click', () => saveEdit(Number(b.dataset.menuSave)))
    );
    root.querySelectorAll('[data-menu-del]').forEach((b) =>
      b.addEventListener('click', () => deleteItem(Number(b.dataset.menuDel), b.dataset.menuName))
    );
  }

  load();
  return () => {};
}

/* ------------------------- staff discount codes ------------------------- */

function DiscountsPage() {
  if (getViewRole() !== 'ADMIN') {
    go('/staff');
    return () => {};
  }
  let codes = [];
  let menu = [];
  let error = null;
  let busy = false;
  let notice = null;
  let editingId = null;
  let lastSig = '';

  async function load() {
    try {
      const [dc, m] = await Promise.all([api('/api/discount-codes'), api('/api/menu')]);
      error = null;
      const sig = JSON.stringify(dc);
      if (sig !== lastSig) {
        lastSig = sig;
        codes = dc;
        menu = m;
        render();
      }
    } catch (e) {
      error = e.message;
      render();
    }
  }

  function showNotice(msg) {
    notice = msg;
    render();
    window.setTimeout(() => {
      notice = null;
      const box = document.getElementById('dc-notice');
      if (box) box.style.display = 'none';
    }, 3000);
  }

  // Reads {code, label, menu_item_id, amount_cents, percent_off, active} from a
  // form prefixed `pfx`. Returns null + sets error on invalid input.
  function readForm(pfx) {
    const code = document.getElementById(`${pfx}-code`).value.trim();
    const label = document.getElementById(`${pfx}-label`).value.trim().slice(0, 120);
    const itemSel = document.getElementById(`${pfx}-item`).value;
    const type = document.getElementById(`${pfx}-type`).value;
    const val = Number(document.getElementById(`${pfx}-val`).value);
    const active = document.getElementById(`${pfx}-active`).checked;
    if (!code) {
      error = 'Enter a discount code.';
      return null;
    }
    let amount_cents = null;
    let percent_off = null;
    if (type === 'fixed') {
      amount_cents = Math.round(val * 100);
      if (!Number.isFinite(amount_cents) || amount_cents <= 0) {
        error = 'Enter a valid dollar amount.';
        return null;
      }
    } else {
      percent_off = Math.round(val);
      if (!Number.isFinite(percent_off) || percent_off < 1 || percent_off > 100) {
        error = 'Enter a percentage between 1 and 100.';
        return null;
      }
    }
    return {
      code,
      label,
      menu_item_id: itemSel ? Number(itemSel) : null,
      amount_cents,
      percent_off,
      active,
    };
  }

  async function addCode() {
    error = null;
    const body = readForm('dc-new');
    if (!body) {
      render();
      return;
    }
    busy = true;
    render();
    try {
      await api('/api/discount-codes', { method: 'POST', body: JSON.stringify(body) });
      busy = false;
      lastSig = '';
      showNotice(`Code ${body.code.toUpperCase()} added.`);
      await load();
    } catch (e) {
      busy = false;
      error = e.message;
      render();
    }
  }

  async function saveEdit(id) {
    error = null;
    const body = readForm(`dc-edit-${id}`);
    if (!body) {
      render();
      return;
    }
    busy = true;
    render();
    try {
      await api(`/api/discount-codes/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      busy = false;
      editingId = null;
      lastSig = '';
      showNotice('Discount code updated.');
      await load();
    } catch (e) {
      busy = false;
      error = e.message;
      render();
    }
  }

  async function toggleActive(id, active) {
    busy = true;
    render();
    try {
      await api(`/api/discount-codes/${id}`, { method: 'PUT', body: JSON.stringify({ active }) });
      busy = false;
      lastSig = '';
      showNotice(active ? 'Code published.' : 'Code unpublished.');
      await load();
    } catch (e) {
      busy = false;
      error = e.message;
      render();
    }
  }

  async function deleteCode(id, code) {
    if (!window.confirm(`Delete discount code "${code}"? Past orders keep their applied discounts.`)) return;
    busy = true;
    render();
    try {
      await api(`/api/discount-codes/${id}`, { method: 'DELETE' });
      busy = false;
      lastSig = '';
      showNotice(`"${code}" deleted.`);
      await load();
    } catch (e) {
      busy = false;
      error = e.message;
      render();
    }
  }

  function itemOptions(selected) {
    return `<option value="">Any item</option>` + menu
      .map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)}</option>`)
      .join('');
  }

  function formFields(pfx, d) {
    const code = d?.code ?? '';
    const label = d?.label ?? '';
    const sel = d?.menu_item_id ?? null;
    const isFixed = d ? d.amount_cents != null : true;
    const val = d ? (isFixed ? (d.amount_cents / 100).toFixed(2) : d.percent_off) : '';
    const active = d ? d.active : true;
    return `
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="${pfx}-code" placeholder="CODE (e.g. BIRYANI5)" autocapitalize="characters"
          style="flex:1;min-width:120px;text-transform:uppercase" value="${esc(code)}" />
        <input id="${pfx}-label" placeholder="Label (optional)" style="flex:1;min-width:140px" value="${esc(label)}" />
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <select id="${pfx}-item" style="flex:2;min-width:140px">${itemOptions(sel)}</select>
        <select id="${pfx}-type" style="flex:1;min-width:110px">
          <option value="fixed" ${isFixed ? 'selected' : ''}>$ off / item</option>
          <option value="percent" ${isFixed ? '' : 'selected'}>% off</option>
        </select>
        <input id="${pfx}-val" placeholder="Amount" inputmode="decimal" style="flex:1;min-width:90px" value="${val}" />
        <label class="sub" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="${pfx}-active" ${active ? 'checked' : ''} /> Active
        </label>
      </div>`;
  }

  function codeDesc(d) {
    const val = d.amount_cents != null ? `${money(d.amount_cents)} off` : `${d.percent_off}% off`;
    return `${val} · ${d.menu_item_name ? esc(d.menu_item_name) : 'any item'}`;
  }

  function render() {
    root.innerHTML = `
    ${topBar()}
    <div class="page">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h1>Discount codes</h1>
        <a class="btn secondary" href="/staff">← Orders</a>
      </div>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      <div class="ok" id="dc-notice" style="display:${notice ? 'block' : 'none'}">${esc(notice || '')}</div>
      <p class="sub">Codes apply per item at payment time — e.g. <b>BIRYANI5</b> takes $5 off each Chicken Biryani. Uncheck "Active" to unpublish a code without deleting it.</p>

      <div class="card">
        <h2>Add code</h2>
        ${formFields('dc-new')}
        <div class="btn-row">
          <button class="btn" id="dc-add" ${busy ? 'disabled' : ''}>${busy ? 'Adding…' : 'Add'}</button>
        </div>
      </div>

      <div class="card">
        <h2>Codes (${codes.length})</h2>
        ${codes.length === 0 ? '<div class="empty">No discount codes yet — add your first one above.</div>' : ''}
        ${codes
          .map((d) =>
            editingId === d.id
              ? `
            <div style="margin-bottom:14px">
              ${formFields(`dc-edit-${d.id}`, d)}
              <div class="btn-row" style="margin:8px 0 0">
                <button class="btn secondary" data-dc-save="${d.id}">Save</button>
                <button class="btn secondary" data-dc-cancel>Cancel</button>
              </div>
            </div>`
              : `
            <div class="item-row" style="align-items:center">
              <span>
                <b>🏷 ${esc(d.code)}</b> ${d.active ? '' : '<span class="sub">(inactive)</span>'}<br />
                <span class="sub">${codeDesc(d)}${d.label ? ` · ${esc(d.label)}` : ''}</span>
              </span>
              <span class="btn-row" style="margin:0">
                <button class="btn secondary" data-dc-toggle="${d.id}" data-dc-active="${d.active ? 0 : 1}">${d.active ? 'Unpublish' : 'Publish'}</button>
                <button class="btn secondary" data-dc-edit="${d.id}">Edit</button>
                <button class="btn secondary" data-dc-del="${d.id}" data-dc-code="${esc(d.code)}">Delete</button>
              </span>
            </div>`
          )
          .join('')}
      </div>
    </div>`;
    wireTopBar();

    document.getElementById('dc-add').addEventListener('click', addCode);
    root.querySelectorAll('[data-dc-edit]').forEach((b) =>
      b.addEventListener('click', () => {
        editingId = Number(b.dataset.dcEdit);
        render();
      })
    );
    root.querySelectorAll('[data-dc-cancel]').forEach((b) =>
      b.addEventListener('click', () => {
        editingId = null;
        render();
      })
    );
    root.querySelectorAll('[data-dc-save]').forEach((b) =>
      b.addEventListener('click', () => saveEdit(Number(b.dataset.dcSave)))
    );
    root.querySelectorAll('[data-dc-toggle]').forEach((b) =>
      b.addEventListener('click', () => toggleActive(Number(b.dataset.dcToggle), b.dataset.dcActive === '1'))
    );
    root.querySelectorAll('[data-dc-del]').forEach((b) =>
      b.addEventListener('click', () => deleteCode(Number(b.dataset.dcDel), b.dataset.dcCode))
    );
  }

  load();
  return () => {};
}

/* ------------------------- staff order detail ------------------------- */

function StaffOrderDetailPage({ id }) {
  let order = null;
  let error = null;
  let busy = false;
  let notice = null;
  let lastSig = '';
  let editLines = null; // local editable copy of items (admin, pending orders only)
  let editNotes = null; // local editable copy of special instructions
  let discBusy = false;
  let itemDisc = null; // local editable copy of per-item discounts (admin, at payment time)

  async function load() {
    try {
      const data = await api(`/api/orders/${id}`);
      error = null;
      const sig = JSON.stringify(data);
      if (sig !== lastSig) {
        lastSig = sig;
        order = data;
        editLines = null; // re-init from fresh order data on render
        editNotes = null;
        itemDisc = null;
        render();
      }
    } catch (e) {
      error = e.message;
      render();
    }
  }

  function showNotice(msg) {
    notice = msg;
    const box = document.getElementById('detail-notice');
    if (box) {
      box.textContent = msg;
      box.style.display = 'block';
    }
  }

  async function pay(kind) {
    busy = true;
    error = null;
    render();
    try {
      if (kind === 'stripe') {
        const data = await api(`/api/orders/${id}/payments/stripe`, { method: 'POST' });
        window.open(data.checkout_url, '_blank', 'noopener');
        showNotice('Stripe Checkout opened — the QR code appears here once payment is confirmed.');
        busy = false;
        render();
        return;
      }
      const data = await api(`/api/orders/${id}/payments/${kind}`, { method: 'POST' });
      if (data.warning) notice = data.warning;
      busy = false;
      await load();
    } catch (e) {
      busy = false;
      error = e.message;
      render();
    }
  }

  function copyLink() {
    const done = (msg) => showNotice(msg);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(order.tracking_url).then(
        () => done('Tracking link copied.'),
        () => done(order.tracking_url)
      );
    } else {
      done(order.tracking_url);
    }
  }

  const isAdmin = () => getViewRole() === 'ADMIN';
  const editable = () => isAdmin() && order && ['PENDING_PAYMENT', 'PAID', 'RECEIVED'].includes(order.order_status);

  function editInit() {
    if (editLines === null && order) {
      editLines = order.items.map((it) => ({
        name: it.item_name,
        qty: it.quantity,
        unit_price: it.unit_price_cents,
        discount_cents: it.discount_cents || 0,
        discount_code: it.discount_code || null,
        code_discount_cents: it.code_discount_cents || 0,
      }));
    }
    return editLines || [];
  }
  function editTotal() {
    return editInit().reduce((sum, l) => {
      const gross = l.qty * l.unit_price;
      const disc = (l.discount_cents || 0) + (l.code_discount_cents || 0);
      return sum + gross - Math.min(disc, gross);
    }, 0);
  }

  function editCardHTML() {
    if (!editable()) {
      return order && isAdmin() && !['PENDING_PAYMENT', 'PAID', 'RECEIVED', 'CANCELLED'].includes(order.order_status)
        ? '<div class="card"><div class="info">🔒 The kitchen has started preparing this order — items can no longer be edited.</div></div>'
        : '';
    }
    const lines = editInit();
    return `
      <div class="card">
        <h2>Edit items</h2>
        <div id="edit-lines">
          ${lines
            .map(
              (l, i) => `
            <div class="item-row">
              <span>${esc(l.name)} <span class="sub">${money(l.unit_price)} each</span></span>
              <span class="qty">
                <button data-edit-dec="${i}" aria-label="decrease">−</button>
                <b>${l.qty}</b>
                <button data-edit-inc="${i}" aria-label="increase">+</button>
                <button data-edit-del="${i}" aria-label="remove" style="margin-left:6px">×</button>
              </span>
            </div>`
            )
            .join('') || '<div class="empty">No items.</div>'}
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <input id="edit-add-name" placeholder="Item name" style="flex:2;min-width:120px" />
          <input id="edit-add-price" placeholder="$0.00" inputmode="decimal" style="flex:1;min-width:90px" />
          <button class="btn secondary" id="edit-add">Add</button>
        </div>
        <div style="margin-top:10px">
          <label class="field"><span>Special instructions</span><textarea id="edit-notes" rows="2" placeholder="e.g. less spicy, no onions">${esc(editNotes ?? order.special_instructions ?? '')}</textarea></label>
        </div>
        <div class="btn-row" style="margin-top:12px;align-items:center">
          <button class="btn" id="edit-save" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save changes'}</button>
          <span class="sub">New total: <b>${money(Math.max(0, editTotal() - (order.discount_cents || 0)))}</b></span>
        </div>
      </div>`;
  }

  // Per-item discounts (manual $ off + discount codes), editable at payment time.
  function itemDiscInit() {
    if (itemDisc === null && order) {
      itemDisc = order.items.map((it) => ({
        name: it.item_name,
        qty: it.quantity,
        unit: it.unit_price_cents,
        manual: it.discount_cents || 0,
        code: it.discount_code || null,
        codeDisc: it.code_discount_cents || 0,
        codeErr: null,
      }));
    }
    return itemDisc || [];
  }

  function discountHTML() {
    if (!isAdmin()) return '';
    const lines = itemDiscInit();
    return `
        <div style="margin-top:14px;padding-top:12px;border-top:1px dashed #e5d9c8">
          <h3 style="margin:0 0 8px">Item discounts</h3>
          ${lines
            .map(
              (l, i) => `
            <div style="margin-bottom:12px">
              <div class="item-row" style="padding-bottom:2px">
                <span>${esc(l.name)} <b>×${l.qty}</b></span>
                <span>${money(l.qty * l.unit)}</span>
              </div>
              ${
                l.code
                  ? `<div class="item-row" style="padding-top:0;align-items:center">
                       <span class="sub">Discount (${esc(l.code)}) −${money(l.codeDisc)}</span>
                       <button class="btn secondary sm" data-disc-code-rm="${i}">Remove</button>
                     </div>`
                  : ''
              }
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
                <input id="disc-manual-${i}" placeholder="$ off" inputmode="decimal"
                  style="max-width:100px" value="${l.manual ? (l.manual / 100).toFixed(2) : ''}" />
                <input id="disc-code-${i}" placeholder="CODE" autocapitalize="characters"
                  style="max-width:120px;text-transform:uppercase" />
                <button class="btn secondary sm" data-disc-code-apply="${i}" ${discBusy ? 'disabled' : ''}>Apply code</button>
              </div>
              ${l.codeErr ? `<div class="error" style="margin:6px 0 0">${esc(l.codeErr)}</div>` : ''}
            </div>`
            )
            .join('')}
          <div class="btn-row" style="margin-top:4px">
            <button class="btn" id="disc-items-save" ${discBusy ? 'disabled' : ''}>${discBusy ? 'Saving…' : 'Save item discounts'}</button>
          </div>
          <h3 style="margin:14px 0 8px">Order discount</h3>
          ${order.discount_cents > 0 ? `<p class="sub">Current discount: <b>${money(order.discount_cents)}</b></p>` : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input id="disc-amt" type="number" min="0" step="0.01" inputmode="decimal"
              placeholder="$0.00" style="max-width:140px"
              value="${order.discount_cents ? (order.discount_cents / 100).toFixed(2) : ''}" />
            <button class="btn secondary" id="disc-apply" ${discBusy ? 'disabled' : ''}>${discBusy ? 'Applying…' : 'Apply discount'}</button>
            ${order.discount_cents > 0 ? '<button class="btn secondary" id="disc-clear">Remove</button>' : ''}
          </div>
        </div>`;
  }

  async function saveItemDiscounts() {
    const lines = itemDiscInit().map((l, i) => {
      const manualEl = document.getElementById(`disc-manual-${i}`);
      const manual = manualEl ? Math.max(0, Math.round(Number(manualEl.value) * 100) || 0) : l.manual;
      return {
        name: l.name, qty: l.qty, unit_price: l.unit,
        discount_cents: manual,
        discount_code: l.code,
      };
    });
    discBusy = true;
    error = null;
    render();
    try {
      await api(`/api/orders/${order.id}/items`, { method: 'PATCH', body: JSON.stringify({ items: lines }) });
      discBusy = false;
      itemDisc = null;
      showNotice('Item discounts saved.');
      await load();
    } catch (e) {
      discBusy = false;
      error = e.message;
      render();
    }
  }

  function render() {
    if (error && !order) {
      root.innerHTML = `${topBar()}<div class="page"><div class="error">${esc(error)}</div></div>`;
      wireTopBar();
      return;
    }
    if (!order) {
      root.innerHTML = `${topBar()}<div class="page"><div class="card empty">Loading…</div></div>`;
      wireTopBar();
      return;
    }

    const paid = order.payment_status === 'PAID';
    // <img> can't send Authorization headers, so the staff token rides in the query string.
    const qrSrc = `/api/orders/${order.id}/qr.png?token=${encodeURIComponent(getToken() || '')}`;

    root.innerHTML = `
    ${topBar()}
    <div class="page">
      <h1>Order #${order.order_number}</h1>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      <div class="ok" id="detail-notice" style="display:${notice ? 'block' : 'none'}">${esc(notice || '')}</div>

      <div class="card">
        <div class="btn-row" style="margin-top:0;margin-bottom:12px;align-items:center">
          <span class="badge ${esc(order.order_status)}" style="font-size:16px;padding:8px 18px">${esc(STATUS_LABELS[order.order_status] || order.order_status)}</span>
          <span class="sub">${paid ? '✅ Paid' : '⏳ Unpaid'}</span>
        </div>
        ${order.items
          .map(
            (it) => {
              const lineDisc = (it.discount_cents || 0) + (it.code_discount_cents || 0);
              return `
          <div class="item-row">
            <span>${esc(it.item_name)} <b>×${it.quantity}</b></span>
            <span>${money(it.total_price_cents)}</span>
          </div>${
            lineDisc > 0
              ? `<div class="item-row" style="padding-top:0"><span class="sub">${
                  it.discount_code ? `Discount (${esc(it.discount_code)})` : 'Item discount'
                }</span><span class="sub">−${money(lineDisc)}</span></div>`
              : ''
          }`;
            }
          )
          .join('')}
        ${order.discount_cents > 0 ? `<div class="item-row"><span>Order discount</span><span>−${money(order.discount_cents)}</span></div>` : ''}
        <div class="total-row"><span>Total</span><span>${money(order.total_cents)}</span></div>
        <div class="sub" style="margin-top:10px">
          ${order.customer_name ? `<div>Customer: ${esc(order.customer_name)}</div>` : ''}
          ${order.customer_phone ? `<div>Phone: ${esc(order.customer_phone)}</div>` : ''}
          ${order.special_instructions ? `<div>Note: ${esc(order.special_instructions)}</div>` : ''}
          <div>Created: ${esc(new Date(order.created_at).toLocaleString())}</div>
        </div>
      </div>

      ${editCardHTML()}

      ${
        !paid
          ? `
      <div class="card">
        <h2>Take payment</h2>
        <p class="sub">The QR code is generated only after payment is confirmed.</p>
        <div class="btn-row">
          <button class="btn" id="pay-stripe" ${busy ? 'disabled' : ''}>💳 Card (Stripe)</button>
          <button class="btn secondary" id="pay-cash" ${busy ? 'disabled' : ''}>💵 Cash received</button>
          <button class="btn warn" id="pay-demo" ${busy ? 'disabled' : ''}>🧪 Demo card payment</button>
        </div>
        <p class="sub" style="margin-top:10px">
          Card payments via Stripe Checkout open automatically when Stripe keys are configured. Demo payments are
          for testing only and must be disabled in production (DEMO_PAYMENTS=false).
        </p>
        ${discountHTML()}
      </div>`
          : `
      ${order.order_status === 'PAID' ? `<div class="card"><div class="info">💡 Next step: open the <a class="link" href="/kitchen">Kitchen page</a> and tap <b>Accept order</b> to start preparing it.</div></div>` : ''}
      <div class="card qr-box">
        <h2>✅ Payment confirmed</h2>
        <p class="sub">Show this QR code to the customer — scanning opens their live order page.</p>
        <img src="${qrSrc}" alt="QR code for order ${order.order_number}" />
        <div class="mono" style="margin-top:12px">${esc(order.tracking_url)}</div>
        <div class="btn-row no-print">
          <button class="btn secondary" id="qr-print">🖨 Print</button>
          <a class="btn secondary" href="${qrSrc}" download="order-${order.order_number}-qr.png">⬇ Download</a>
          <button class="btn secondary" id="qr-copy">🔗 Copy link</button>
        </div>
      </div>`
      }

      <div class="card no-print">
        <h2>Status history</h2>
        ${order.history
          .map(
            (h) => `
          <div class="item-row">
            <span>${h.old_status ? `${esc(h.old_status)} → ` : ''}<b>${esc(h.new_status)}</b> <span class="sub">by ${esc(h.changed_by)}</span></span>
            <span class="sub">${esc(new Date(h.changed_at).toLocaleTimeString())}</span>
          </div>`
          )
          .join('')}
      </div>
    </div>`;
    wireTopBar();

    const stripeBtn = document.getElementById('pay-stripe');
    if (stripeBtn) stripeBtn.addEventListener('click', () => pay('stripe'));
    const cashBtn = document.getElementById('pay-cash');
    if (cashBtn) cashBtn.addEventListener('click', () => pay('cash'));
    const demoBtn = document.getElementById('pay-demo');
    if (demoBtn) demoBtn.addEventListener('click', () => pay('demo'));
    const printBtn = document.getElementById('qr-print');
    if (printBtn) printBtn.addEventListener('click', () => window.print());
    const copyBtn = document.getElementById('qr-copy');
    if (copyBtn) copyBtn.addEventListener('click', copyLink);

    // --- edit items (admin, pending orders only) ---
    root.querySelectorAll('[data-edit-inc]').forEach((b) =>
      b.addEventListener('click', () => {
        const l = editInit()[Number(b.dataset.editInc)];
        if (l && l.qty < 99) l.qty++;
        render();
      })
    );
    root.querySelectorAll('[data-edit-dec]').forEach((b) =>
      b.addEventListener('click', () => {
        const l = editInit()[Number(b.dataset.editDec)];
        if (l && l.qty > 1) l.qty--;
        render();
      })
    );
    root.querySelectorAll('[data-edit-del]').forEach((b) =>
      b.addEventListener('click', () => {
        editInit().splice(Number(b.dataset.editDel), 1);
        render();
      })
    );
    const addBtn = document.getElementById('edit-add');
    if (addBtn)
      addBtn.addEventListener('click', () => {
        const name = document.getElementById('edit-add-name').value.trim().slice(0, 120);
        const price = Math.round(Number(document.getElementById('edit-add-price').value) * 100);
        if (!name || !Number.isFinite(price) || price < 0) {
          showNotice('Enter an item name and price to add it.');
          return;
        }
        editInit().push({ name, qty: 1, unit_price: price });
        render();
      });
    const notesEl = document.getElementById('edit-notes');
    if (notesEl) notesEl.addEventListener('input', () => { editNotes = notesEl.value; });
    const saveBtn = document.getElementById('edit-save');
    if (saveBtn)
      saveBtn.addEventListener('click', async () => {
        const lines = editInit();
        if (lines.length === 0) {
          showNotice('An order needs at least one item.');
          return;
        }
        busy = true;
        error = null;
        render();
        try {
          await api(`/api/orders/${order.id}/items`, {
            method: 'PATCH',
            body: JSON.stringify({
              items: lines.map((l) => ({
                name: l.name,
                qty: l.qty,
                unit_price: l.unit_price,
                discount_cents: l.discount_cents || 0,
                discount_code: l.discount_code || null,
              })),
            }),
          });
          const notesVal = (document.getElementById('edit-notes')?.value ?? '').trim().slice(0, 500);
          await api(`/api/orders/${order.id}/instructions`, {
            method: 'PATCH',
            body: JSON.stringify({ special_instructions: notesVal }),
          });
          busy = false;
          showNotice('Order updated.');
          await load();
        } catch (e) {
          busy = false;
          error = e.message;
          render();
        }
      });

    // --- per-item discounts (admin, during payment) ---
    const lines = itemDiscInit();
    lines.forEach((l, i) => {
      const manualEl = document.getElementById(`disc-manual-${i}`);
      if (manualEl)
        manualEl.addEventListener('input', () => {
          const v = Math.max(0, Math.round(Number(manualEl.value) * 100) || 0);
          itemDisc[i].manual = v;
        });
      const codeEl = document.getElementById(`disc-code-${i}`);
      if (codeEl) codeEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); applyCodeBtn?.(i); }
      });
    });

    async function applyCodeBtn(i) {
      const codeEl = document.getElementById(`disc-code-${i}`);
      const code = (codeEl?.value || '').trim();
      if (!code) { showNotice('Enter a discount code.'); return; }
      itemDisc[i].codeErr = null;
      discBusy = true;
      render();
      try {
        const res = await api('/api/discount-codes/validate', {
          method: 'POST',
          body: JSON.stringify({ code, item_name: itemDisc[i].name }),
        });
        // compute per-unit discount the same way the server does
        const l = itemDisc[i];
        const gross = l.qty * l.unit;
        let disc = 0;
        if (res.amount_cents != null) disc = res.amount_cents * l.qty;
        else if (res.percent_off != null) disc = Math.round((gross * res.percent_off) / 100);
        itemDisc[i].code = res.code;
        itemDisc[i].codeDisc = Math.min(disc, gross);
        itemDisc[i].codeErr = null;
        showNotice(`Code ${res.code} applied — save item discounts to confirm.`);
      } catch (e) {
        itemDisc[i].codeErr = e.message;
      }
      discBusy = false;
      render();
    }

    document.querySelectorAll('[data-disc-code-apply]').forEach((b) =>
      b.addEventListener('click', () => applyCodeBtn(Number(b.getAttribute('data-disc-code-apply'))))
    );
    document.querySelectorAll('[data-disc-code-rm]').forEach((b) =>
      b.addEventListener('click', () => {
        const i = Number(b.getAttribute('data-disc-code-rm'));
        itemDisc[i].code = null;
        itemDisc[i].codeDisc = 0;
        saveItemDiscounts();
      })
    );
    const discItemsSave = document.getElementById('disc-items-save');
    if (discItemsSave) discItemsSave.addEventListener('click', saveItemDiscounts);

    // --- discount (admin, during payment) ---
    const discApply = document.getElementById('disc-apply');
    if (discApply)
      discApply.addEventListener('click', async () => {
        const amt = Math.round(Number(document.getElementById('disc-amt').value) * 100);
        if (!Number.isFinite(amt) || amt < 0) {
          showNotice('Enter a valid discount amount.');
          return;
        }
        discBusy = true;
        render();
        try {
          await api(`/api/orders/${order.id}/discount`, {
            method: 'PATCH',
            body: JSON.stringify({ discount_cents: amt }),
          });
          discBusy = false;
          showNotice(amt > 0 ? 'Discount applied.' : 'Discount removed.');
          await load();
        } catch (e) {
          discBusy = false;
          error = e.message;
          render();
        }
      });
    const discClear = document.getElementById('disc-clear');
    if (discClear)
      discClear.addEventListener('click', async () => {
        discBusy = true;
        render();
        try {
          await api(`/api/orders/${order.id}/discount`, {
            method: 'PATCH',
            body: JSON.stringify({ discount_cents: 0 }),
          });
          discBusy = false;
          showNotice('Discount removed.');
          await load();
        } catch (e) {
          discBusy = false;
          error = e.message;
          render();
        }
      });
  }

  load();

  // Returning from Stripe Checkout (?paid=1): give the webhook a moment, then refresh.
  const params = new URLSearchParams(location.search);
  let paidTimer = null;
  if (params.get('paid')) {
    notice = 'Returned from checkout — confirming payment status…';
    paidTimer = window.setTimeout(() => {
      history.replaceState({}, '', location.pathname);
      load();
      notice = null;
    }, 2500);
  }

  const t = window.setInterval(load, 4000);

  return () => {
    window.clearInterval(t);
    if (paidTimer) window.clearTimeout(paidTimer);
  };
}

/* ------------------------- kitchen display ------------------------- */

const KITCHEN_ACTIVE = ['PAID', 'RECEIVED', 'PREPARING', 'READY', 'PARTIALLY_COMPLETED'];

function KitchenDisplayPage() {
  const user = getUser();
  const canUpdate = getViewRole() === 'ADMIN' || getViewRole() === 'KITCHEN_STAFF';
  let orders = [];
  let busyId = null;
  let error = null;
  let lastSig = '';

  async function load() {
    try {
      const summaries = await api('/api/orders?limit=100');
      const detailed = await Promise.all(
        summaries.filter((s) => KITCHEN_ACTIVE.includes(s.order_status)).map((s) => api(`/api/orders/${s.id}`))
      );
      detailed.sort(
        (a, b) => KITCHEN_ACTIVE.indexOf(a.order_status) - KITCHEN_ACTIVE.indexOf(b.order_status) || a.id - b.id
      );
      orders = detailed;
      error = null;
    } catch (e) {
      error = e.message;
    }
    const sig = JSON.stringify({ orders, error, busyId });
    if (sig !== lastSig) {
      lastSig = sig;
      render();
    }
  }

  async function setStatus(orderId, status) {
    busyId = orderId;
    error = null;
    lastSig = ''; // force re-render to show disabled button
    render();
    try {
      await api(`/api/orders/${orderId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      busyId = null;
      lastSig = '';
      await load();
    } catch (e) {
      busyId = null;
      error = e.message;
      lastSig = '';
      render();
    }
  }

  function render() {
    root.innerHTML = `
    ${topBar()}
    <div class="page wide">
      <h1>🍳 Kitchen display</h1>
      <p class="sub">Tap a card's button the moment the status changes — the customer is notified instantly.</p>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      ${
        orders.length === 0
          ? '<div class="card empty">No active orders. New paid orders appear here automatically.</div>'
          : `<div class="kitchen-grid">${orders
              .map(
                (o) => `
            <div class="kcard ${esc(o.order_status)}" data-id="${o.id}">
              <div style="display:flex;justify-content:space-between;align-items:baseline">
                <div class="num">#${o.order_number}</div>
                <span class="badge ${esc(o.order_status)}">${esc(STATUS_LABELS[o.order_status] || o.order_status)}</span>
              </div>
              ${o.customer_name ? `<div class="sub">${esc(o.customer_name)}</div>` : ''}
              <div class="items">
                ${o.items.map((it) => `<div><b>${esc(it.item_name)}</b> ×${it.quantity}</div>`).join('')}
              </div>
              ${o.special_instructions ? `<div class="special">📝 ${esc(o.special_instructions)}</div>` : ''}
              <div class="time">${timeOf(o.created_at)}</div>
              ${
                canUpdate
                  ? `<div class="btn-row" style="margin-top:12px">
                  ${
                    o.order_status === 'PAID'
                      ? `<button class="btn warn block" data-act="RECEIVED" ${busyId === o.id ? 'disabled' : ''}>📥 Accept order</button>`
                      : o.order_status === 'RECEIVED'
                      ? `<button class="btn warn block" data-act="PREPARING" ${busyId === o.id ? 'disabled' : ''}>Start preparing</button>`
                      : o.order_status === 'PREPARING'
                      ? `<button class="btn block" data-act="READY" ${busyId === o.id ? 'disabled' : ''}>✅ MARK READY</button>`
                      : o.order_status === 'READY'
                      ? `<button class="btn secondary block" data-act="PARTIALLY_COMPLETED" ${busyId === o.id ? 'disabled' : ''}>🟡 Partially complete</button>
                         <button class="btn block" data-act="COMPLETED" ${busyId === o.id ? 'disabled' : ''} style="margin-top:8px">✅ Fully complete</button>`
                      : o.order_status === 'PARTIALLY_COMPLETED'
                      ? `<button class="btn block" data-act="COMPLETED" ${busyId === o.id ? 'disabled' : ''}>✅ Fully complete</button>`
                      : ''
                  }
                </div>`
                  : ''
              }
            </div>`
              )
              .join('')}</div>`
      }
    </div>`;
    wireTopBar();
    root.querySelectorAll('.kcard [data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const card = b.closest('.kcard');
        setStatus(Number(card.dataset.id), b.dataset.act);
      });
    });
  }

  load();
  const t = window.setInterval(load, 5000);
  let es = null;
  try {
    es = new EventSource(`/api/orders/events?token=${encodeURIComponent(getToken() || '')}`);
    es.addEventListener('order', () => load());
    es.onerror = () => es && es.close();
  } catch {
    /* polling covers it */
  }

  return () => {
    window.clearInterval(t);
    if (es) es.close();
  };
}

/* ------------------------- customer order ------------------------- */

function CustomerOrderPage({ token }) {
  let order = null;
  let error = null;
  let alertedReady = false;
  let pushState = 'available';
  let pushMsg = null;
  let pushBusy = false;
  let live = false;
  let showIOSHint = false;
  let lastSig = '';

  async function load() {
    const res = await fetch(`/api/orders/token/${token}`);
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      throw new Error((d && d.error) || 'Could not load this order.');
    }
    return res.json();
  }

  async function refresh() {
    try {
      const data = await load();
      error = null;
      const sig = JSON.stringify(data);
      if (sig !== lastSig) {
        lastSig = sig;
        order = data;
        maybeReadyAlert(order);
        render();
      }
    } catch (e) {
      if (!order) {
        error = e.message;
        render();
      }
    }
  }

  // In-page "order ready" alert — chime + vibration + flashing title when the
  // page is open, even if push notifications are blocked or unsupported.
  function readyAlert() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        const now = ctx.currentTime;
        [523.25, 783.99, 1046.5].forEach((freq, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'sine';
          o.frequency.value = freq;
          const t = now + i * 0.22;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.5, t + 0.04);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
          o.connect(g);
          g.connect(ctx.destination);
          o.start(t);
          o.stop(t + 0.65);
        });
      }
    } catch {}
    try {
      if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 500]);
    } catch {}
    const orig = document.title;
    let n = 0;
    const iv = window.setInterval(() => {
      document.title = n % 2 ? orig : '🔔 YOUR ORDER IS READY!';
      if (++n > 13) {
        window.clearInterval(iv);
        document.title = orig;
      }
    }, 800);
  }
  function maybeReadyAlert(o) {
    if (o && (o.order_status === 'READY' || o.order_status === 'PARTIALLY_COMPLETED' || o.order_status === 'COMPLETED') && !alertedReady) {
      alertedReady = true;
      readyAlert();
    }
  }

  function patchStatus(u) {
    if (!order) return;
    live = true;
    order = {
      ...order,
      order_status: u.order_status,
      payment_status: u.payment_status,
      updated_at: u.updated_at,
    };
    lastSig = JSON.stringify(order);
    maybeReadyAlert(order);
    render();
  }

  async function onEnablePush() {
    pushBusy = true;
    pushMsg = null;
    render();
    const r = await enablePush(token);
    pushMsg = r.message;
    pushBusy = false;
    pushState = r.ok ? 'subscribed' : await getPushState();
    render();
  }

  function render() {
    if (error) {
      root.innerHTML = `
      <div class="page">
        <div class="card" style="text-align:center;margin-top:40px">
          <h1>😕</h1>
          <h2>Order not found</h2>
          <p class="sub">${esc(error)} Please contact the kitchen counter.</p>
        </div>
      </div>`;
      return;
    }
    if (!order) {
      root.innerHTML = '<div class="page"><div class="card empty">Loading your order…</div></div>';
      return;
    }

    const stepIndex = STATUS_STEPS.indexOf(order.order_status);
    const cancelled = order.order_status === 'CANCELLED';

    const eta = cancelled
      ? 'Please contact the kitchen counter.'
      : order.order_status === 'READY'
      ? 'Please come to the counter to pick up your order.'
      : order.order_status === 'PARTIALLY_COMPLETED'
      ? 'Part of your order is ready — please come to the counter.'
      : order.order_status === 'COMPLETED'
      ? 'Thank you! Enjoy your meal.'
      : 'Estimated pickup: 10–15 minutes';

    const heroTitle = cancelled
      ? '❌ Cancelled'
      : order.order_status === 'READY'
      ? '🟢 READY'
      : order.order_status === 'PARTIALLY_COMPLETED'
      ? '🟡 PARTIALLY READY'
      : STATUS_LABELS[order.order_status] || order.order_status;

    let pushCard = '';
    if (pushState === 'subscribed') {
      pushCard = `<div class="ok">🔔 Notifications on — we'll alert you when your order is ready.</div>`;
    } else if (!cancelled) {
      let body = '';
      if (pushState === 'denied') {
        body = `<div class="info">Notifications are blocked for this site. You can still watch your order status update live on this page.</div>`;
      } else if (pushState === 'unsupported') {
        body = `<div class="info">This browser doesn't support push notifications. Keep this page open — it updates live and will sound an alert when you're called.</div>`;
      } else {
        body = `<button class="btn block" id="push-btn" ${pushBusy ? 'disabled' : ''}>${
          pushBusy ? 'Enabling…' : '🔔 Enable Notifications'
        }</button>`;
      }
      pushCard = `
      <div class="card">
        <h2>🔔 Get notified</h2>
        <p class="sub">We'll notify you the moment your order is ready.</p>
        ${
          showIOSHint
            ? `<div class="info">On iPhone, push notifications work best if you add this page to your Home Screen first (Share → Add to Home Screen), then tap the button below.</div>`
            : ''
        }
        ${body}
        ${
          pushMsg
            ? `<div class="${pushMsg.startsWith("You're") ? 'ok' : 'info'}">${esc(pushMsg)}</div>`
            : ''
        }
      </div>`;
    }

    root.innerHTML = `
    <div class="page">
      <div class="topbar" style="position:static;border-radius:14px;margin-bottom:4px">
        <div class="brand"><span>●</span> YOUR KITCHEN</div>
        <span class="who">${live ? '● live' : '○ connecting…'}</span>
      </div>

      <div class="card status-hero ${order.order_status === 'READY' || order.order_status === 'PARTIALLY_COMPLETED' ? 'READY' : ''}">
        <div class="sub" style="margin:0">Order #${order.order_number}${
      order.customer_name ? ` · ${esc(order.customer_name)}` : ''
    }</div>
        <div class="big">${esc(heroTitle)}</div>
        <div class="eta">${esc(eta)}</div>
      </div>

      ${
        !cancelled
          ? `
      <div class="card">
        <h2>Order status</h2>
        <ul class="steps">
          ${STATUS_STEPS.map((s, i) => {
            const cls = i < stepIndex ? 'done' : i === stepIndex ? 'current' : '';
            return `<li class="${cls}"><span class="dot">${i < stepIndex ? '✓' : i + 1}</span><span>${esc(STATUS_LABELS[s])}</span></li>`;
          }).join('')}
        </ul>
        <div class="sub" style="margin-top:8px">Payment: ${
          order.payment_status === 'PAID' ? '✓ Confirmed' : esc(order.payment_status)
        }</div>
      </div>`
          : ''
      }

      ${pushCard}

      <div class="card">
        <h2>Your items</h2>
        ${order.items
          .map(
            (it) => `
          <div class="item-row">
            <span>${esc(it.item_name)} <b>×${it.quantity}</b></span>
            <span>${money(it.total_price_cents)}</span>
          </div>`
          )
          .join('')}
        ${
          order.special_instructions
            ? `<div class="sub" style="margin-top:8px">Note: ${esc(order.special_instructions)}</div>`
            : ''
        }
        <div class="total-row"><span>Total</span><span>${money(order.total_cents)}</span></div>
        <div class="sub" style="margin-top:10px;margin-bottom:0">Last updated: ${timeOf(order.updated_at)}</div>
      </div>

      <p class="sub" style="text-align:center">Keep this page or your QR code — you can come back anytime to check your order.</p>
    </div>`;

    const pushBtn = document.getElementById('push-btn');
    if (pushBtn) pushBtn.addEventListener('click', onEnablePush);
  }

  refresh();
  getPushState().then((s) => {
    if (s !== pushState) {
      pushState = s;
      render();
    }
  });
  if (isIOS() && !isStandalone()) showIOSHint = true;

  // Real-time updates: SSE first, polling fallback.
  let es = null;
  let pollTimer = null;
  let pollFallback = false;
  try {
    es = new EventSource(`/api/orders/token/${token}/events`);
    es.addEventListener('order', (ev) => {
      try {
        patchStatus(JSON.parse(ev.data));
      } catch {}
    });
    es.onerror = () => {
      if (es) es.close();
      es = null;
      if (!pollFallback) {
        pollFallback = true;
        pollTimer = window.setInterval(() => {
          refresh().then(() => {
            live = true;
          });
        }, 5000);
      }
    };
  } catch {
    pollTimer = window.setInterval(refresh, 5000);
  }

  return () => {
    if (es) es.close();
    if (pollTimer) window.clearInterval(pollTimer);
  };
}

/* ============================== waitlist (module 2) ============================== */

const WL_STATUS_LABELS = {
  WAITING: 'Waiting',
  ALMOST_READY: 'Almost your turn',
  CALLED: 'Your table is ready',
  SEATED: 'Seated',
  SKIPPED: 'Skipped',
  NO_SHOW: 'No-show',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

// Buttons shown per entry status on the staff dashboard. Only sensible
// transitions are offered (the backend also enforces them with 409s).
const WL_ACTIONS = {
  WAITING: [
    ['almost-ready', 'ALMOST READY', 'secondary'],
    ['call', 'CALL', ''],
    ['no-show', 'NO SHOW', 'warn'],
    ['cancel', 'CANCEL', 'danger'],
  ],
  ALMOST_READY: [
    ['call', 'CALL', ''],
    ['skip', 'SKIP', 'warn'],
    ['no-show', 'NO SHOW', 'warn'],
    ['cancel', 'CANCEL', 'danger'],
  ],
  CALLED: [
    ['seated', 'SEATED', ''],
    ['recall', 'RECALL', 'secondary'],
    ['skip', 'SKIP', 'warn'],
    ['no-show', 'NO SHOW', 'warn'],
    ['restore', 'MOVE BACK TO WAITING', 'secondary'],
    ['cancel', 'CANCEL', 'danger'],
  ],
  SKIPPED: [
    ['restore', 'MOVE BACK TO WAITING', 'secondary'],
    ['call', 'CALL', ''],
    ['no-show', 'NO SHOW', 'warn'],
    ['cancel', 'CANCEL', 'danger'],
  ],
};

// Shared "enable push notifications" card for the customer waitlist pages.
function makePushController(onChange, opts) {
  const { token, subscribePath, doneMessage, heading, blurb } = opts;
  const c = {
    state: 'available',
    msg: null,
    busy: false,
    showIOSHint: isIOS() && !isStandalone(),
    async init() {
      const s = await getPushState();
      if (s !== this.state) {
        this.state = s;
        onChange();
      }
    },
    html() {
      if (this.state === 'subscribed') {
        return `<div class="ok">Notifications on — ${esc(doneMessage)}</div>`;
      }
      let body = '';
      if (this.state === 'denied') {
        body = `<div class="info">Notifications are blocked for this site. Keep this page open — it updates live and will sound an alert when you're called.</div>`;
      } else if (this.state === 'unsupported') {
        body = `<div class="info">This browser doesn't support push notifications. Keep this page open — it updates live and will sound an alert when you're called.</div>`;
      } else {
        body = `
        ${
          this.showIOSHint
            ? `<div class="info">On iPhone, push notifications work best if you add this page to your Home Screen first (Share → Add to Home Screen), then tap the button below.</div>`
            : ''
        }
        <button class="btn block" id="wl-push-btn" ${this.busy ? 'disabled' : ''}>${
          this.busy ? 'Enabling…' : 'Enable notifications'
        }</button>`;
      }
      return `
      <div class="card">
        <h2>${esc(heading || 'Get notified')}</h2>
        <p class="sub">${esc(blurb || "We'll notify you when your table is almost ready and when it's your turn.")}</p>
        ${body}
        ${this.msg ? `<div class="info">${esc(this.msg)}</div>` : ''}
      </div>`;
    },
    bind() {
      const b = document.getElementById('wl-push-btn');
      if (b) b.addEventListener('click', () => this.enable());
    },
    async enable() {
      this.busy = true;
      this.msg = null;
      onChange();
      const r = await enablePush(token, { subscribePath, doneMessage });
      this.busy = false;
      if (r.ok) {
        this.state = 'subscribed';
      } else {
        this.msg = r.message;
        this.state = await getPushState();
      }
      onChange();
    },
  };
  return c;
}

/* ------------------------- customer check-in ------------------------- */

function CheckinPage({ slug }) {
  let loc = null;
  let loadError = null; // 'invalid' | 'disabled' | <message>
  let busy = false;
  let formError = null;
  let confirmed = null; // check-in response entry json
  let isDuplicate = false;
  let push = null;

  async function init() {
    try {
      const res = await fetch(`/api/waitlist/location/${encodeURIComponent(slug)}`);
      if (res.status === 404) {
        loadError = 'invalid';
      } else if (!res.ok) {
        loadError = 'Could not load this check-in page. Please try again.';
      } else {
        loc = await res.json();
        if (!loc.waitlist_enabled) loadError = 'disabled';
      }
    } catch {
      loadError = 'Could not load this check-in page. Please try again.';
    }
    render();
  }

  async function submit(e) {
    e.preventDefault();
    const name = document.getElementById('wl-name').value.trim();
    const size = Number(document.getElementById('wl-size').value);
    const phone = document.getElementById('wl-phone').value.trim();
    const notes = document.getElementById('wl-notes').value.trim();
    if (!name) {
      formError = 'Please enter your name.';
      render();
      return;
    }
    if (!Number.isFinite(size) || size < 1 || size > 30) {
      formError = 'Party size must be between 1 and 30.';
      render();
      return;
    }
    busy = true;
    formError = null;
    render();
    try {
      const data = await api('/api/waitlist/check-in', {
        method: 'POST',
        body: JSON.stringify({
          slug,
          customer_name: name,
          party_size: size,
          ...(phone ? { customer_phone: phone } : {}),
          ...(notes ? { special_requirements: notes } : {}),
        }),
      });
      isDuplicate = !!data.duplicate;
      confirmed = data;
      push = makePushController(render, {
        token: data.public_token,
        subscribePath: '/api/waitlist/notifications/subscribe',
        doneMessage: "We'll notify you when your table is almost ready.",
        blurb: "We'll notify you when your table is almost ready and when it's your turn.",
      });
      push.init();
      busy = false;
      render();
      window.scrollTo(0, 0);
    } catch (err) {
      busy = false;
      formError = err.message;
      render();
    }
  }

  function render() {
    if (loadError === 'invalid') {
      root.innerHTML = `
      <div class="page">
        <div class="card" style="text-align:center;margin-top:40px">
          <h2>Invalid check-in link</h2>
          <p class="sub">This check-in link isn't valid. Please scan the restaurant's QR code again or ask the host stand for help.</p>
        </div>
      </div>`;
      return;
    }
    if (loadError === 'disabled') {
      root.innerHTML = `
      <div class="page">
        <div class="card" style="text-align:center;margin-top:40px">
          <h2>${esc((loc && loc.restaurant_name) || 'Restaurant')}</h2>
          <p class="sub">The waiting list is currently closed for this location. Please check with the host stand.</p>
        </div>
      </div>`;
      return;
    }
    if (loadError) {
      root.innerHTML = `
      <div class="page">
        <div class="card" style="text-align:center;margin-top:40px">
          <h2>Check-in</h2>
          <div class="error">${esc(loadError)}</div>
        </div>
      </div>`;
      return;
    }
    if (!loc) {
      root.innerHTML = '<div class="page"><div class="card empty">Loading…</div></div>';
      return;
    }
    if (confirmed) {
      renderConfirmed();
      return;
    }

    const waitLine =
      loc.queue_length > 0
        ? `${loc.queue_length} ${loc.queue_length === 1 ? 'party' : 'parties'} waiting${
            loc.estimated_wait_label ? ` · about ${esc(loc.estimated_wait_label)}` : ''
          }`
        : 'No wait right now — check in and we’ll seat you soon.';

    root.innerHTML = `
    <div class="page">
      <div class="topbar" style="position:static;border-radius:14px;margin-bottom:4px">
        <div class="brand"><span>●</span> ${esc(loc.restaurant_name || 'Restaurant')}</div>
      </div>
      <div class="card">
        <h1>Join the waiting list</h1>
        <p class="sub">${waitLine}</p>
        ${formError ? `<div class="error">${esc(formError)}</div>` : ''}
        <form id="wl-checkin-form">
          <label class="field"><span>Name</span><input id="wl-name" autocomplete="name" maxlength="120" /></label>
          <label class="field"><span>Number of guests</span><input id="wl-size" type="number" min="1" max="30" inputmode="numeric" value="2" /></label>
          <label class="field"><span>Phone number (optional)</span><input id="wl-phone" inputmode="tel" placeholder="So we can find your entry if needed" /></label>
          <label class="field"><span>Special requirements (optional)</span><textarea id="wl-notes" rows="2" placeholder="High chair, wheelchair access, indoor/outdoor…"></textarea></label>
          <button class="btn block" type="submit" ${busy ? 'disabled' : ''}>${
      busy ? 'Checking in…' : 'CHECK IN'
    }</button>
        </form>
      </div>
    </div>`;
    document.getElementById('wl-checkin-form').addEventListener('submit', submit);
  }

  function renderConfirmed() {
    const e = confirmed;
    // qr_url is only contract-guaranteed on the token endpoint, so build it
    // from the public token here (same shape the backend uses).
    const qrSrc = `/api/waitlist/token/${encodeURIComponent(e.public_token)}/qr.png`;
    root.innerHTML = `
    <div class="page">
      <div class="topbar" style="position:static;border-radius:14px;margin-bottom:4px">
        <div class="brand"><span>●</span> ${esc(e.restaurant_name || '')}</div>
      </div>
      <div class="card" style="text-align:center">
        ${
          isDuplicate
            ? `<div class="info">You already have an active entry — we didn't create a second one.</div>`
            : `<h2 style="margin-top:0">You're checked in!</h2>`
        }
        <div class="sub" style="margin-bottom:0">Your number</div>
        <div class="queue-big">${esc(e.queue_number)}</div>
        <div class="stat-grid" style="margin-top:16px">
          <div class="stat"><div class="v">${e.party_size}</div><div class="l">Guests</div></div>
          <div class="stat"><div class="v">${e.parties_ahead}</div><div class="l">Ahead of you</div></div>
          <div class="stat"><div class="v" style="font-size:16px">${esc(e.estimated_wait_label)}</div><div class="l">Est. wait</div></div>
        </div>
      </div>
      <div class="card qr-box">
        <h2>Your QR code</h2>
        <p class="sub">Scan this to return to your waitlist page.</p>
        <img src="${esc(qrSrc)}" alt="Waitlist QR code ${esc(e.queue_number)}" />
      </div>
      <div id="wl-push"></div>
      <div class="card" style="text-align:center">
        <a class="btn block" href="/wait/${encodeURIComponent(e.public_token)}">Track my place in line →</a>
      </div>
    </div>`;
    const box = document.getElementById('wl-push');
    box.innerHTML = push.html();
    push.bind();
  }

  init();
}

/* ------------------------- customer tracking ------------------------- */

const WL_TERMINAL = ['CANCELLED', 'NO_SHOW', 'EXPIRED'];

function WaitlistTrackingPage({ token }) {
  let entry = null;
  let error = null;
  let live = false;
  let confirmCancel = false;
  let cancelBusy = false;
  let cancelError = null;
  let lastSig = '';
  const push = makePushController(render, {
    token,
    subscribePath: '/api/waitlist/notifications/subscribe',
    doneMessage: "We'll notify you when your table is almost ready.",
    blurb: "We'll notify you when your table is almost ready and when it's your turn.",
  });

  async function refresh() {
    try {
      const res = await fetch(`/api/waitlist/token/${encodeURIComponent(token)}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || 'Could not load this waitlist entry.');
      error = null;
      const sig = JSON.stringify(data);
      if (sig !== lastSig) {
        lastSig = sig;
        entry = data;
        maybeCallAlert(entry);
        render();
      }
    } catch (e) {
      if (!entry) {
        error = e.message;
        render();
      }
    }
  }


  // --- in-page "table ready" alert ---
  // Fires when the page is OPEN and the entry gets CALLED — even if push
  // notifications are blocked or unsupported. Chime + vibration + flashing tab.
  let alertedCall = null;
  function callAlert() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        const now = ctx.currentTime;
        [523.25, 783.99, 1046.5].forEach((freq, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'sine';
          o.frequency.value = freq;
          const t = now + i * 0.22;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.5, t + 0.04);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
          o.connect(g);
          g.connect(ctx.destination);
          o.start(t);
          o.stop(t + 0.65);
        });
      }
    } catch {}
    try {
      if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 500]);
    } catch {}
    const orig = document.title;
    let n = 0;
    const iv = window.setInterval(() => {
      document.title = n % 2 ? orig : '🔔 YOUR TABLE IS READY!';
      if (++n > 13) {
        window.clearInterval(iv);
        document.title = orig;
      }
    }, 800);
  }
  function maybeCallAlert(e) {
    if (e && e.status === 'CALLED' && e.called_time && alertedCall !== e.called_time) {
      alertedCall = e.called_time;
      callAlert();
    }
  }

  function stepsHTML(status) {
    const labels = ['Checked in', 'Waiting', 'Almost your turn', 'Called', 'Seated'];
    const idx = { WAITING: 1, ALMOST_READY: 2, CALLED: 3, SEATED: 4, SKIPPED: 3 }[status] ?? 1;
    return `<ul class="steps">${labels
      .map((label, i) => {
        const cls = i < idx ? 'done' : i === idx ? 'current' : '';
        return `<li class="${cls}"><span class="dot">${i < idx ? '✓' : i + 1}</span><span>${label}</span></li>`;
      })
      .join('')}</ul>`;
  }

  async function doCancel() {
    cancelBusy = true;
    cancelError = null;
    render();
    try {
      await api(`/api/waitlist/token/${encodeURIComponent(token)}/cancel`, { method: 'POST' });
      confirmCancel = false;
      cancelBusy = false;
      lastSig = '';
      await refresh();
    } catch (e) {
      cancelBusy = false;
      cancelError = e.message;
      render();
    }
  }

  function render() {
    if (error) {
      root.innerHTML = `
      <div class="page">
        <div class="card" style="text-align:center;margin-top:40px">
          <h2>Waitlist link not found</h2>
          <p class="sub">${esc(error)} Please scan your QR code again or check with the host stand.</p>
        </div>
      </div>`;
      return;
    }
    if (!entry) {
      root.innerHTML = '<div class="page"><div class="card empty">Loading your waitlist entry…</div></div>';
      return;
    }
    const e = entry;
    const terminal = WL_TERMINAL.includes(e.status);
    const statusLabel = WL_STATUS_LABELS[e.status] || e.status;

    let statusCard = '';
    if (terminal) {
      const note =
        e.status === 'CANCELLED'
          ? 'Your waitlist entry was cancelled.'
          : e.status === 'NO_SHOW'
          ? 'You were marked as a no-show. Please check with the host stand if you still need a table.'
          : 'This waitlist entry has expired.';
      statusCard = `<div class="card"><div class="info">${esc(note)}</div></div>`;
    } else if (e.status === 'SEATED') {
      statusCard = `<div class="card"><div class="ok">You're seated — enjoy your meal!</div>${stepsHTML(e.status)}</div>`;
    } else {
      statusCard = `
      <div class="card">
        <h2>Queue status</h2>
        ${stepsHTML(e.status)}
        ${
          e.status === 'SKIPPED'
            ? `<div class="info">You've been skipped for now — please check with the host stand. You may be called again.</div>`
            : ''
        }
      </div>`;
    }

    let cancelCard = '';
    if (e.status === 'WAITING' || e.status === 'ALMOST_READY') {
      if (confirmCancel) {
        cancelCard = `
        <div class="card" style="text-align:center">
          <h2>Cancel your wait?</h2>
          <p class="sub">Your place in line (${esc(e.queue_number)}) will be released.</p>
          ${cancelError ? `<div class="error">${esc(cancelError)}</div>` : ''}
          <div class="btn-row">
            <button class="btn danger" id="wl-cancel-yes" ${
              cancelBusy ? 'disabled' : ''
            }>${cancelBusy ? 'Cancelling…' : 'YES, CANCEL'}</button>
            <button class="btn secondary" id="wl-cancel-no">KEEP WAITING</button>
          </div>
        </div>`;
      } else {
        cancelCard = `
        <div class="card">
          <button class="btn secondary block" id="wl-cancel">Cancel my wait</button>
        </div>`;
      }
    }

    root.innerHTML = `
    <div class="page">
      <div class="topbar" style="position:static;border-radius:14px;margin-bottom:4px">
        <div class="brand"><span>●</span> ${esc(e.restaurant_name || 'YOUR RESTAURANT')}</div>
        <span class="who">${live ? '● live' : '○ connecting…'}</span>
      </div>

      <div class="card status-hero ${e.status === 'CALLED' || e.status === 'SEATED' ? 'CALLED' : ''}" style="text-align:center">
        <div class="sub" style="margin:0">${esc(e.restaurant_name || '')}${
      e.customer_name ? ` · ${esc(e.customer_name)}` : ''
    }</div>
        <div class="queue-big">${esc(e.queue_number)}</div>
        <div class="big" style="font-size:22px;margin-top:6px">${esc(statusLabel)}</div>
        <div class="stat-grid" style="margin-top:16px">
          <div class="stat"><div class="v">${e.party_size}</div><div class="l">Guests</div></div>
          <div class="stat"><div class="v">${esc(e.currently_serving || '—')}</div><div class="l">Now serving</div></div>
          <div class="stat"><div class="v">${e.parties_ahead}</div><div class="l">Ahead of you</div></div>
          <div class="stat"><div class="v" style="font-size:16px">${esc(e.estimated_wait_label)}</div><div class="l">Est. wait</div></div>
        </div>
      </div>

      ${statusCard}

      ${terminal ? '' : '<div id="wl-push"></div>'}

      <div class="card qr-box">
        <h2>Your QR code</h2>
        <p class="sub">Keep this page open — it updates automatically. Scan the QR code to return here.</p>
        <img src="${esc(e.qr_url)}" alt="Waitlist QR code ${esc(e.queue_number)}" />
      </div>

      ${cancelCard}
    </div>`;

    const box = document.getElementById('wl-push');
    if (box) {
      box.innerHTML = push.html();
      push.bind();
    }
    const c1 = document.getElementById('wl-cancel');
    if (c1)
      c1.addEventListener('click', () => {
        confirmCancel = true;
        render();
      });
    const c2 = document.getElementById('wl-cancel-no');
    if (c2)
      c2.addEventListener('click', () => {
        confirmCancel = false;
        cancelError = null;
        render();
      });
    const c3 = document.getElementById('wl-cancel-yes');
    if (c3) c3.addEventListener('click', doCancel);
  }

  refresh();
  push.init();

  // Real-time updates: SSE first, polling fallback.
  let es = null;
  let pollTimer = null;
  let pollFallback = false;
  try {
    es = new EventSource(`/api/waitlist/token/${encodeURIComponent(token)}/events`);
    es.addEventListener('waitlist', (ev) => {
      try {
        const u = JSON.parse(ev.data);
        if (u && u.queue_number) {
          live = true;
          const sig = JSON.stringify(u);
          if (sig !== lastSig) {
            lastSig = sig;
            entry = u;
            maybeCallAlert(entry);
            render();
          }
        }
      } catch {}
    });
    es.onerror = () => {
      if (es) es.close();
      es = null;
      if (!pollFallback) {
        pollFallback = true;
        pollTimer = window.setInterval(() => {
          live = true;
          refresh();
        }, 5000);
      }
    };
  } catch {
    pollTimer = window.setInterval(refresh, 5000);
  }

  return () => {
    if (es) es.close();
    if (pollTimer) window.clearInterval(pollTimer);
  };
}

/* ------------------------- staff waitlist dashboard ------------------------- */

function StaffWaitlistPage() {
  const user = getUser();
  const canWrite = getViewRole() === 'ADMIN';
  let locations = [];
  let locationId = null;
  let summary = null;
  let locInfo = null; // public location info (check-in URL) for the printable QR
  let locInfoFor = null;
  let error = null;
  let selectMode = false;
  let selectedId = null;
  let busy = null; // 'call-next' or `<action>:<id>`
  let notice = null;
  let noticeKind = 'ok';
  let lastSig = '';
  let es = null;
  let pollTimer = null;

  async function init() {
    try {
      locations = await api('/api/waitlist/admin/locations');
    } catch (e) {
      error = e.message;
      render();
      return;
    }
    if (locations.length === 0) {
      error = 'No restaurant locations found for your account.';
      render();
      return;
    }
    const q = Number(new URLSearchParams(location.search).get('location_id'));
    locationId = locations.some((l) => l.id === q) ? q : locations[0].id;
    render();
    await load();
    loadLocInfo();
    startLive();
  }

  async function load() {
    try {
      const data = await api(`/api/waitlist/admin/summary?location_id=${locationId}`);
      error = null;
      const sig = JSON.stringify(data);
      if (sig !== lastSig) {
        lastSig = sig;
        summary = data;
        render();
      }
    } catch (e) {
      error = e.message;
      render();
    }
  }

  // Public info for the permanent restaurant check-in QR (no auth needed).
  async function loadLocInfo() {
    const loc = locations.find((l) => l.id === locationId);
    if (!loc || !loc.slug || locInfoFor === loc.slug) return;
    locInfoFor = loc.slug;
    try {
      const res = await fetch(`/api/waitlist/location/${encodeURIComponent(loc.slug)}`);
      if (res.ok) {
        locInfo = await res.json();
        render();
      }
    } catch {}
  }

  async function act(id, action) {
    busy = `${action}:${id}`;
    notice = null;
    render();
    try {
      await api(`/api/waitlist/${id}/${action}`, { method: 'POST' });
      busy = null;
      selectMode = false;
      selectedId = null;
      lastSig = '';
      await load();
    } catch (e) {
      busy = null;
      notice = e.message;
      noticeKind = 'error';
      render();
    }
  }

  async function callNext() {
    busy = 'call-next';
    notice = null;
    render();
    try {
      const r = await api('/api/waitlist/admin/call-next', {
        method: 'POST',
        body: JSON.stringify({ location_id: locationId }),
      });
      busy = null;
      lastSig = '';
      notice = `Called ${r.queue_number}.`;
      noticeKind = 'ok';
      await load();
    } catch (e) {
      busy = null;
      notice = e.message;
      noticeKind = 'error';
      render();
    }
  }

  function entryRow(e) {
    const actions = WL_ACTIONS[e.status] || [];
    return `
    <div class="wl-row">
      <div class="wl-num">${esc(e.queue_number)}</div>
      <div class="wl-info">
        <div class="name">${esc(e.customer_name)} <span class="sub">· ${e.party_size} guest${
      e.party_size === 1 ? '' : 's'
    }</span></div>
        <div class="sub" style="margin:2px 0 0">
          <span class="badge ${esc(e.status)}">${esc(e.status.replace(/_/g, ' '))}</span>
          <span>checked in ${e.waited_min} min ago</span>
          ${e.customer_phone ? `<span> · ${esc(e.customer_phone)}</span>` : ''}
          ${e.special_requirements ? `<span> · ${esc(e.special_requirements)}</span>` : ''}
          ${e.recall_count ? `<span> · recalled ${e.recall_count}×</span>` : ''}
        </div>
      </div>
      ${
        canWrite && actions.length
          ? `<div class="wl-actions">${actions
              .map(
                ([a, label, kind]) =>
                  `<button class="btn sm ${kind}" data-act="${a}" data-id="${e.id}" ${
                    busy === `${a}:${e.id}` ? 'disabled' : ''
                  }>${busy === `${a}:${e.id}` ? '…' : label}</button>`
              )
              .join('')}</div>`
          : ''
      }
    </div>`;
  }

  function render() {
    if (error && locations.length === 0) {
      root.innerHTML = `${topBar()}<div class="page"><div class="error">${esc(error)}</div></div>`;
      wireTopBar();
      return;
    }
    if (!summary) {
      root.innerHTML = `${topBar()}<div class="page">${
        error ? `<div class="error">${esc(error)}</div>` : ''
      }<div class="card empty">Loading the waiting list…</div></div>`;
      wireTopBar();
      return;
    }

    const loc = locations.find((l) => l.id === locationId) || {};
    const counts = summary.counts || {};
    const entries = summary.entries || [];
    const waiting = entries.filter((e) => e.status === 'WAITING');

    let picker = '';
    if (selectMode && canWrite) {
      picker = `
      <div class="card" id="select-guest-card">
        <h2>Select guest</h2>
        <p class="sub">Choose which waiting customer to call — useful when a table fits a specific party size.</p>
        ${
          waiting.length === 0
            ? '<div class="empty">No one is waiting.</div>'
            : `
        <div class="picker-list">
          ${waiting
            .map(
              (e) => `
          <label class="picker-item ${selectedId === e.id ? 'sel' : ''}">
            <input type="radio" name="wl-select" value="${e.id}" ${selectedId === e.id ? 'checked' : ''} />
            <span><b>${esc(e.queue_number)}</b> — ${esc(e.customer_name)} — ${e.party_size} guest${
                e.party_size === 1 ? '' : 's'
              }</span>
          </label>`
            )
            .join('')}
        </div>
        <div class="btn-row">
          <button class="btn" id="wl-call-selected" ${
            selectedId == null || busy ? 'disabled' : ''
          }>${busy ? 'Calling…' : 'CALL SELECTED'}</button>
          <button class="btn secondary" id="wl-select-cancel">Back</button>
        </div>`
        }
      </div>`;
    }

    const qrSrc = loc.slug ? `/api/waitlist/location/${encodeURIComponent(loc.slug)}/qr.png` : null;
    const checkinUrl = locInfo && locInfo.checkin_url ? locInfo.checkin_url : '';

    root.innerHTML = `
    ${topBar()}
    <div class="page wide">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h1>Waiting list</h1>
        <label class="field" style="margin:0;min-width:240px">
          <span>Location</span>
          <select id="wl-loc">
            ${locations
              .map(
                (l) =>
                  `<option value="${l.id}" ${l.id === locationId ? 'selected' : ''}>${esc(
                    l.restaurant_name
                  )} — ${esc(l.name)}</option>`
              )
              .join('')}
          </select>
        </label>
      </div>

      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      ${notice ? `<div class="${noticeKind === 'ok' ? 'ok' : 'error'}">${esc(notice)}</div>` : ''}

      <div class="card">
        <div class="now-serving">
          <div class="sub" style="margin:0">NOW SERVING</div>
          <div class="num">${esc(summary.now_serving || '—')}</div>
        </div>
        <div style="text-align:center;margin-top:8px">
          <div class="sub" style="margin:0 0 6px">NEXT UP</div>
          ${
            summary.next_up && summary.next_up.length
              ? summary.next_up.map((n) => `<span class="chip static">${esc(n)}</span>`).join(' ')
              : '<span class="sub">—</span>'
          }
        </div>
        <div class="filterbar" style="justify-content:center;margin-bottom:0">
          ${Object.entries(counts)
            .map(([s, n]) => `<span class="chip static">${esc(s.replace(/_/g, ' '))}: ${n}</span>`)
            .join('')}
        </div>
      </div>

      ${
        canWrite
          ? `
      <div class="card">
        <div class="btn-row" style="margin-top:0">
          <button class="btn block" id="wl-call-next" ${busy === 'call-next' ? 'disabled' : ''}>${
              busy === 'call-next' ? 'Calling…' : 'CALL NEXT'
            }</button>
          <button class="btn secondary block" id="wl-select-guest">SELECT GUEST</button>
        </div>
      </div>
      ${picker}`
          : `<div class="info">Your staff role is read-only — ask an admin to manage the queue.</div>`
      }

      <div class="card">
        <h2>Queue</h2>
        ${
          entries.length === 0
            ? '<div class="empty">No one is waiting right now.</div>'
            : entries.map(entryRow).join('')
        }
      </div>

      ${
        qrSrc
          ? `
      <div class="card qr-box no-print">
        <h2>Check-in QR</h2>
        <p class="sub">Display at the entrance or host stand — customers scan it to join this location's waiting list.</p>
        <img src="${qrSrc}" alt="Restaurant check-in QR code" />
        ${checkinUrl ? `<div class="mono" style="margin-top:12px">${esc(checkinUrl)}</div>` : ''}
        <div class="btn-row" style="justify-content:center">
          <a class="btn secondary" href="${qrSrc}" download="checkin-${esc(
              loc.slug
            )}-qr.png">Download</a>
          <button class="btn secondary" id="wl-qr-print">Print</button>
        </div>
      </div>`
          : ''
      }
    </div>`;
    wireTopBar();

    document.getElementById('wl-loc').addEventListener('change', (e) => {
      locationId = Number(e.target.value);
      summary = null;
      locInfo = null;
      locInfoFor = null;
      selectMode = false;
      selectedId = null;
      notice = null;
      lastSig = '';
      render();
      load();
      loadLocInfo();
      startLive();
    });

    const callNextBtn = document.getElementById('wl-call-next');
    if (callNextBtn) callNextBtn.addEventListener('click', callNext);
    const selectBtn = document.getElementById('wl-select-guest');
    if (selectBtn)
      selectBtn.addEventListener('click', () => {
        selectMode = !selectMode;
        selectedId = null;
        render();
        const card = document.getElementById('select-guest-card');
        if (card) card.scrollIntoView({ block: 'nearest' });
      });
    root.querySelectorAll('input[name="wl-select"]').forEach((r) =>
      r.addEventListener('change', () => {
        selectedId = Number(r.value);
        render();
      })
    );
    const callSel = document.getElementById('wl-call-selected');
    if (callSel) callSel.addEventListener('click', () => selectedId != null && act(selectedId, 'call'));
    const selCancel = document.getElementById('wl-select-cancel');
    if (selCancel)
      selCancel.addEventListener('click', () => {
        selectMode = false;
        selectedId = null;
        render();
      });
    root.querySelectorAll('.wl-actions [data-act]').forEach((b) =>
      b.addEventListener('click', () => act(Number(b.dataset.id), b.dataset.act))
    );
    const printBtn = document.getElementById('wl-qr-print');
    if (printBtn) printBtn.addEventListener('click', () => window.print());
  }

  function startLive() {
    if (es) es.close();
    es = null;
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    try {
      es = new EventSource(
        `/api/waitlist/admin/events?location_id=${locationId}&token=${encodeURIComponent(getToken() || '')}`
      );
      es.addEventListener('waitlist', () => load());
      es.onerror = () => {
        if (es) es.close();
        es = null;
        if (!pollTimer) pollTimer = window.setInterval(load, 5000);
      };
    } catch {
      pollTimer = window.setInterval(load, 5000);
    }
  }

  init();

  return () => {
    if (es) es.close();
    if (pollTimer) window.clearInterval(pollTimer);
  };
}

/* ============================== boot ============================== */

render();
