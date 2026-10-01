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
  { re: /^\/staff\/report$/, page: ReportPage, staff: true },
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
    <div class="brand"><span>●</span> ${esc(user.restaurant_name || 'Kitchen Orders')}</div>
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
            ${user.restaurant_name ? `<div class="rn" style="font-weight:700">${esc(user.restaurant_name)}</div>` : ''}
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
        <p>Live kitchen display, QR ordering & table waitlist — all in one place.</p>
      </div>
    </div>
    <div class="login-panel">
      <div class="login-logo">🍽️</div>
      <h1>Staff Login</h1>
      <p class="sub">Kitchen Orders — sign in to take orders, run the kitchen board &amp; the waitlist.</p>
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
      <p class="sub" id="goto-signup" style="text-align:center">New here? <a class="link" href="#" id="show-signup">Create an account</a></p>
      <form id="signup-form" style="display:none">
        <label class="field">
          <span>Username</span>
          <input id="su-user" autocomplete="username" placeholder="e.g. priya99" />
          <span class="hint" id="su-user-hint">Min 5 characters, or 4 characters with a number.</span>
        </label>
        <label class="field">
          <span>Password</span>
          <input id="su-pass" type="password" autocomplete="new-password" placeholder="••••••••" />
        </label>
        <label class="field">
          <span>Email</span>
          <input id="su-email" type="email" autocomplete="email" placeholder="you@example.com" />
        </label>
        <label class="field">
          <span>Phone <em style="font-weight:400">(optional)</em></span>
          <input id="su-phone" type="tel" autocomplete="tel" placeholder="+1 555 123 4567" />
        </label>
        <label class="field">
          <span>Restaurant / company name</span>
          <input id="su-restaurant" autocomplete="organization" placeholder="e.g. Nankana's Kitchen" />
        </label>
        <button class="btn block" id="signup-btn" type="submit">Create account</button>
        <p class="sub" style="text-align:center">Already have an account? <a class="link" href="#" id="show-login">Log in</a></p>
      </form>
      <p class="sub" style="text-align:center;margin-top:18px"><a class="link" href="/">← Back to home</a></p>
    </div>
  </div>`;

  const loginForm = document.getElementById('login-form');
  const signupForm = document.getElementById('signup-form');
  const gotoSignup = document.getElementById('goto-signup');
  const errBox = document.getElementById('login-error');
  const showErr = (msg) => {
    errBox.textContent = msg;
    errBox.style.display = 'block';
  };
  const hideErr = () => {
    errBox.style.display = 'none';
  };
  document.getElementById('show-signup').addEventListener('click', (e) => {
    e.preventDefault();
    hideErr();
    loginForm.style.display = 'none';
    gotoSignup.style.display = 'none';
    signupForm.style.display = 'block';
  });
  document.getElementById('show-login').addEventListener('click', (e) => {
    e.preventDefault();
    hideErr();
    signupForm.style.display = 'none';
    loginForm.style.display = 'block';
    gotoSignup.style.display = 'block';
  });

  // Username rule: at least 5 characters, or 4 characters including a number.
  const USER_RE = /^[a-zA-Z0-9._-]{4,32}$/;
  const usernameProblem = (u) => {
    if (!USER_RE.test(u)) return 'Username must be 4–32 characters (letters, numbers, . _ -).';
    if (u.length < 5 && !/\d/.test(u)) return 'Min 5 characters, or 4 characters with a number.';
    return null;
  };

  // Live availability check under the signup username field.
  const suUser = document.getElementById('su-user');
  const suHint = document.getElementById('su-user-hint');
  const HINT_DEFAULT = 'Min 5 characters, or 4 characters with a number.';
  let availTimer = null;
  const setHint = (msg, ok) => {
    suHint.textContent = msg;
    suHint.style.color = ok === true ? '#1a7f37' : ok === false ? '#c0392b' : '';
  };
  suUser.addEventListener('input', () => {
    clearTimeout(availTimer);
    const u = suUser.value.trim();
    if (!u) {
      setHint(HINT_DEFAULT, null);
      return;
    }
    const prob = usernameProblem(u);
    if (prob) {
      setHint(prob, false);
      return;
    }
    setHint('Checking availability…', null);
    availTimer = setTimeout(async () => {
      try {
        const r = await fetch('/api/auth/username-available?username=' + encodeURIComponent(u));
        const d = await r.json();
        if (suUser.value.trim() === u) setHint(d.message, d.available);
      } catch {
        if (suUser.value.trim() === u) setHint('Could not check availability.', null);
      }
    }, 400);
  });

  const loginBtn = document.getElementById('login-btn');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginBtn.disabled = true;
    loginBtn.innerHTML = '<span class="spinner"></span> Signing in…';
    hideErr();
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('login-user').value.trim(),
          password: document.getElementById('login-pass').value,
        }),
      });
      saveSession(data.token, data.user);
      go('/staff');
    } catch (err) {
      showErr(err.message);
      loginBtn.disabled = false;
      loginBtn.textContent = 'Log in';
    }
  });

  const signupBtn = document.getElementById('signup-btn');
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideErr();
    const username = document.getElementById('su-user').value.trim();
    const password = document.getElementById('su-pass').value;
    const email = document.getElementById('su-email').value.trim();
    const phone = document.getElementById('su-phone').value.trim();
    const restaurantName = document.getElementById('su-restaurant').value.trim();
    const prob = usernameProblem(username);
    if (prob) return showErr(prob);
    if (password.length < 6) return showErr('Password must be at least 6 characters.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr('Please enter a valid email address.');
    if (phone && !/^[+()\-.\s\d]{7,25}$/.test(phone)) return showErr('Please enter a valid phone number.');
    if (!restaurantName) return showErr('Please enter your restaurant or company name.');
    signupBtn.disabled = true;
    signupBtn.innerHTML = '<span class="spinner"></span> Creating account…';
    try {
      const data = await api('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ username, password, email, phone, restaurant_name: restaurantName }),
      });
      saveSession(data.token, data.user);
      go('/staff');
    } catch (err) {
      showErr(err.message);
      signupBtn.disabled = false;
      signupBtn.textContent = 'Create account';
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
        ${canOrder ? '<a class="btn secondary" href="/staff/report">Order stats</a>' : ''}
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
      const created = await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
      go(`/staff/orders/${created.id}`);
      return;
    } catch (e) {
      busy = false;
      error = e.message;
      preserveAndRender();
    }
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

/* ------------------------- staff sales report ------------------------- */

function ReportPage() {
  if (getViewRole() !== 'ADMIN') {
    go('/staff');
    return () => {};
  }
  const todayStr = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local tz
  let mode = 'preset'; // 'preset' | 'single' | 'custom'
  let preset = 'today'; // 'today' | 'yesterday' | 'last7' | 'last30' | 'all'
  let dayStr = todayStr();
  let fromStr = '';
  let toStr = '';
  let data = null;
  let daily = [];
  let loading = false;
  let error = null;

  function shiftStr(ds, delta) {
    const [y, m, d] = ds.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + delta);
    return dt.toLocaleDateString('en-CA');
  }

  // N local days starting at ds -> UTC [from, to)
  function rangeDays(ds, n) {
    const [y, m, d] = ds.split('-').map(Number);
    return {
      from: new Date(y, m - 1, d).toISOString(),
      to: new Date(y, m - 1, d + n).toISOString(),
    };
  }

  function currentRange() {
    const t = todayStr();
    if (mode === 'single') return { range: rangeDays(dayStr, 1), label: prettyDay(dayStr) };
    if (mode === 'custom') {
      const n = Math.round((new Date(toStr) - new Date(fromStr)) / 86400000) + 1;
      return { range: rangeDays(fromStr, n), label: `${prettyDay(fromStr)} – ${prettyDay(toStr)}` };
    }
    if (preset === 'today') return { range: rangeDays(t, 1), label: prettyDay(t) };
    if (preset === 'yesterday') {
      const y = shiftStr(t, -1);
      return { range: rangeDays(y, 1), label: prettyDay(y) };
    }
    if (preset === 'last7') {
      const s = shiftStr(t, -6);
      return { range: rangeDays(s, 7), label: `${prettyDay(s)} – ${prettyDay(t)}` };
    }
    if (preset === 'last30') {
      const s = shiftStr(t, -29);
      return { range: rangeDays(s, 30), label: `${prettyDay(s)} – ${prettyDay(t)}` };
    }
    return { range: null, label: 'All time' };
  }

  function prettyDay(ds) {
    const [y, m, d] = ds.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
    });
  }

  async function load() {
    try {
      daily = await api('/api/orders/report/daily?days=7');
    } catch (e) {
      error = e.message;
    }
    await loadStats(false);
    render();
  }

  async function loadStats(rerender = true) {
    loading = true;
    if (rerender) render();
    const { range } = currentRange();
    const qs = range
      ? `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
      : '';
    try {
      data = await api(`/api/orders/report/summary${qs}`);
      error = null;
    } catch (e) {
      error = e.message;
    }
    loading = false;
    if (rerender) render();
  }

  function stat(label, value) {
    return `<div class="card" style="flex:1;min-width:130px;text-align:center">
      <div class="sub" style="margin-bottom:4px">${label}</div>
      <div style="font-size:20px;font-weight:800">${value}</div>
    </div>`;
  }

  function summaryCardsHTML(d) {
    return `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px">
        ${stat('Orders completed', d.orders)}
        ${stat('Items sold', d.items.reduce((s, i) => s + i.qty, 0))}
        ${stat('Gross', money(d.item_gross_cents))}
        ${stat('Item discounts', '−' + money(d.item_discount_cents))}
        ${stat('Order discounts', '−' + money(d.order_discount_cents))}
        ${stat('Net revenue', money(d.net_cents))}
      </div>`;
  }

  function itemsTableHTML(d) {
    return `
      <div class="card">
        <h2>Items sold</h2>
        ${
          d.items.length === 0
            ? '<div class="empty">No completed orders in this period.</div>'
            : `<div style="overflow-x:auto"><table class="orders static">
                <thead><tr><th>Item</th><th>Orders</th><th>Qty</th><th>Amount</th><th>Discount</th><th>Net</th></tr></thead>
                <tbody>
                  ${d.items
                    .map(
                      (i) => `<tr>
                        <td><b>${esc(i.item_name)}</b></td>
                        <td>${i.orders}</td>
                        <td>${i.qty}</td>
                        <td>${money(i.gross_cents)}</td>
                        <td>${i.discount_cents > 0 ? '−' + money(i.discount_cents) : '—'}</td>
                        <td><b>${money(i.net_cents)}</b></td>
                      </tr>`
                    )
                    .join('')}
                </tbody>
              </table></div>`
        }
      </div>`;
  }

  function presetBtn(key, label) {
    const active = mode === 'preset' && preset === key;
    return `<button class="btn ${active ? '' : 'secondary'} sm" data-preset="${key}">${label}</button>`;
  }

  function render() {
    const { label } = currentRange();
    const t = todayStr();
    root.innerHTML = `
    ${topBar()}
    <div class="page wide">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h1>Order stats</h1>
        <a class="btn secondary" href="/staff">← Orders</a>
      </div>
      <div class="card">
        <div class="btn-row" style="margin-top:0">
          ${presetBtn('today', 'Today')}
          ${presetBtn('yesterday', 'Yesterday')}
          ${presetBtn('last7', 'Last 7 days')}
          ${presetBtn('last30', 'Last 30 days')}
          ${presetBtn('all', 'All time')}
        </div>
        <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-top:12px">
          <label class="sub">Date<br /><input type="date" id="stats-day" value="${esc(dayStr)}" max="${t}" /></label>
          <label class="sub">From<br /><input type="date" id="stats-from" value="${esc(fromStr)}" max="${t}" /></label>
          <label class="sub">To<br /><input type="date" id="stats-to" value="${esc(toStr)}" max="${t}" /></label>
          <button class="btn secondary sm" id="stats-apply">Apply range</button>
        </div>
        <div class="sub" style="margin:10px 0 0">Showing: <b>${esc(label)}</b></div>
      </div>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      ${
        loading || !data
          ? '<div class="card"><div class="empty">Loading…</div></div>'
          : `${summaryCardsHTML(data)}${itemsTableHTML(data)}`
      }
      <div class="card">
        <h2>Last 7 days</h2>
        ${
          daily.length === 0
            ? '<div class="empty">No completed orders yet.</div>'
            : `<div style="overflow-x:auto"><table class="orders">
                <thead><tr><th>Day</th><th>Orders</th><th>Items sold</th><th>Net revenue</th></tr></thead>
                <tbody>
                  ${daily
                    .map(
                      (r) => `<tr data-day-jump="${esc(r.day)}">
                        <td><b>${esc(prettyDay(r.day))}</b></td>
                        <td>${r.orders}</td>
                        <td>${r.items}</td>
                        <td><b>${money(r.net_cents)}</b></td>
                      </tr>`
                    )
                    .join('')}
                </tbody>
              </table></div>
              <p class="sub" style="margin-bottom:0">Tap a day to see its item breakdown above.</p>`
        }
      </div>
    </div>`;
    wireTopBar();

    root.querySelectorAll('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => {
        mode = 'preset';
        preset = b.dataset.preset;
        loadStats();
      })
    );
    const dayInput = document.getElementById('stats-day');
    if (dayInput)
      dayInput.addEventListener('change', () => {
        if (dayInput.value) {
          mode = 'single';
          dayStr = dayInput.value;
          loadStats();
        }
      });
    const applyBtn = document.getElementById('stats-apply');
    if (applyBtn)
      applyBtn.addEventListener('click', () => {
        const f = document.getElementById('stats-from').value;
        const tt = document.getElementById('stats-to').value;
        if (!f || !tt) {
          error = 'Pick both From and To dates for a custom range.';
          render();
          return;
        }
        if (f > tt) {
          error = 'The From date must be on or before the To date.';
          render();
          return;
        }
        mode = 'custom';
        fromStr = f;
        toStr = tt;
        loadStats();
      });
    root.querySelectorAll('[data-day-jump]').forEach((tr) =>
      tr.addEventListener('click', () => {
        mode = 'single';
        dayStr = tr.dataset.dayJump;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        loadStats();
      })
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
  let editingRow = null; // index of the item row expanded for inline editing
  let editDirty = false; // unsaved item edits pending
  let codeBusy = false;
  let codeError = null; // discount code error for the single order-level code field

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
        editingRow = null;
        editDirty = false;
        codeError = null;
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

  // Items list: admin gets a per-item edit icon that expands inline editing
  // (qty, price, remove). Everyone else sees a read-only list.
  function displayLines() {
    if (editable()) return editInit();
    return order.items.map((it) => ({
      name: it.item_name,
      qty: it.quantity,
      unit_price: it.unit_price_cents,
      discount_cents: it.discount_cents || 0,
      discount_code: it.discount_code || null,
      code_discount_cents: it.code_discount_cents || 0,
    }));
  }

  function lineDiscHTML(l) {
    const lineDisc = (l.discount_cents || 0) + (l.code_discount_cents || 0);
    return lineDisc > 0
      ? `<br /><span class="sub">${l.discount_code ? `Discount (${esc(l.discount_code)})` : 'Item discount'} −${money(lineDisc)}</span>`
      : '';
  }

  function editRowHTML(l, i) {
    return `
      <div style="padding:8px 0 10px 10px;border-left:3px solid var(--accent,#e08a3c);margin:2px 0 8px">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <span class="qty">
            <button data-edit-dec="${i}" aria-label="decrease">−</button>
            <b>${l.qty}</b>
            <button data-edit-inc="${i}" aria-label="increase">+</button>
          </span>
          <label class="sub">$<input data-edit-price="${i}" inputmode="decimal"
            value="${(l.unit_price / 100).toFixed(2)}" style="max-width:80px" /></label>
          <button class="btn secondary sm" data-edit-del="${i}">🗑 Remove</button>
          <button class="btn secondary sm" data-edit-row-done>Done</button>
        </div>
      </div>`;
  }

  function itemsListHTML() {
    const canEdit = editable();
    const lines = displayLines();
    return `
        ${lines
          .map(
            (l, i) => `
          <div class="item-row" style="align-items:center">
            <span>${esc(l.name)} <b>×${l.qty}</b>${lineDiscHTML(l)}</span>
            <span style="display:flex;gap:8px;align-items:center">
              <span>${money(l.qty * l.unit_price)}</span>
              ${canEdit ? `<button class="btn secondary sm" data-edit-row="${i}" title="Edit item">✏️</button>` : ''}
            </span>
          </div>
          ${canEdit && editingRow === i ? editRowHTML(l, i) : ''}`
          )
          .join('') || '<div class="empty">No items.</div>'}
        ${canEdit ? `
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">
          <input id="edit-add-name" placeholder="Add item…" style="flex:2;min-width:110px" />
          <input id="edit-add-price" placeholder="$0.00" inputmode="decimal" style="flex:1;min-width:80px" />
          <button class="btn secondary sm" id="edit-add">Add</button>
        </div>
        <div style="margin-top:10px">
          <textarea id="edit-notes" rows="2" placeholder="Special instructions (e.g. less spicy, no onions)"
            style="width:100%">${esc(editNotes ?? order.special_instructions ?? '')}</textarea>
        </div>` : ''}
        ${!canEdit && isAdmin() && order && !['PENDING_PAYMENT', 'PAID', 'RECEIVED', 'CANCELLED'].includes(order.order_status)
          ? '<div class="info" style="margin-top:8px">🔒 The kitchen has started preparing this order — items can no longer be edited.</div>'
          : ''}
        ${canEdit ? `
        <div class="btn-row" style="margin-top:12px;align-items:center">
          <button class="btn" id="edit-save" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save changes'}</button>
          <button class="btn secondary" id="edit-cancel">Cancel</button>
          <span class="sub">New total: <b>${money(Math.max(0, editTotal() - (order.discount_cents || 0)))}</b></span>
        </div>` : ''}`;
  }

  // Discount: ONE code per order. It is applied server-side to every line it is
  // valid for (item-restricted codes only touch their item) — never stacked.
  function discountCardHTML() {
    if (!editable()) return '';
    const activeCode =
      [...new Set(order.items.map((it) => it.discount_code).filter(Boolean))][0] || null;
    const codeTotal = order.items.reduce(
      (s, it) => s + (it.discount_code ? (it.discount_cents || 0) + (it.code_discount_cents || 0) : 0),
      0
    );
    return `
      <div class="card">
        <h2>Discount</h2>
        <p class="sub" style="margin-top:0">One code per order — it applies automatically to every
          item it is valid for. Manage codes in <a class="link" href="/staff/discounts">Discounts</a>.</p>
        ${
          activeCode
            ? `<div class="item-row" style="align-items:center">
                 <span>Discount (<b>${esc(activeCode)}</b>) <span class="sub">−${money(codeTotal)}</span></span>
                 <button class="btn secondary sm" id="code-remove" ${codeBusy ? 'disabled' : ''}>Remove</button>
               </div>`
            : `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                 <input id="order-code" placeholder="CODE" autocapitalize="characters"
                   style="max-width:140px;text-transform:uppercase" />
                 <button class="btn secondary sm" id="code-apply" ${codeBusy ? 'disabled' : ''}>${
                   codeBusy ? 'Applying…' : 'Apply'
                 }</button>
               </div>`
        }
        ${codeError ? `<div class="error" style="margin:8px 0 0">${esc(codeError)}</div>` : ''}
      </div>`;
  }

  // Lines as they stand on the server (per-line codes are set via apply_code).
  function currentLines() {
    return order.items.map((it) => ({
      name: it.item_name,
      qty: it.quantity,
      unit_price: it.unit_price_cents,
      discount_cents: it.discount_cents || 0,
    }));
  }

  async function sendOrderCode(applyCode) {
    if (editDirty) {
      showNotice('Save your item changes first, then change the discount.');
      return;
    }
    codeBusy = true;
    codeError = null;
    error = null;
    render();
    try {
      await api(`/api/orders/${order.id}/items`, {
        method: 'PATCH',
        body: JSON.stringify({ items: currentLines(), apply_code: applyCode }),
      });
      codeBusy = false;
      await load();
      const code =
        [...new Set(order.items.map((it) => it.discount_code).filter(Boolean))][0] || null;
      showNotice(code ? `Discount (${code}) applied.` : 'Discount code removed.');
    } catch (e) {
      codeBusy = false;
      codeError = e.message;
      render();
    }
  }

  async function applyOrderCode() {
    const input = document.getElementById('order-code');
    const code = (input ? input.value : '').trim();
    if (!code) {
      showNotice('Enter a discount code first.');
      return;
    }
    await sendOrderCode(code);
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
        ${itemsListHTML()}
        ${order.discount_cents > 0 ? `<div class="item-row"><span>Order discount</span><span>−${money(order.discount_cents)}</span></div>` : ''}
        <div class="total-row"><span>Total</span><span>${money(order.total_cents)}</span></div>
        <div class="sub" style="margin-top:10px">
          ${order.customer_name ? `<div>Customer: ${esc(order.customer_name)}</div>` : ''}
          ${order.customer_phone ? `<div>Phone: ${esc(order.customer_phone)}</div>` : ''}
          ${order.special_instructions ? `<div>Note: ${esc(order.special_instructions)}</div>` : ''}
          <div>Created: ${esc(new Date(order.created_at).toLocaleString())}</div>
        </div>
      </div>

      ${discountCardHTML()}

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
        <p class="sub" style="margin:10px 0 0">
          Card payments via Stripe Checkout open automatically when Stripe keys are configured. Demo payments are
          for testing only and must be disabled in production (DEMO_PAYMENTS=false).
        </p>
      </div>`
          : `
      ${order.order_status === 'PAID' ? `<div class="card"><div class="info">💡 Next step: open the <a class="link" href="/kitchen">Kitchen page</a> and tap <b>Accept order</b> to start preparing it.</div></div>` : ''}
      <div class="card qr-box">
        <h2>✅ Payment confirmed</h2>
        ${order.restaurant_name ? `<p class="sub" style="margin:0"><b>${esc(order.restaurant_name)}</b></p>` : ''}
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

    // --- inline per-item editing (admin, pending orders only) ---
    root.querySelectorAll('[data-edit-inc]').forEach((b) =>
      b.addEventListener('click', () => {
        const l = editInit()[Number(b.dataset.editInc)];
        if (l && l.qty < 99) {
          l.qty++;
          editDirty = true;
        }
        render();
      })
    );
    root.querySelectorAll('[data-edit-dec]').forEach((b) =>
      b.addEventListener('click', () => {
        const l = editInit()[Number(b.dataset.editDec)];
        if (l && l.qty > 1) {
          l.qty--;
          editDirty = true;
        }
        render();
      })
    );
    root.querySelectorAll('[data-edit-del]').forEach((b) =>
      b.addEventListener('click', () => {
        editInit().splice(Number(b.dataset.editDel), 1);
        editingRow = null;
        editDirty = true;
        render();
      })
    );
    root.querySelectorAll('[data-edit-row]').forEach((b) =>
      b.addEventListener('click', () => {
        const i = Number(b.dataset.editRow);
        editingRow = editingRow === i ? null : i;
        render();
      })
    );
    root.querySelectorAll('[data-edit-row-done]').forEach((b) =>
      b.addEventListener('click', () => {
        editingRow = null;
        render();
      })
    );
    root.querySelectorAll('[data-edit-price]').forEach((input) =>
      input.addEventListener('change', () => {
        const i = Number(input.dataset.editPrice);
        const v = Math.round(Number(input.value) * 100);
        const l = editInit()[i];
        if (l && Number.isFinite(v) && v >= 0) {
          l.unit_price = v;
          editDirty = true;
        }
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
        editDirty = true;
        render();
      });
    const notesEl = document.getElementById('edit-notes');
    if (notesEl)
      notesEl.addEventListener('input', () => {
        editNotes = notesEl.value;
        editDirty = true;
      });
    const cancelBtn = document.getElementById('edit-cancel');
    if (cancelBtn)
      cancelBtn.addEventListener('click', () => {
        editLines = null;
        editNotes = null;
        editingRow = null;
        editDirty = false;
        render();
      });
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

    // --- discount code (admin, before payment): one code per order ---
    const codeApplyBtn = document.getElementById('code-apply');
    if (codeApplyBtn) codeApplyBtn.addEventListener('click', applyOrderCode);
    const codeRemoveBtn = document.getElementById('code-remove');
    if (codeRemoveBtn) codeRemoveBtn.addEventListener('click', () => sendOrderCode(''));
    const orderCodeInput = document.getElementById('order-code');
    if (orderCodeInput)
      orderCodeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyOrderCode();
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
        <div class="brand"><span>●</span> ${esc(order.restaurant_name || 'Kitchen Orders')}</div>
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
