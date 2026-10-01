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
s, d = req("POST", "/api/auth/login", body={"username": "admin", "password": "wrong"})
check("bad password rejected", s == 401, f"got {s}")
s, d = req("POST", "/api/auth/login", body={"username": "admin", "password": "admin123"})
check("admin login", s == 200 and "token" in d, f"got {s}")
counter_tok = d["token"]
s, d = req("POST", "/api/auth/login", body={"username": "ADMIN", "password": "admin123"})
check("login accepts uppercase username", s == 200 and d["user"]["username"] == "admin", f"got {s} {d}")
s, d = req("POST", "/api/auth/login", body={"username": "Admin", "password": "admin123"})
check("login accepts mixed-case username", s == 200, f"got {s}")
s, d = req("POST", "/api/auth/login", body={"username": "ADMIN", "password": "wrong"})
check("wrong password still rejected (any case)", s == 401, f"got {s}")
s, d = req("POST", "/api/auth/signup", body={"username": "ADMIN", "password": "secret1", "email": "casevar@gmail.com", "restaurant_name": "Dup"})
check("signup rejects case-variant of taken username", s == 409, f"got {s} {d}")
s, d = req("POST", "/api/auth/login", body={"username": "kitchen", "password": "kitchen123"})
kitchen_tok = d["token"]
s, d = req("GET", "/api/orders", token="bogus")
check("bad token rejected", s == 401, f"got {s}")

print("== signup & restaurant name ==")
import random as _r
su_name = f"owner{_r.randint(100000, 999999)}"
su_email = f"{su_name}@gmail.com"
s, d = req("GET", "/api/public/restaurant-name")
check("public restaurant name", s == 200 and d["name"] == "Nankana's Kitchen", f"got {s} {d}")
s, d = req("POST", "/api/auth/login", body={"username": "admin", "password": "admin123"})
check("login returns restaurant name", s == 200 and d["user"]["restaurant_name"] == "Nankana's Kitchen", f"got {s} {d}")
s, d = req("GET", "/api/auth/me", token=counter_tok)
check("me returns restaurant name", s == 200 and d["user"]["restaurant_name"] == "Nankana's Kitchen", f"got {s} {d}")
# username availability endpoint
s, d = req("GET", "/api/auth/username-available?username=admin")
check("availability: taken username", s == 200 and d["available"] is False, f"got {s} {d}")
s, d = req("GET", "/api/auth/username-available?username=" + su_name)
check("availability: free username", s == 200 and d["available"] is True, f"got {s} {d}")
s, d = req("GET", "/api/auth/username-available?username=ab")
check("availability: too short", s == 200 and d["available"] is False, f"got {s} {d}")
s, d = req("GET", "/api/auth/username-available?username=abcd")
check("availability: 4 chars no number", s == 200 and d["available"] is False, f"got {s} {d}")
s, d = req("GET", "/api/auth/username-available?username=abc1")
check("availability: 4 chars with number now rejected", s == 200 and d["available"] is False, f"got {s} {d}")
# signup validation
s, d = req("POST", "/api/auth/signup", body={"username": "ab", "password": "secret1", "email": "a@b.co", "restaurant_name": "Test"})
check("signup rejects short username", s == 400, f"got {s} {d}")
s, d = req("POST", "/api/auth/signup", body={"username": "abcd", "password": "secret1", "email": "a@b.co", "restaurant_name": "Test"})
check("signup rejects 4-char username without number", s == 400, f"got {s} {d}")
s, d = req("POST", "/api/auth/signup", body={"username": su_name, "password": "123", "email": su_email, "restaurant_name": "Test"})
check("signup rejects short password", s == 400, f"got {s} {d}")
s, d = req("POST", "/api/auth/signup", body={"username": su_name, "password": "secret1", "restaurant_name": "Test"})
check("signup requires email", s == 400, f"got {s} {d}")
s, d = req("POST", "/api/auth/signup", body={"username": su_name, "password": "secret1", "email": "not-an-email", "restaurant_name": "Test"})
check("signup rejects bad email", s == 400, f"got {s} {d}")
s, d = req("POST", "/api/auth/signup", body={"username": su_name, "password": "secret1", "email": "user@b.c", "restaurant_name": "Test"})
check("signup rejects single-char TLD", s == 400, f"got {s} {d}")
s, d = req("POST", "/api/auth/signup", body={"username": su_name, "password": "secret1", "email": su_email, "restaurant_name": "  "})
check("signup requires restaurant name", s == 400, f"got {s} {d}")
s, d = req("POST", "/api/auth/signup", body={"username": su_name, "password": "secret1", "email": su_email, "phone": "+15551234567", "restaurant_name": "Priya's Foods"})
check("signup creates admin account", s == 201 and d["user"]["role"] == "ADMIN" and d["user"]["restaurant_name"] == "Priya's Foods" and d["user"]["email"] == su_email and d["user"]["phone"] == "+15551234567" and "token" in d, f"got {s} {d}")
new_tok = d["token"]
s, d = req("POST", "/api/auth/signup", body={"username": su_name, "password": "secret1", "email": "other@gmail.com", "restaurant_name": "Other"})
check("signup rejects duplicate username", s == 409, f"got {s} {d}")
s, d = req("POST", "/api/auth/signup", body={"username": f"other{su_name}", "password": "secret1", "email": su_email.upper(), "restaurant_name": "Other"})
check("signup rejects duplicate email (any case)", s == 409, f"got {s} {d}")
s, d = req("POST", "/api/auth/signup", body={"username": "abc1", "password": "secret1", "email": f"n4-{su_name}@gmail.com", "restaurant_name": "Four"})
check("signup rejects 4-char username even with number", s == 400, f"got {s} {d}")
s, d = req("GET", "/api/auth/me", token=new_tok)
check("new user me has email and phone", s == 200 and d["user"]["email"] == su_email and d["user"]["phone"] == "+15551234567", f"got {s} {d}")
s, d = req("POST", "/api/orders", token=new_tok, body={"items": [{"name": "Garlic Naan", "qty": 1, "unit_price": 349}]})
check("new admin has full functionality", s == 201, f"got {s} {d}")
s, d = req("GET", f"/api/orders/token/{d['public_token']}")
check("customer order page carries restaurant name", s == 200 and d["restaurant_name"] == "Priya's Foods", f"got {s} {d}")

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
check("completed order is terminal", s == 409, f"got {s}")

