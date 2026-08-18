#!/usr/bin/env python3
"""
Live verification of scheduler availability fixes against the REAL running server
(port 4200) and the REAL Turso database.

What it proves, end to end over HTTP as the office:
  1. Assigning a tech onto another job in the same time window returns a forceable
     409 and does NOT change the booking.
  2. Rescheduling an assigned job onto the tech's busy time returns a forceable 409
     and does NOT move the booking.
  3. Assigning a tech on a day they booked off returns a forceable 409 and does NOT
     change the booking.
  4. Shift/time-off create validation rejects bad dates, bad times, stale tech ids,
     and stores a picked day as the company's local midnight, not UTC midnight.
  5. PUT/DELETE on unknown shift ids return 404.

No notification test/fire endpoints are called. Assign/reschedule probes exercise
only refusals; those happen before fireEvent(), so no SMS/email is sent. Probe rows
are prefixed "availprobe-" and are deleted at the end; deletion is verified.
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

# 2026-09-15 14:00 Winnipeg (CDT, UTC-5)
SLOT = 1789498800000
HOUR = 3_600_000
DAY_START_WINNIPEG = 1789448400000  # 2026-09-15 00:00 America/Winnipeg


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
        raise RuntimeError(out.stderr[-1200:])
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


def cleanup():
    sql("DELETE FROM job_events WHERE booking_id LIKE 'availprobe-%'")
    sql("DELETE FROM notifications WHERE booking_id LIKE 'availprobe-%'")
    sql("DELETE FROM notification_deliveries WHERE booking_id LIKE 'availprobe-%'")
    sql("DELETE FROM invoices WHERE booking_id LIKE 'availprobe-%'")
    sql("DELETE FROM bookings WHERE id LIKE 'availprobe-%'")
    sql("DELETE FROM tech_shifts WHERE id LIKE 'availprobe-%'")


def seed_job(bid: str, status: str, rider: str | None, scheduled: int):
    sql(f"DELETE FROM bookings WHERE id = '{bid}'")
    rid = f"'{rider}'" if rider else "NULL"
    assign_status = "accepted" if rider else ""
    sql(
        "INSERT INTO bookings (id, company_id, customer_id, service_id, title, status, assign_status, "
        "scheduled_at, address, lat, lng, rider_id, price, subtotal, tax_amount, total, payment_status, "
        "public_token) VALUES ("
        f"'{bid}', '{CO}', '{CUST}', '{SVC}', 'Availability probe', '{status}', '{assign_status}', {scheduled}, "
        f"'1 Probe Lane', 43.6532, -79.3832, {rid}, 100, 100, 0, 100, 'unpaid', 'availprobe-tok-{bid}')"
    )


def booking(bid: str):
    rows = sql(f"SELECT id, rider_id, scheduled_at FROM bookings WHERE id = '{bid}'")
    return rows[0] if rows else None


def main():
    cleanup()
    try:
        # Assign refusal: busy job 2:00-3:00, candidate starts 2:30.
        seed_job("availprobe-busy", "assigned", RIDER, SLOT)
        seed_job("availprobe-new", "confirmed", None, SLOT + 30 * 60_000)
        st, body = req("POST", "/api/bookings/availprobe-new/assign", {"riderId": RIDER})
        check("assign busy tech returns 409", st == 409, str(body))
        check("assign busy tech is forceable", body.get("forceable") is True, str(body))
        check("assign busy tech message explains booked time", "already booked" in body.get("message", ""), str(body))
        check("assign refusal leaves job unassigned", booking("availprobe-new").get("rider_id") in (None, ""), str(booking("availprobe-new")))

        # Reschedule refusal: assigned job is being moved onto the same tech's busy slot.
        seed_job("availprobe-move", "assigned", RIDER, SLOT + 5 * HOUR)
        st, body = req("POST", "/api/bookings/availprobe-move/schedule", {"scheduledAt": SLOT + 15 * 60_000})
        check("reschedule onto busy tech returns 409", st == 409, str(body))
        check("reschedule busy tech is forceable", body.get("forceable") is True, str(body))
        check("reschedule refusal leaves original time", int(booking("availprobe-move")["scheduled_at"]) == SLOT + 5 * HOUR, str(booking("availprobe-move")))

        # Time-off refusal: same local day.
        sql(
            "INSERT INTO tech_shifts (id, company_id, rider_id, kind, date, start_min, end_min, note) "
            f"VALUES ('availprobe-off', '{CO}', '{RIDER}', 'timeoff', {DAY_START_WINNIPEG}, 540, 1020, 'Probe vacation')"
        )
        seed_job("availprobe-off-job", "confirmed", None, SLOT + 8 * HOUR)
        st, body = req("POST", "/api/bookings/availprobe-off-job/assign", {"riderId": RIDER})
        check("assign on time-off day returns 409", st == 409, str(body))
        check("time-off refusal is forceable", body.get("forceable") is True, str(body))
        check("time-off message says time off", "time off" in body.get("message", "").lower(), str(body))
        check("time-off refusal leaves job unassigned", booking("availprobe-off-job").get("rider_id") in (None, ""), str(booking("availprobe-off-job")))

        # Shift route validation and day handling.
        for label, payload in [
            ("bad date", {"riderId": RIDER, "date": "not a date"}),
            ("end before start", {"riderId": RIDER, "date": "2026-09-15", "startMin": 1020, "endMin": 540}),
            ("stale rider", {"riderId": "availprobe-nope", "date": "2026-09-15"}),
        ]:
            st, body = req("POST", "/api/shifts", payload)
            check(f"shift create rejects {label}", st in (400, 404), f"{st} {body}")

        st, body = req("POST", "/api/shifts", {"riderId": RIDER, "kind": "timeoff", "date": "2026-09-15", "note": "API probe"})
        check("valid time-off shift creates", st == 201, str(body))
        sid = body.get("shift", {}).get("id")
        if sid:
            row = sql(f"SELECT date, kind, note FROM tech_shifts WHERE id = '{sid}'")[0]
            check("picked day stored as company-local midnight", int(row["date"]) == DAY_START_WINNIPEG, str(row))
            st, _ = req("DELETE", f"/api/shifts/{sid}")
            check("created shift deletes", st == 200, str(st))

        st, _ = req("PUT", "/api/shifts/availprobe-missing", {"startMin": 600})
        check("PUT unknown shift returns 404", st == 404, str(st))
        st, _ = req("DELETE", "/api/shifts/availprobe-missing")
        check("DELETE unknown shift returns 404", st == 404, str(st))
    finally:
        cleanup()
        left = sql("SELECT id FROM bookings WHERE id LIKE 'availprobe-%' UNION ALL SELECT id FROM tech_shifts WHERE id LIKE 'availprobe-%'")
        check("probe rows cleaned up", len(left) == 0, str(left))

    if fails:
        print(f"\nFAILED — {len(fails)} of {checks} checks failed")
        for f in fails:
            print(" -", f)
        sys.exit(1)
    print(f"\nALL CLEAN — {checks} assertions")


if __name__ == "__main__":
    main()
