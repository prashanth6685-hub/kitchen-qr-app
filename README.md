# Kitchen QR — Counter Ordering & Notification App

A web app for food/kitchen counters. Staff create orders and take payment, the
customer scans a QR code, and gets **live order-status updates with push
notifications** — no customer app install, no customer login.

**How it works:** Counter staff create an order → take payment → a QR code is
generated **only after payment is confirmed** → customer scans it with their
phone camera → live tracking page with push notifications on every status
change → kitchen staff move the order RECEIVED → PREPARING → READY → COMPLETED.

## Languages & technologies

| Language / Technology | Used for | Short note |
|---|---|---|
| **TypeScript** | Entire codebase (frontend + backend) | One language everywhere; catches bugs at compile time before they reach the counter |
| **Node.js 22+** | Backend runtime | Runs the API server; v22+ includes built-in SQLite so no native database drivers are needed |
| **Express** | HTTP server & REST API | Lightweight framework handling all routes: auth, orders, payments, push, QR |
| **node:sqlite** | Database | Embedded SQL database built into Node — zero setup, the whole DB is one file (`kitchen.db`) |
| **Vanilla JavaScript (ES modules)** | Web UI | No framework, no build step — the browser loads `app.js` directly; works anywhere static files can be served |
| **HTML + CSS** | Pages & styling | Hand-written, mobile-first styles; no CSS framework |
| **PWA** (service worker + manifest) | Installable app | Staff/customers can "Add to Home Screen" on iPhone and get an app-like experience |
| **Web Push (VAPID)** | Customer notifications | Sends "Your order is ready!" push notifications even when the browser is closed; `web-push` library on the server |
| **Server-Sent Events (SSE)** | Live updates | One-way realtime stream — the customer's tracking page updates the instant kitchen changes a status |
| **JSON Web Tokens (JWT)** | Staff login sessions | Signed tokens prove who staff are on every request; roles (admin/counter/kitchen) enforced server-side |
| **bcryptjs** | Password hashing | Staff passwords are never stored in plain text |
| **Stripe** | Real card payments | Checkout + signature-verified webhook; payment counts **only** when Stripe's webhook confirms it — never from the browser |
| **qrcode** | QR code generation | Generates the scannable PNG that links the customer to their order's secure tracking page |
| **tsx** | Running TypeScript | Runs the backend directly from `.ts` source — no separate compile step in development |
| **dotenv** | Configuration | Loads secrets and settings (Stripe keys, push keys, DB path) from `server/.env` |
| **Python** | Smoke tests | `scripts/smoke-test.py` runs 28 end-to-end API checks (auth, payment gating, status rules, privacy) |

## Architecture

```
Customer phone                Counter staff              Kitchen display
     │                              │                              │
     │  scan QR                     │  create order + payment      │  update status
     ▼                              ▼                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Express API (Node + TypeScript)    │  React PWA (TypeScript)           │
│  • JWT auth + role checks          │  • /staff   counter dashboard      │
│  • Payment choke point: QR only    │  • /kitchen big-card display       │
│    after webhook-confirmed payment │  • /order/:token customer tracker │
│  • SSE live streams                │  • push subscribe + offline shell │
│  • node:sqlite (one file DB)       │                                   │
└─────────────────────────────────────────────────────────────────────────┘
     │                              │
     ▼                              ▼
 Stripe webhook ──► confirmed    Web Push (VAPID) ──► customer's phone
```

## Key guarantees (by design)

- **QR codes are payment-gated.** The QR endpoint returns `409` until the
  order is `PAID`. No payment, no valid QR — enforced in the backend, not the UI.
- **Payments are webhook-confirmed.** A "payment successful" message from the
  browser is never trusted; only Stripe's signature-verified webhook (or a
  recorded cash payment) marks an order paid.
- **Statuses are role-checked.** Kitchen staff can't cancel orders, counter
  staff can't run the kitchen pipeline, and illegal jumps (e.g. straight to
  READY) are rejected.
- **Customer privacy.** The public tracking page exposes no phone numbers —
  access is via an unguessable per-order token.
- **Discounts are snapshots.** A discount code applied to an order line is
  snapshotted (`discount_code`, `code_discount_cents`) onto that line — editing
  or deleting the code later never rewrites history.

## Discount codes

- Admin page **Orders → Discounts** (`/staff/discounts`): create, edit,
  publish/unpublish, and delete codes.
- A code is either **$ off per item** (e.g. `BIRYANI5` = $5 off each Chicken
  Biryani) or **% off** (e.g. `WELCOME10` = 10% off), and may be restricted to
  one menu item (matched by name, case-insensitive) or valid on any item.
- Inactive codes are unpublished — they stay in the list but can't be applied.
- Before payment, the admin applies a discount **code** per item in the Discount
  section (type the code and hit Apply — or Enter). No manual discount amounts;
  anything you need (e.g. 10% off) is just another code created on the Discounts
  page. Applied codes show as `Discount (CODE)`.
- The total is `items (net of per-item discounts) − order-level discount`.
- Each item row has an ✏️ icon for inline editing (quantity, price, remove);
  add items with the compact add row. Save / Cancel applies the changes.
- API: `GET /api/discount-codes` · `POST /api/discount-codes/validate` ·
  `POST / PUT / DELETE /api/discount-codes[/:id]` (admin)

## Sales report

- Admin page **Orders → Report** (`/staff/report`): totals across all
  **completed** orders — per item it shows orders, quantity sold, gross amount,
  discounts, and net; summary cards show orders completed, items sold, gross,
  item discounts, order discounts, and net revenue.
