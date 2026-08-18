#!/usr/bin/env python3
"""
Live verification of the dispatcher/office fixes against the REAL running server
(port 4200) and the REAL Turso database.

What it proves over HTTP:
  1. Company financials are office-only. A technician's real bearer token is
     refused on every report and on the payouts list; the office's token is not.
  2. Dispatch is office-only — a technician cannot assign work to themselves.
  3. A completed or cancelled job cannot be re-dispatched, and the record does
     not move.
  4. A job a technician is actively working is not silently pulled away: the
     refusal is a 409 flagged `forceable`, which is what makes the dispatcher's
     "Reassign" confirmation possible.
  5. A completed job cannot be dragged to another date (its date is what revenue
     reports and payout periods are selected by).
  6. "Mark paid" and "delete" on a payout id that does not exist answer 404
     instead of logging a payment of $undefined.
  7. The payout_id idempotency column really exists on the live database.

DELIBERATELY ONLY TESTS THE REFUSALS on the write paths. Every refusal happens
before fireEvent, so this script sends no SMS and no email to anyone. The
success paths (force-reassign resetting the clock, the rescheduled notification,
pre-tax payout maths, double-generate) are covered by
src/api/routes/__tests__/dispatch-and-payouts.test.ts against an in-memory DB,
where fireEvent has no recipients.

PROBE ROWS: prefixed "dispprobe-", deleted at the end, and the deletion is
verified rather than assumed. Manual cleanup if it ever aborts:

  DELETE FROM job_events WHERE booking_id LIKE 'dispprobe-%';
  DELETE FROM bookings   WHERE id        LIKE 'dispprobe-%';
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request

API = "http://localhost:4200"
CO = "default"
ROOT = "/home/user/nvc360-v4"
TECH_TOKEN = open("/tmp/tech.token").read().strip()
RIDER = "989812d2-93af-4729-8d00-d67a734fe023"
CUST = "6G8OQVJnUNnG388iGQs6Lw5sO5Q8nEQT"
SVC = "52f2fc46-310a-45a5-9c0b-91c2941437cf"

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
        cwd=ROOT, capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr[-800:])
    body = out.stdout.strip()
    return json.loads(body) if body.startswith("[") else []


def req(method: str, path: str, token: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method)
    r.add_header("Authorization", f"Bearer {token}")
    r.add_header("X-Company-Id", CO)
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return e.code, {"raw": raw.decode(errors="replace")[:200]}


def admin_token() -> str:
    r = urllib.request.Request(
        API + "/api/auth/sign-in/email",
        data=json.dumps({"email": "admin@nvc360.app", "password": "admin123"}).encode(),
        method="POST",
    )
    r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read())["token"]


def seed(bid: str, status: str, when_ms: int, assign_status: str = "accepted") -> None:
    sql(f"DELETE FROM bookings WHERE id = '{bid}'")
    sql(
        "INSERT INTO bookings (id, company_id, customer_id, service_id, title, status, "
        "assign_status, scheduled_at, address, lat, lng, rider_id, price, subtotal, tax_amount, "
        "total, payment_status, public_token, created_at) VALUES ("
        f"'{bid}', '{CO}', '{CUST}', '{SVC}', 'AUDIT PROBE — safe to delete', '{status}', "
        f"'{assign_status}', {when_ms}, '1 Probe Plaza', 43.6532, -79.3832, '{RIDER}', "
        f"1130, 1000, 130, 1130, 'paid', '{bid[:12]}tok', {when_ms})"
    )


def booking(bid: str):
    rows = sql(f"SELECT status, rider_id, scheduled_at FROM bookings WHERE id = '{bid}'")
    return rows[0] if rows else None


def main() -> int:
    print("== admin session")
    try:
        AT = admin_token()
        check("office can sign in", bool(AT))
    except Exception as e:  # noqa: BLE001
        print(f"  FAIL could not sign in as admin: {e}")
        return 1

    print("\n== 1. financial data is office-only")
    for path in ["/api/reports/revenue", "/api/reports/payroll", "/api/reports/invoices-ar",
                 "/api/reports/catalog", "/api/reports/meta/filters", "/api/payouts"]:
        st, _ = req("GET", path, TECH_TOKEN)
        check(f"technician refused {path}", st == 403, f"got {st}")
    for path in ["/api/reports/revenue", "/api/reports/payroll", "/api/payouts"]:
        st, _ = req("GET", path, AT)
        check(f"office still reads {path}", st == 200, f"got {st}")

    print("\n== 2. dispatch is office-only")
    seed("dispprobe-open", "confirmed", 1_800_000_000_000, assign_status="")
    st, body = req("POST", "/api/bookings/dispprobe-open/assign", TECH_TOKEN, {"riderId": RIDER})
    check("technician cannot dispatch work", st == 403, f"got {st} {body}")

    print("\n== 3. terminal jobs cannot be re-dispatched")
    seed("dispprobe-done", "completed", 1_700_000_000_000)
    st, body = req("POST", "/api/bookings/dispprobe-done/assign", AT, {"riderId": RIDER})
    msg = str(body.get("message", "")).lower()
    check("completed job refused", st == 409, f"got {st} {body}")
    check("refusal explains it is completed", "completed" in msg, msg)
    check("completed job did not move", (booking("dispprobe-done") or {}).get("status") == "completed")

    seed("dispprobe-cxl", "cancelled", 1_700_000_000_000)
    st, _ = req("POST", "/api/bookings/dispprobe-cxl/assign", AT, {"riderId": RIDER})
    check("cancelled job refused", st == 409, f"got {st}")

    st, body = req("POST", "/api/bookings/dispprobe-nope/assign", AT, {"riderId": RIDER})
    check("unknown work order 404s", st == 404, f"got {st} {body}")

    print("\n== 4. a tech working a job is not pulled off it silently")
    seed("dispprobe-live", "enroute", 1_800_000_000_000)
    st, body = req("POST", "/api/bookings/dispprobe-live/assign", AT, {"riderId": RIDER})
    check("in-flight job refused", st == 409, f"got {st} {body}")
    check("refusal is flagged forceable for the Reassign prompt", body.get("forceable") is True, str(body))
    b = booking("dispprobe-live") or {}
    check("in-flight job untouched", b.get("status") == "enroute" and b.get("rider_id") == RIDER, str(b))

    print("\n== 5. a completed job cannot be dragged to another date")
    before = int((booking("dispprobe-done") or {}).get("scheduled_at") or 0)
    st, body = req("POST", "/api/bookings/dispprobe-done/schedule", AT,
                   {"scheduledAt": 1_900_000_000_000})
    check("reschedule of a completed job refused", st == 409, f"got {st} {body}")
    after = int((booking("dispprobe-done") or {}).get("scheduled_at") or 0)
    check("its date is unchanged", before == after, f"{before} -> {after}")

    print("\n== 6. payout actions on a stale id")
    st, body = req("POST", "/api/payouts/dispprobe-ghost/pay", AT)
    check("mark-paid on unknown payout 404s", st == 404, f"got {st} {body}")
    st, _ = req("DELETE", "/api/payouts/dispprobe-ghost", AT)
    check("delete of unknown payout 404s", st == 404, f"got {st}")

    print("\n== 7. live schema")
    rows = sql("SELECT COUNT(*) AS n FROM bookings WHERE payout_id = ''")
    check("payout_id exists on the live bookings table", bool(rows), str(rows))

    print("\n== cleanup")
    sql("DELETE FROM job_events WHERE booking_id LIKE 'dispprobe-%'")
    sql("DELETE FROM bookings WHERE id LIKE 'dispprobe-%'")
    left = sql("SELECT COUNT(*) AS n FROM bookings WHERE id LIKE 'dispprobe-%'")
    check("no probe bookings left", int(left[0]["n"]) == 0, str(left))
    left = sql("SELECT COUNT(*) AS n FROM job_events WHERE booking_id LIKE 'dispprobe-%'")
    check("no probe job events left", int(left[0]["n"]) == 0, str(left))

    print()
    if fails:
        print(f"{len(fails)} FAILED of {checks}:")
        for f in fails:
            print(f"  - {f}")
        return 1
    print(f"ALL CLEAN — {checks} assertions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