print("== edit lock ==")
s, d = req("POST", "/api/orders", token=counter_tok, body={"items": [{"name": "Samosa", "qty": 2, "unit_price": 499}]})
oid2 = d["id"]
s, d = req("POST", f"/api/orders/{oid2}/payments/demo", token=counter_tok)
check("demo payment confirms", s == 200, f"got {s}")
s, d = req("PATCH", f"/api/orders/{oid2}/instructions", token=counter_tok, body={"special_instructions": "Extra chutney"})
check("instructions editable while PAID", s == 200, f"got {s}")
s, d = req("PATCH", f"/api/orders/{oid2}/status", token=kitchen_tok, body={"status": "RECEIVED"})
s, d = req("PATCH", f"/api/orders/{oid2}/items", token=counter_tok, body={"items": [{"name": "Samosa", "qty": 3, "unit_price": 499}]})
check("items editable while RECEIVED", s == 200, f"got {s}")
s, d = req("PATCH", f"/api/orders/{oid2}/discount", token=counter_tok, body={"discount_cents": 100})
check("discount editable while RECEIVED", s == 200, f"got {s}")
s, d = req("PATCH", f"/api/orders/{oid2}/status", token=kitchen_tok, body={"status": "PREPARING"})
for name, path, body in [
    ("items locked once preparing", f"/api/orders/{oid2}/items", {"items": [{"name": "Samosa", "qty": 1, "unit_price": 499}]}),
    ("discount locked once preparing", f"/api/orders/{oid2}/discount", {"discount_cents": 50}),
    ("instructions locked once preparing", f"/api/orders/{oid2}/instructions", {"special_instructions": "x"}),
]:
    s, d = req("PATCH", path, token=counter_tok, body=body)
    check(name, s == 409, f"got {s}")
