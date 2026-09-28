#!/usr/bin/env python3
"""End-to-end smoke test for the Kitchen QR app."""
import json, urllib.request, urllib.error, sys

BASE = "http://localhost:3000"
passed, failed = 0, 0

def req(method, path, token=None, body=None, raw=False):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    if data: r.add_header("Content-Type", "application/json")
    if token: r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r) as resp:
            b = resp.read()
            return resp.status, (b if raw else (json.loads(b) if b else None))
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, json.loads(b)
        except Exception: return e.code, b

def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {detail}")

print("== auth ==")
s, d = req("POST", "/api/auth/login", body={"username": "counter", "password": "wrong"})
check("bad password rejected", s == 401, f"got {s}")
s, d = req("POST", "/api/auth/login", body={"username": "counter", "password": "counter123"})
check("counter login", s == 200 and "token" in d, f"got {s}")
counter_tok = d["token"]
s, d = req("POST", "/api/auth/login", body={"username": "kitchen", "password": "kitchen123"})
kitchen_tok = d["token"]
s, d = req("GET", "/api/orders", token="bogus")
check("bad token rejected", s == 401, f"got {s}")

print("== order creation ==")
s, d = req("POST", "/api/orders", token=counter_tok, body={"items": []})
check("empty items rejected", s == 400, f"got {s}")
s, d = req("POST", "/api/orders", token=counter_tok, body={
    "customer_name": "John", "customer_phone": "+15551234567",
    "special_instructions": "Less spicy",
    "items": [
        {"name": "Chicken Biryani", "qty": 2, "unit_price": 1299},
        {"name": "Chicken 65", "qty": 1, "unit_price": 899},
        {"name": "Garlic Naan", "qty": 2, "unit_price": 349},
    ]})
check("order created", s == 201 and d["total_cents"] == 4195, f"got {s} {d}")
oid, ptoken, onum = d["id"], d["public_token"], d["order_number"]
check("token is 32 hex chars", len(ptoken) == 32 and all(c in "0123456789abcdef" for c in ptoken), ptoken)
check("order number >= 1000", onum >= 1000, str(onum))

print("== payment gating ==")
s, d = req("GET", f"/api/orders/{oid}/qr.png", token=counter_tok, raw=True)
check("QR blocked before payment", s == 409, f"got {s}")
s, d = req("PATCH", f"/api/orders/{oid}/status", token=counter_tok, body={"status": "PAID"})
check("staff cannot set PAID directly", s == 400, f"got {s}")
s, d = req("PATCH", f"/api/orders/{oid}/status", token=kitchen_tok, body={"status": "READY"})
check("invalid transition rejected", s == 409, f"got {s}")
s, d = req("POST", f"/api/orders/{oid}/payments/demo", token=counter_tok)
check("demo payment confirms", s == 200 and d["order_status"] == "PAID", f"got {s} {d}")
s, d = req("POST", f"/api/orders/{oid}/payments/demo", token=counter_tok)
check("double payment is idempotent", s == 200 and d["order_status"] == "PAID", f"got {s}")

print("== QR generation ==")
s, img = req("GET", f"/api/orders/{oid}/qr.png", token=counter_tok, raw=True)
check("QR png served after payment", s == 200 and img[:8] == b"\x89PNG\r\n\x1a\n", f"got {s}")
open("/tmp/test-qr.png", "wb").write(img)

print("== public customer page ==")
s, d = req("GET", f"/api/orders/token/{ptoken}")
check("public order loads", s == 200 and d["order_number"] == onum, f"got {s}")
check("no phone leaked publicly", "customer_phone" not in d, str(d.keys()))
check("3 line items", len(d["items"]) == 3, str(d))
s, d = req("GET", "/api/orders/token/deadbeefdeadbeefdeadbeefdeadbeef")
check("bad token 404s", s == 404, f"got {s}")

print("== status pipeline ==")
for st in ["RECEIVED", "PREPARING", "READY", "COMPLETED"]:
    s, d = req("PATCH", f"/api/orders/{oid}/status", token=kitchen_tok, body={"status": st})
    check(f"kitchen -> {st}", s == 200 and d["order_status"] == st, f"got {s} {d}")
s, d = req("PATCH", f"/api/orders/{oid}/status", token=kitchen_tok, body={"status": "CANCELLED"})
check("kitchen cannot cancel", s == 403, f"got {s}")
s, d = req("PATCH", f"/api/orders/{oid}/status", token=counter_tok, body={"status": "PREPARING"})
check("counter cannot do prep statuses", s == 403, f"got {s}")

print("== dashboard + history ==")
s, d = req("GET", "/api/orders?status=COMPLETED", token=counter_tok)
check("filter by status", s == 200 and any(o["id"] == oid for o in d), f"got {s}")
s, d = req("GET", f"/api/orders/{oid}", token=counter_tok)
hist = [h["new_status"] for h in d["history"]]
check("history recorded", hist == ["PENDING_PAYMENT","PAID","RECEIVED","PREPARING","READY","COMPLETED"], str(hist))
check("tracking url present", d["tracking_url"].endswith(f"/order/{ptoken}"), d["tracking_url"])

print("== push endpoints ==")
s, d = req("GET", "/api/notifications/vapid-key")
check("vapid key exposed", s == 200 and d["enabled"] and len(d["publicKey"]) > 40, f"got {s}")
s, d = req("POST", "/api/notifications/subscribe", body={"token": ptoken, "subscription": {"endpoint": "https://example.com/x", "keys": {"p256dh": "a", "auth": "b"}}, "device_type": "test"})
check("subscription saved", s == 200 and d["ok"], f"got {s} {d}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
