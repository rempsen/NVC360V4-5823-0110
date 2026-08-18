#!/usr/bin/env python3
"""
Live verification of REAL tech pay — payout generation against the REAL running
server (port 4200) and the REAL Turso database.

What it proves, end to end, over HTTP as the office:
  1. A payout pays on-site hours x the tech's hourly rate, NOT a percentage of
     the customer's invoice (the 20-minute call on a $4,000 invoice case).
  2. Per-unit line pay is added on top of the hourly pay.
  3. A completed job is paid even when the customer has not paid the invoice yet.
  4. A job whose tech has no hourly rate and no per-unit pay is paid $0 and
     FLAGGED (unrated_jobs > 0), not silently hidden.
  5. There is no platform fee any more: fee = 0, fee_pct = 0, gross == net.
  6. The per-job breakdown is stored on the payout AND written back onto the
     booking, so the payouts screen, the job screen and the driver's Earnings
     screen all show the same number.
  7. Running the same period again is a no-op (no double pay).
  8. GET /api/payouts returns the breakdown the office UI expands.

PROBE ROWS: everything created here is prefixed "payprobe-" and deleted at the
end; the deletion is VERIFIED, not assumed. The tech's real hourly rate is saved
and restored. Manual cleanup if it ever aborts:

  DELETE FROM payouts  WHERE id IN (SELECT payout_id FROM bookings WHERE id LIKE 'payprobe-%');
  DELETE FROM job_events WHERE booking_id LIKE 'payprobe-%';
  DELETE FROM notifications WHERE booking_id LIKE 'payprobe-%';
  DELETE FROM invoices WHERE booking_id LIKE 'payprobe-%';
  DELETE FROM bookings WHERE id LIKE 'payprobe-%';
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request

API = "http://localhost:4200"
CO = "default"
ROOT = "/home/user/nvc360-v4"
RIDER = "989812d2-93af-4729-8d00-d67a734fe023"
CUST = "6G8OQVJnUNnG388iGQs6Lw5sO5Q8nEQT"
SVC = "52f2fc46-310a-45a5-9c0b-91c2941437cf"

ADMIN_EMAIL = "admin@nvc360.app"
ADMIN_PASSWORD = "admin123"

fails: list[str] = []
checks = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if ok:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}  {detail}")
        fails.append(label)


def sql(statement: str):
    out = subprocess.run(
        ["bash", "-lc", f'set -a && source .env && set +a && bun /tmp/q.ts {json.dumps(statement)}'],
        cwd=ROOT, capture_output=True, text=True, timeout=180,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr[-800:])
    body = out.stdout.strip()
    return json.loads(body) if body.startswith("[") else []


def sign_in() -> str:
    r = urllib.request.Request(
        f"{API}/api/auth/sign-in/email",
        data=json.dumps({"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}).encode(),
        method="POST",
    )
    r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read())["token"]


TOKEN = sign_in()


def req(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method)
    r.add_header("Authorization", f"Bearer {TOKEN}")
    r.add_header("X-Company-Id", CO)
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:400]}


DAY = 86_400_000
NOW = int(subprocess.run(["date", "+%s%3N"], capture_output=True, text=True).stdout.strip())
MID = NOW - 5 * DAY
START = NOW - 10 * DAY
END = NOW - 1 * DAY


def unit_line(cost: float, name: str):
    return {
        "id": f"pp-{name}", "kind": "unit", "name": name, "unit": "sqft",
        "qty": 1, "unitCost": cost, "unitPrice": 0, "taxable": True,
        "cost": cost, "price": 0,
    }


def seed(bid: str, minutes: float, subtotal: float, tax: float, payment: str, lines: list):
    sql(f"DELETE FROM bookings WHERE id = '{bid}'")
    sql(
        "INSERT INTO bookings (id, company_id, customer_id, service_id, title, status, assign_status, "
        "scheduled_at, address, lat, lng, rider_id, price, subtotal, tax_amount, total, payment_status, "
        "public_token, on_site_minutes, line_items, payout_id) VALUES ("
        f"'{bid}', '{CO}', '{CUST}', '{SVC}', 'Pay probe', 'completed', 'accepted', {MID}, "
        f"'1 Probe Lane', 43.6532, -79.3832, '{RIDER}', {subtotal + tax}, {subtotal}, {tax}, "
        f"{subtotal + tax}, '{payment}', 'payprobe-tok-{bid}', {minutes}, "
        f"'{json.dumps(lines).replace(chr(39), chr(39) * 2)}', '')"
    )


def set_rate(rate: float):
    sql(f"UPDATE riders SET pay_rate_per_hour = {rate} WHERE id = '{RIDER}'")


def clear_payouts():
    sql("DELETE FROM payouts WHERE id IN (SELECT payout_id FROM bookings WHERE id LIKE 'payprobe-%' AND payout_id != '')")
    sql("UPDATE bookings SET payout_id = '' WHERE id LIKE 'payprobe-%'")


def latest_payout():
    rows = sql(
        "SELECT * FROM payouts WHERE id IN (SELECT payout_id FROM bookings WHERE id LIKE 'payprobe-%' "
        "AND payout_id != '') ORDER BY created_at DESC LIMIT 1"
    )
    return rows[0] if rows else None


def generate(start=START, end=END):
    return req("POST", "/api/payouts/generate", {"periodStart": start, "periodEnd": end})


def booking(bid: str):
    rows = sql(f"SELECT * FROM bookings WHERE id = '{bid}'")
    return rows[0] if rows else None


ORIGINAL_RATE = float(sql(f"SELECT pay_rate_per_hour AS r FROM riders WHERE id = '{RIDER}'")[0]["r"] or 0)
print(f"saved the tech's real hourly rate: {ORIGINAL_RATE}")

try:
    # -- 1. hourly, not a percentage of the invoice ---------------------------
    print("\n1. hourly rate x on-site time, not a cut of the invoice")
    clear_payouts()
    sql("DELETE FROM bookings WHERE id LIKE 'payprobe-%'")
    set_rate(40)
    seed("payprobe-hourly", 20, 4000, 520, "paid", [])
    st, body = generate()
    check("generate returns 201", st == 201, f"got {st} {body}")
    p = latest_payout()
    check("a payout was created", p is not None)
    if p:
        # 20 min = 0.33 h x $40 = $13.20 (the old model paid $3,200 here)
        check("hourly pay is 0.33h x $40 = 13.20", float(p["hourly_pay"]) == 13.2, str(p["hourly_pay"]))
        check("net is the real pay, not 80% of the invoice", float(p["net"]) == 13.2, str(p["net"]))
        check("gross equals net (no platform fee)", float(p["gross"]) == float(p["net"]))
        check("fee is zero", float(p["fee"]) == 0, str(p["fee"]))
        check("fee_pct is zero", float(p["fee_pct"]) == 0, str(p["fee_pct"]))
        check("per-unit pay is zero on an hourly-only job", float(p["unit_pay"]) == 0)

    # -- 2. per-unit pay on top ----------------------------------------------
    print("\n2. per-unit pay is added on top of hourly")
    clear_payouts()
    sql("DELETE FROM bookings WHERE id LIKE 'payprobe-%'")
    set_rate(30)
    seed("payprobe-unit", 120, 900, 117, "paid", [unit_line(150, "install")])
    st, _ = generate()
    check("generate returns 201", st == 201, str(st))
    p = latest_payout()
    if p:
        check("hourly pay is 2h x $30 = 60", float(p["hourly_pay"]) == 60, str(p["hourly_pay"]))
        check("per-unit pay is 150", float(p["unit_pay"]) == 150, str(p["unit_pay"]))
        check("total pay is 210", float(p["net"]) == 210, str(p["net"]))

    # -- 3. paid for completed work even if the client has not paid ----------
    print("\n3. completed work is paid even when the customer has not paid")
    clear_payouts()
    sql("DELETE FROM bookings WHERE id LIKE 'payprobe-%'")
    set_rate(50)
    seed("payprobe-unpaid", 60, 500, 65, "unpaid", [])
    st, _ = generate()
    check("generate returns 201", st == 201, str(st))
    p = latest_payout()
    if p:
        check("the unpaid-invoice job still pays 1h x $50 = 50", float(p["net"]) == 50, str(p["net"]))
        check("the job is counted", int(p["jobs_count"]) == 1, str(p["jobs_count"]))

    # -- 4. missing pay rate is flagged, not hidden --------------------------
    print("\n4. a job with no pay rate set is flagged")
    clear_payouts()
    sql("DELETE FROM bookings WHERE id LIKE 'payprobe-%'")
    set_rate(0)
    seed("payprobe-unrated", 180, 700, 91, "paid", [])
    st, _ = generate()
    check("generate returns 201", st == 201, str(st))
    p = latest_payout()
    if p:
        check("pay is 0 with no rate set", float(p["net"]) == 0, str(p["net"]))
        check("the payout flags the unrated job", int(p["unrated_jobs"]) >= 1, str(p["unrated_jobs"]))
        jobs = json.loads(p["breakdown"] or "[]")
        j = next((x for x in jobs if x["bookingId"] == "payprobe-unrated"), None)
        check("the job detail carries the unrated flag", bool(j and j["unrated"] is True), str(j))

    # -- 5. breakdown stored and written back onto the booking ---------------
    print("\n5. breakdown is stored and mirrored onto the booking")
    clear_payouts()
    sql("DELETE FROM bookings WHERE id LIKE 'payprobe-%'")
    set_rate(45)
    seed("payprobe-detail", 90, 1200, 156, "paid", [unit_line(25, "trim")])
    st, _ = generate()
    check("generate returns 201", st == 201, str(st))
    p = latest_payout()
    if p:
        jobs = json.loads(p["breakdown"] or "[]")
        j = next((x for x in jobs if x["bookingId"] == "payprobe-detail"), None)
        check("job detail exists on the payout", j is not None)
        if j:
            check("job hourly is 1.5h x $45 = 67.50", float(j["hourlyPay"]) == 67.5, str(j["hourlyPay"]))
            check("job per-unit is 25", float(j["unitPay"]) == 25, str(j["unitPay"]))
            check("job pay is 92.50", float(j["techPay"]) == 92.5, str(j["techPay"]))
        b = booking("payprobe-detail")
        check("the booking's tech_pay matches the payout", float(b["tech_pay"]) == 92.5, str(b["tech_pay"]))
        check("the booking is stamped with the payout id", b["payout_id"] == p["id"])

        # -- 6. no double pay ------------------------------------------------
        print("\n6. re-running the period does not pay twice")
        st, body = generate()
        check("second run returns 201", st == 201, str(st))
        check("second run creates nothing", body.get("created") == 0, str(body))
        st, body = generate(START - 5 * DAY, END)
        check("an overlapping period creates nothing either", body.get("created") == 0, str(body))

        # -- 7. the office list carries the detail the UI expands ------------
        print("\n7. GET /api/payouts exposes the per-job detail")
        st, body = req("GET", "/api/payouts")
        check("payouts list returns 200", st == 200, str(st))
        row = next((x for x in body.get("payouts", []) if x["id"] == p["id"]), None)
        check("the new payout is in the list", row is not None)
        if row:
            check("it carries a jobs array for the UI", isinstance(row.get("jobs"), list) and len(row["jobs"]) >= 1, str(row.get("jobs"))[:200])
            check("it reports the hourly/per-unit split", float(row["hourlyPay"]) == 67.5 and float(row["unitPay"]) == 25,
                  f'{row.get("hourlyPay")}/{row.get("unitPay")}')

finally:
    print("\ncleanup")
    clear_payouts()
    sql("DELETE FROM job_events WHERE booking_id LIKE 'payprobe-%'")
    sql("DELETE FROM notifications WHERE booking_id LIKE 'payprobe-%'")
    sql("DELETE FROM invoices WHERE booking_id LIKE 'payprobe-%'")
    sql("DELETE FROM bookings WHERE id LIKE 'payprobe-%'")
    set_rate(ORIGINAL_RATE)
    left_b = sql("SELECT id FROM bookings WHERE id LIKE 'payprobe-%'")
    left_p = sql("SELECT id FROM payouts WHERE breakdown LIKE '%payprobe-%'")
    check("no probe bookings left", len(left_b) == 0, str(left_b))
    check("no probe payouts left", len(left_p) == 0, str(left_p))
    rate_now = float(sql(f"SELECT pay_rate_per_hour AS r FROM riders WHERE id = '{RIDER}'")[0]["r"] or 0)
    check("the tech's real hourly rate was restored", rate_now == ORIGINAL_RATE, f"{rate_now} != {ORIGINAL_RATE}")

print()
if fails:
    print(f"{len(fails)} FAILED of {checks}:")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print(f"ALL CLEAN — {checks} assertions")