s, d = req("GET", f"/api/orders/{oid2}", token=counter_tok)
check("instructions persisted", d["special_instructions"] == "Extra chutney", f"got {d['special_instructions']!r}")
s, d = req("PATCH", f"/api/orders/{oid2}/items", token=kitchen_tok, body={"items": [{"name": "Samosa", "qty": 1, "unit_price": 499}]})
check("kitchen role cannot edit items", s == 403, f"got {s}")

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

print("== partial completion ==")
s, d = req("POST", "/api/orders", token=counter_tok, body={"items": [{"name": "Mango Lassi", "qty": 4, "unit_price": 449}]})
oid3 = d["id"]
s, d = req("POST", f"/api/orders/{oid3}/payments/demo", token=counter_tok)
for st in ["RECEIVED", "PREPARING", "READY"]:
    s, d = req("PATCH", f"/api/orders/{oid3}/status", token=kitchen_tok, body={"status": st})
check("order at READY", s == 200 and d["order_status"] == "READY", f"got {s} {d}")
s, d = req("PATCH", f"/api/orders/{oid3}/status", token=kitchen_tok, body={"status": "PARTIALLY_COMPLETED"})
check("kitchen -> PARTIALLY_COMPLETED", s == 200 and d["order_status"] == "PARTIALLY_COMPLETED", f"got {s} {d}")
s, d = req("GET", "/api/orders?status=PARTIALLY_COMPLETED", token=counter_tok)
check("filter by PARTIALLY_COMPLETED", s == 200 and any(o["id"] == oid3 for o in d), f"got {s}")
s, d = req("PATCH", f"/api/orders/{oid3}/status", token=kitchen_tok, body={"status": "READY"})
check("PARTIALLY_COMPLETED -> READY rejected", s == 409, f"got {s}")
s, d = req("PATCH", f"/api/orders/{oid3}/items", token=counter_tok, body={"items": [{"name": "Mango Lassi", "qty": 1, "unit_price": 449}]})
check("items locked once partially completed", s == 409, f"got {s}")
s, d = req("PATCH", f"/api/orders/{oid3}/status", token=kitchen_tok, body={"status": "COMPLETED"})
check("PARTIALLY_COMPLETED -> COMPLETED", s == 200 and d["order_status"] == "COMPLETED", f"got {s} {d}")
s, d = req("PATCH", f"/api/orders/{oid3}/status", token=kitchen_tok, body={"status": "CANCELLED"})
check("kitchen cannot cancel from PARTIALLY_COMPLETED path", s == 403 or s == 409, f"got {s}")

print("== discount codes ==")
s, d = req("GET", "/api/discount-codes", token=counter_tok)
check("seeded codes listed", s == 200 and any(c["code"] == "BIRYANI5" for c in d), f"got {s} {d}")
s, d = req("GET", "/api/discount-codes")
check("codes list requires login", s == 401, f"got {s}")
s, d = req("POST", "/api/discount-codes/validate", token=counter_tok, body={"code": "biryani5", "item_name": "chicken biryani"})
check("code validates case-insensitively", s == 200 and d["ok"] and d["amount_cents"] == 500, f"got {s} {d}")
s, d = req("POST", "/api/discount-codes/validate", token=counter_tok, body={"code": "BIRYANI5", "item_name": "Garlic Naan"})
check("code rejected for wrong item", s == 400, f"got {s} {d}")
s, d = req("POST", "/api/discount-codes/validate", token=counter_tok, body={"code": "NOPE", "item_name": "Chicken Biryani"})
check("unknown code rejected", s == 404, f"got {s} {d}")
s, d = req("POST", "/api/discount-codes", token=kitchen_tok, body={"code": "PAV5", "amount_cents": 50})
check("kitchen cannot create codes", s == 403, f"got {s}")
s, d = req("POST", "/api/discount-codes", token=counter_tok, body={"code": "PAV5", "label": "50c off Vada Pav", "amount_cents": 50})
check("admin creates code", s == 201 and d["code"] == "PAV5", f"got {s} {d}")
pav_id = d["id"]
s, d = req("POST", "/api/discount-codes", token=counter_tok, body={"code": "pav5", "amount_cents": 50})
check("duplicate code rejected", s == 409, f"got {s}")
s, d = req("PUT", f"/api/discount-codes/{pav_id}", token=counter_tok, body={"active": False})
check("code unpublished", s == 200 and d["active"] == 0, f"got {s} {d}")
s, d = req("POST", "/api/discount-codes/validate", token=counter_tok, body={"code": "PAV5", "item_name": "Vada Pav"})
check("inactive code rejected", s == 400, f"got {s} {d}")
s, d = req("PUT", f"/api/discount-codes/{pav_id}", token=counter_tok, body={"active": True, "amount_cents": 75})
check("code edited", s == 200 and d["amount_cents"] == 75 and d["active"] == 1, f"got {s} {d}")