- **Daily tab**: pick a date (‹ › arrows or the date picker) to see that day's
  per-item sales — quantity, amount, discount, net — plus a Last 7 days trend
  table (tap a day to jump to its breakdown). Day boundaries use your local
  timezone.
- API: `GET /api/orders/report/summary[?from=&to=]` (admin),
  `GET /api/orders/report/daily?days=7` (admin). Orders record `completed_at`
  on the COMPLETED transition (backfilled from status history for old orders).

## Quick start

Requirements: Node.js 22+ (uses the built-in `node:sqlite`, no native builds).

```bash
# 1. Install server dependencies (the web UI needs no install, no build)
cd server && npm install && cd ..

# 2. Seed database (users, menu, VAPID keys for push)
cd server && npm run seed && cd ..

# 3. Run
./start.sh
# → http://localhost:3000
```

Or manually: `cd server && npm start` (serves the API **and** the web UI, which
is plain HTML/CSS/JS — no frontend build step, no bundler required).

## Staff logins (seeded)

| Username  | Password    | Role          |
|-----------|-------------|---------------|
| admin     | admin123    | ADMIN         |
| counter   | counter123  | COUNTER_STAFF |
| kitchen   | kitchen123  | KITCHEN_STAFF |

Change these in production. Admins do everything; counter staff create orders
and take payments; kitchen staff move orders through
RECEIVED → PREPARING → READY → COMPLETED.

## The flow

1. Counter staff: **New order** → pick items → create → take payment.
2. After payment is confirmed, a **QR code** appears. Print it or show it to
   the customer.
3. Customer scans with their phone camera → live tracking page at
   `/order/<secure-random-token>`.
4. Customer taps **Enable Notifications** → Web Push on status changes.
   (iPhone: push works best after Share → Add to Home Screen.)
5. Kitchen staff update status on the **Kitchen display** → the customer's
   page updates instantly via SSE, plus a push notification.

## Payments

- **Stripe (real cards):** set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
  in `server/.env`, then point the Stripe webhook at
  `https://<your-domain>/api/payments/webhook`. Payment is confirmed **only**
  via the verified webhook — never from the browser. QR codes generate only
  after confirmation.
- **Cash:** the counter can record "Cash received" — a real, auditable
  payment path.
- **Demo mode:** `DEMO_PAYMENTS=true` (default) enables a clearly-labeled
  simulated card payment for testing. **Set it to `false` in production.**

## Configuration (`server/.env`)

| Key                   | Purpose                                              |
|-----------------------|------------------------------------------------------|
| `PORT`                | HTTP port (default 3000)                             |
| `DATABASE_PATH`       | SQLite file (default `server/data/kitchen.db`)       |
| `PUBLIC_BASE_URL`     | Public URL used inside QR codes (must be HTTPS in prod) |
| `JWT_SECRET`          | Staff session signing (auto-generated by seed)       |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push keys (auto-generated by seed) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Real card payments (optional) |
| `DEMO_PAYMENTS`       | `true` enables the test-only demo payment button     |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | SMS "order ready" texts (optional). When unset, no SMS is sent. |

## Project structure

```
kitchen-qr-app/
├── start.sh                  # one-command launcher
├── server/
│   └── src/
│       ├── server.ts         # Express app: routes + static client serving
│       ├── schema.sql        # organizations → locations → counters → orders…
│       ├── db.ts             # SQLite connection + migrations
│       ├── auth.ts           # JWT login, roles, ?token= for SSE/QR
│       ├── orders.ts         # order CRUD, transition + role validation
│       ├── payments.ts       # Stripe/cash/demo; the payment choke point
│       ├── push.ts           # Web Push (VAPID) subscriptions + sending
│       ├── sse.ts            # live event streams (staff + customer)
│       ├── qr.ts             # QR PNG generation (409 before payment)
│       └── seed.ts           # demo users, menu, keys
├── client/                      # zero-dependency web UI (no build, no bundler)
│   ├── index.html
│   ├── app.js                  # router + all pages (staff, kitchen, customer)
│   ├── styles.css
│   ├── sw.js                   # service worker: push + offline shell
│   └── manifest.webmanifest    # PWA install metadata
├── scripts/smoke-test.py     # 28 end-to-end API checks
└── docs/                     # screenshots
```

## API overview

- `POST /api/auth/login`, `GET /api/auth/me`
- `POST /api/orders` · `GET /api/orders` · `GET /api/orders/:id`
- `PATCH /api/orders/:id/status` (role-checked, transition-validated)
- `GET /api/orders/:id/qr.png` — 409 until payment is confirmed
- `GET /api/orders/token/:token` — public customer view (no phone number)
- `GET /api/orders/token/:token/events` — public SSE stream
- `GET /api/orders/events?token=…` — staff SSE stream
- `POST /api/orders/:id/payments/stripe|cash|demo`
- `POST /api/payments/webhook` — Stripe, signature-verified
- `POST /api/notifications/subscribe` · `GET /api/notifications/vapid-key`
- `GET /api/menu`, `GET /api/counters`

## Production notes

- Serve behind HTTPS (required for Web Push, PWA install, and Stripe).
- Set `PUBLIC_BASE_URL` to your public domain so QR codes point at it.
- Set `DEMO_PAYMENTS=false`, use strong staff passwords, and back up
  `server/data/kitchen.db`.
- The schema already has `organizations → locations → counters` for
  multi-location support later.

## Tests

```bash
python3 scripts/smoke-test.py   # 28 end-to-end API checks (needs the server running)
```