print("== per-item discounts on orders ==")
s, d = req("POST", "/api/orders", token=counter_tok, body={
    "customer_name": "Priya",
    "items": [
        {"name": "Chicken Biryani", "qty": 2, "unit_price": 1299, "discount_code": "biryani5"},
        {"name": "Garlic Naan", "qty": 2, "unit_price": 349, "discount_cents": 100},
    ]})
# biryani: 2*1299=2598 - 2*500=1598 ; naan: 2*349=698 - 100=598 ; total=2196
check("order with per-item discounts totals", s == 201 and d["total_cents"] == 2196, f"got {s} {d}")
oid4 = d["id"]
s, d = req("GET", f"/api/orders/{oid4}", token=counter_tok)
bir = next(i for i in d["items"] if i["item_name"] == "Chicken Biryani")
check("code snapshotted on line", bir["discount_code"] == "BIRYANI5" and bir["code_discount_cents"] == 1000, str(bir))
naan = next(i for i in d["items"] if i["item_name"] == "Garlic Naan")
check("manual line discount stored", naan["discount_cents"] == 100 and naan["discount_code"] is None, str(naan))
s, d = req("POST", "/api/orders", token=counter_tok, body={
    "items": [{"name": "Garlic Naan", "qty": 1, "unit_price": 349, "discount_code": "BIRYANI5"}]})
check("item-restricted code rejected on wrong item", s == 400, f"got {s} {d}")
s, d = req("PATCH", f"/api/orders/{oid4}/discount", token=counter_tok, body={"discount_cents": 200})
check("order-level discount stacks on net items", s == 200 and d["total_cents"] == 1996, f"got {s} {d}")
s, d = req("DELETE", f"/api/discount-codes/{pav_id}", token=counter_tok)
check("code deleted", s == 200, f"got {s}")
s, d = req("GET", f"/api/orders/{oid4}", token=counter_tok)
bir = next(i for i in d["items"] if i["item_name"] == "Chicken Biryani")
check("history survives code deletion", bir["discount_code"] == "BIRYANI5" and bir["code_discount_cents"] == 1000, str(bir))

print("== single order-level discount code ==")
s, d = req("POST", "/api/orders", token=counter_tok, body={"items": [
    {"name": "Chicken Biryani", "qty": 2, "unit_price": 1299},
    {"name": "Garlic Naan", "qty": 2, "unit_price": 349},
]})
check("code-test order created", s == 201, f"got {s} {d}")
oid6 = d["id"]
def o6items():
    return {i["item_name"]: i for i in req("GET", f"/api/orders/{oid6}", token=counter_tok)[1]["items"]}
base6 = [{"name": "Chicken Biryani", "qty": 2, "unit_price": 1299},
         {"name": "Garlic Naan", "qty": 2, "unit_price": 349}]
# item-restricted code applies only to its item
s, d = req("PATCH", f"/api/orders/{oid6}/items", token=counter_tok, body={"items": base6, "apply_code": "BIRYANI5"})
check("apply_code restricted: only its item", s == 200, f"got {s} {d}")
its = o6items()
check("biryani got the code", its["Chicken Biryani"]["discount_code"] == "BIRYANI5" and its["Chicken Biryani"]["code_discount_cents"] == 1000, str(its["Chicken Biryani"]))
check("naan untouched by restricted code", its["Garlic Naan"]["discount_code"] is None and its["Garlic Naan"]["code_discount_cents"] == 0, str(its["Garlic Naan"]))
# unrestricted code applies to every line, replacing the previous one (no stacking)
s, d = req("PATCH", f"/api/orders/{oid6}/items", token=counter_tok, body={"items": base6, "apply_code": "WELCOME10"})
check("apply_code replaces previous code", s == 200, f"got {s} {d}")
its = o6items()
check("welcome10 on all lines", all(i["discount_code"] == "WELCOME10" for i in its.values()), str(its))
check("percent math per line", its["Chicken Biryani"]["code_discount_cents"] == 260 and its["Garlic Naan"]["code_discount_cents"] == 70, str(its))
# clearing
s, d = req("PATCH", f"/api/orders/{oid6}/items", token=counter_tok, body={"items": base6, "apply_code": ""})
check("apply_code empty clears", s == 200 and all(i["discount_code"] is None for i in o6items().values()), f"got {s}")
# unknown code
s, d = req("PATCH", f"/api/orders/{oid6}/items", token=counter_tok, body={"items": base6, "apply_code": "NOPE"})
check("unknown apply_code rejected", s == 400, f"got {s} {d}")
# valid code that matches nothing in the order
s, d = req("POST", "/api/orders", token=counter_tok, body={"items": [{"name": "Garlic Naan", "qty": 1, "unit_price": 349}]})
oid7 = d["id"]
s, d = req("PATCH", f"/api/orders/{oid7}/items", token=counter_tok, body={
    "items": [{"name": "Garlic Naan", "qty": 1, "unit_price": 349}], "apply_code": "BIRYANI5"})
check("code matching no items rejected", s == 400, f"got {s} {d}")
# two distinct per-line codes can never stack, even via the legacy path
s, d = req("POST", "/api/orders", token=counter_tok, body={"items": [
    {"name": "Chicken Biryani", "qty": 1, "unit_price": 1299, "discount_code": "BIRYANI5"},
    {"name": "Garlic Naan", "qty": 1, "unit_price": 349, "discount_code": "WELCOME10"},
]})
check("stacked codes rejected", s == 400, f"got {s} {d}")

print("== sales report ==")
s, d = req("GET", "/api/orders/report/summary")
check("report requires login", s == 401, f"got {s}")
s, d = req("GET", "/api/orders/report/summary", token=kitchen_tok)
check("report is admin-only", s == 403, f"got {s}")
s, d = req("GET", "/api/orders/report/daily", token=kitchen_tok)
check("daily report is admin-only", s == 403, f"got {s}")
s, d = req("GET", "/api/orders/report/daily?days=7", token=counter_tok)
check("daily report loads", s == 200 and len(d) == 7, f"got {s} len={len(d) if isinstance(d, list) else '?'}")
check("daily rows shaped", all(set(r) == {"day", "orders", "items", "net_cents"} for r in d), str(d[:1]))
s, d = req("GET", "/api/orders/report/summary", token=counter_tok)
check("report loads", s == 200 and "items" in d, f"got {s}")
before_items = {i["item_name"]: i for i in d["items"]}
orders_before, od_before, net_before = d["orders"], d["order_discount_cents"], d["net_cents"]
# 10 biryani with BIRYANI5 ($5 off each) + 3 naan with $1 manual off + $2 order discount
s, d = req("POST", "/api/orders", token=counter_tok, body={"items": [
    {"name": "Chicken Biryani", "qty": 10, "unit_price": 1299, "discount_code": "BIRYANI5"},
    {"name": "Garlic Naan", "qty": 3, "unit_price": 349, "discount_cents": 100},
]})
check("report order created", s == 201, f"got {s} {d}")
oid5 = d["id"]
s, d = req("POST", f"/api/orders/{oid5}/payments/demo", token=counter_tok)
s, d = req("PATCH", f"/api/orders/{oid5}/discount", token=counter_tok, body={"discount_cents": 200})
for st in ["RECEIVED", "PREPARING", "READY", "COMPLETED"]:
    s, d = req("PATCH", f"/api/orders/{oid5}/status", token=kitchen_tok, body={"status": st})
check("report order completed", s == 200 and d["order_status"] == "COMPLETED", f"got {s} {d}")
s, d = req("GET", "/api/orders/report/summary", token=counter_tok)
after_items = {i["item_name"]: i for i in d["items"]}
check("report counts the new order", d["orders"] == orders_before + 1, f"got {d['orders']}")
b0 = before_items.get("Chicken Biryani", {"qty": 0, "gross_cents": 0, "discount_cents": 0, "net_cents": 0})
b1 = after_items["Chicken Biryani"]
check("biryani qty aggregated", b1["qty"] - b0["qty"] == 10, str(b1))
check("biryani gross aggregated", b1["gross_cents"] - b0["gross_cents"] == 12990, str(b1))
check("biryani code discount aggregated", b1["discount_cents"] - b0["discount_cents"] == 5000, str(b1))
check("biryani net aggregated", b1["net_cents"] - b0["net_cents"] == 7990, str(b1))
n0 = before_items.get("Garlic Naan", {"qty": 0, "gross_cents": 0, "discount_cents": 0, "net_cents": 0})
n1 = after_items["Garlic Naan"]
check("naan qty aggregated", n1["qty"] - n0["qty"] == 3, str(n1))
check("naan manual discount aggregated", n1["discount_cents"] - n0["discount_cents"] == 100, str(n1))
check("naan net aggregated", n1["net_cents"] - n0["net_cents"] == 947, str(n1))
check("order-level discount in report", d["order_discount_cents"] - od_before == 200, str(d["order_discount_cents"]))
check("net revenue adds order total", d["net_cents"] - net_before == 8737, str(d["net_cents"]))

print("== daily report ==")
import datetime as _dt
today = _dt.datetime.now(_dt.timezone.utc).date().isoformat()  # server buckets days in UTC
# the oid5 order (10 biryani + 3 naan) was completed just now — it must show up today
s, d = req("GET", "/api/orders/report/daily?days=7", token=counter_tok)
today_row = next((r for r in d if r["day"] == today), None)
check("today present in daily", today_row is not None, str([r["day"] for r in d]))
check("today counts the completed order", today_row["orders"] >= 1 and today_row["items"] >= 13, str(today_row))
check("today net matches order total", today_row["net_cents"] >= 8737, str(today_row))
# date-range summary: wide range around now includes it, ancient range is empty
s, d = req("GET", "/api/orders/report/summary?from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z", token=counter_tok)
check("range summary loads", s == 200 and d["orders"] >= 1, f"got {s} {d.get('orders')}")
bir = next((i for i in d["items"] if i["item_name"] == "Chicken Biryani"), None)
check("range summary has biryani sales", bir is not None and bir["qty"] >= 10, str(bir))
s, d = req("GET", "/api/orders/report/summary?from=2020-01-01T00:00:00.000Z&to=2020-01-02T00:00:00.000Z", token=counter_tok)
check("empty range is empty", s == 200 and d["orders"] == 0 and d["items"] == [], f"got {s} {d}")
# completed_at is stamped on the COMPLETED transition
s, d = req("GET", f"/api/orders/{oid5}", token=counter_tok)
check("completed_at stamped", s == 200 and bool(d.get("completed_at")), f"got {s} {d.get('completed_at')}")

print("== waitlist: recall & no almost-ready ==")
s, d = req("GET", "/api/waitlist/admin/locations", token=counter_tok)
check("waitlist locations load", s == 200 and len(d) > 0, f"got {s}")
wl_loc = d[0]
s, d = req("POST", "/api/waitlist/check-in", body={"location_id": wl_loc["id"], "customer_name": "Recall Test", "party_size": 2})
check("waitlist check-in works", s == 201 and "public_token" in d, f"got {s} {d}")
qn = d["queue_number"]
wl_pub = d["public_token"]
s, d = req("GET", f"/api/waitlist/admin/summary?location_id={wl_loc['id']}", token=counter_tok)
wl_id = next(e["id"] for e in d["entries"] if e["queue_number"] == qn)
s, d = req("POST", f"/api/waitlist/{wl_id}/call", token=counter_tok)
check("call marks CALLED", s == 200 and d["status"] == "CALLED", f"got {s} {d}")
for i in (1, 2, 3):
    s, d = req("POST", f"/api/waitlist/{wl_id}/recall", token=counter_tok)
    check(f"recall #{i} re-notifies, stays CALLED", s == 200 and d["status"] == "CALLED" and d["recall_count"] == i, f"got {s} {d}")
s, d = req("POST", "/api/waitlist/check-in", body={"location_id": wl_loc["id"], "customer_name": "Waiting Test", "party_size": 2})
qn2 = d["queue_number"]
s, d = req("GET", f"/api/waitlist/admin/summary?location_id={wl_loc['id']}", token=counter_tok)
check("summary counts have no ALMOST_READY", s == 200 and "ALMOST_READY" not in d["counts"] and set(d["counts"]) == {"WAITING", "CALLED"}, f"got {s} {d.get('counts')}")
wl_waiting = next(e["id"] for e in d["entries"] if e["queue_number"] == qn2)
s, d = req("POST", f"/api/waitlist/{wl_waiting}/recall", token=counter_tok)
check("recall on WAITING entry rejected", s == 409, f"got {s} {d}")
s, d = req("POST", f"/api/waitlist/{wl_waiting}/almost-ready", token=counter_tok)
check("almost-ready action removed", s == 404, f"got {s} {d}")
s, d = req("GET", f"/api/waitlist/token/{wl_pub}")
check("public entry shows called_time and recall_count", s == 200 and d["status"] == "CALLED" and d["recall_count"] == 3 and bool(d["called_time"]), f"got {s} {d.get('status')} {d.get('recall_count')}")
s, d = req("POST", f"/api/waitlist/{wl_id}/cancel", token=counter_tok)
check("cancel a called entry", s == 200 and d["status"] == "CANCELLED", f"got {s} {d}")
s, d = req("GET", f"/api/waitlist/token/{wl_pub}")
check("cancelled entry keeps recall history publicly", s == 200 and d["status"] == "CANCELLED" and d["recall_count"] == 3 and bool(d["called_time"]), f"got {s}")

print("== waitlist client checks (static) ==")
import os as _os
_client = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "client", "app.js")
_src = open(_client, encoding="utf-8").read()
check("no estimated wait shown to customers", "estimated_wait_label" not in _src and "Est. wait" not in _src)
check("single primary action per waitlist row", "WL_ACTIONS" not in _src and "WL_PRIMARY_ACTION" in _src)
check("check-in goes straight to tracking", "renderConfirmed" not in _src and "You're checked in" not in _src)
check("check-in navigates to /wait/<token>", "go(`/wait/${encodeURIComponent(data.public_token)}`)" in _src)
check("topbar uses old-style nav buttons", "nav-btn" in _src and "nav-pill" not in _src)
check("waitlist nav has count badge", all(x in _src for x in ("nav-waitlist-count", "nav-badge", "active_count")))
check("temp quick test login is gated", "quick-login-btn" in _src and "get('test') === '1'" in _src)
check("username rule is min 5 only", "Min 5 characters (letters, numbers, . _ -)." in _src and "or 4 characters" not in _src)
check("CALLED rows have CALL AGAIN button", 'data-act="recall"' in _src and "CALL AGAIN" in _src)
check("customer texts don't promise almost-ready push", "your table is almost ready" not in _src.lower())
check("customer timeline has no almost-ready step", "Almost your turn', 'Called'" not in _src)
check("customer page shows recall count", "Reminder ${e.recall_count}" in _src and "you were reminded ${rc}" in _src)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
