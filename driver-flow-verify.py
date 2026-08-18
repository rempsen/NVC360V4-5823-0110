#!/usr/bin/env python3
"""
Live verification of the driver status flow + geofenced clock against the REAL
running server (port 4200) and the REAL Turso database.

What it proves, end to end, over HTTP as the technician's app:
  1. enroute -> completed is refused with a message a driver can act on, and the
     job does not move.
  2. A completed job cannot be dragged back to enroute by the field app.
  3. The normal flow (assigned -> enroute -> arrived -> completed) still works
     and finalises transit time + the on-site clock.
  4. A MANUAL arrival does not set inside_geofence, so the next GPS ping cannot
     pause the clock of a tech who is standing on site.
  5. A real GPS ping outside the radius does NOT pause a manually-arrived tech,
     and the ping response carries the live distance + radius the app shows.
  6. A real GPS ping inside the radius auto-arrives an enroute tech and sets
     inside_geofence.

PROBE ROWS: everything created here is prefixed "flowprobe-" and deleted at the
end; the deletion is verified, not assumed. Manual cleanup if it ever aborts:

  DELETE FROM tracking_pings WHERE booking_id LIKE 'flowprobe-%';
  DELETE FROM job_events    WHERE booking_id LIKE 'flowprobe-%';
  DELETE FROM notifications WHERE booking_id LIKE 'flowprobe-%';
  DELETE FROM invoices      WHERE booking_id LIKE 'flowprobe-%';
  DELETE FROM bookings      WHERE id        LIKE 'flowprobe-%';
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "http://localhost:4200"
CO = "default"
ROOT = "/home/user/nvc360-v4"
TOKEN = open("/tmp/tech.token").read().strip()
RIDER = "989812d2-93af-4729-8d00-d67a734fe023"
CUST = "6G8OQVJnUNnG388iGQs6Lw5sO5Q8nEQT"
SVC = "52f2fc46-310a-45a5-9c0b-91c2941437cf"

# Job site: a real lat/lng. "far" is ~1.5 km away — outside any sane radius.
SITE = (43.653200, -79.383200)
FAR = (43.666700, -79.383200)

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


def req(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method)
    r.add_header("Authorization", f"Bearer {TOKEN}")
    r.add_header("X-Company-Id", CO)
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=45) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except Exception:
            return e.code, {"raw": raw[:300].decode(errors="replace")}


def seed(jid: str, status: str, *, enroute_ago_min=30, started=None, clock="idle", inside=0):
    now = int(time.time() * 1000)
    sql(f"DELETE FROM bookings WHERE id = '{jid}'")
    enroute = "NULL" if enroute_ago_min is None else str(now - enroute_ago_min * 60000)
    sql(
        "INSERT INTO bookings (id, company_id, customer_id, service_id, title, status,"
        " assign_status, scheduled_at, address, lat, lng, rider_id, price, public_token,"
        " enroute_at, started_at, clock_state, last_resume_at, inside_geofence,"
        " accumulated_ms, on_site_minutes, mileage_km, created_at) VALUES ("
        f"'{jid}', '{CO}', '{CUST}', '{SVC}', 'PROBE do not dispatch', '{status}', 'accepted',"
        f" {now + 3600000}, '1 Probe Plaza', {SITE[0]}, {SITE[1]}, '{RIDER}', 250,"
        f" '{jid}-tok', {enroute}, {'NULL' if started is None else started}, '{clock}',"
        f" {'NULL' if clock != 'running' else now - 60000}, {inside}, 0, 0, 0, {now})"
    )


def row(jid: str):
    r = sql(f"SELECT * FROM bookings WHERE id = '{jid}'")
    return r[0] if r else None


def set_status(jid: str, status: str):
    return req("POST", f"/api/bookings/{jid}/status", {"status": status})


def ping(jid: str, lat: float, lng: float):
    return req("POST", f"/api/tracking/{jid}/ping", {"lat": lat, "lng": lng})


print("\n=== 1. a job cannot be completed from the van ===")
seed("flowprobe-skip", "enroute")
code, body = set_status("flowprobe-skip", "completed")
check("enroute -> completed is refused (409)", code == 409, f"got {code} {body}")
msg = (body.get("message") or body.get("error", {}).get("message") or "").lower()
check("the refusal tells the driver to check in first", "arriv" in msg, f"msg={msg!r}")
check("the job did not move", (row("flowprobe-skip") or {}).get("status") == "enroute")

print("\n=== 2. a completed job cannot be reopened by the field app ===")
seed("flowprobe-reopen", "completed")
code, _ = set_status("flowprobe-reopen", "enroute")
check("completed -> enroute is refused (409)", code == 409, f"got {code}")
check("the job stays completed", (row("flowprobe-reopen") or {}).get("status") == "completed")

print("\n=== 3. the normal flow still works and finalises the numbers ===")
seed("flowprobe-flow", "assigned", enroute_ago_min=None)
for nxt in ("enroute", "arrived", "completed"):
    code, body = set_status("flowprobe-flow", nxt)
    check(f"assigned flow -> {nxt} accepted", code == 200, f"got {code} {body}")
b = row("flowprobe-flow") or {}
check("status is completed", b.get("status") == "completed")
check("arrival was recorded (started_at set)", b.get("started_at") not in (None, 0))
check("transit time was finalised", b.get("transit_minutes") is not None)
check("finished_at was stamped", b.get("finished_at") not in (None, 0))
check("on-site minutes were banked", b.get("on_site_minutes") is not None)

print("\n=== 4. a manual arrival does not fake a GPS fix ===")
seed("flowprobe-manual", "enroute")
code, _ = set_status("flowprobe-manual", "arrived")
check("manual arrival accepted", code == 200, f"got {code}")
b = row("flowprobe-manual") or {}
check("clock is running", b.get("clock_state") == "running")
check("inside_geofence stayed 0 (GPS never confirmed it)", int(b.get("inside_geofence") or 0) == 0,
      f"inside_geofence={b.get('inside_geofence')}")

print("\n=== 5. a ping from far away does NOT pause that tech's clock ===")
code, body = ping("flowprobe-manual", *FAR)
check("ping accepted", code == 200, f"got {code} {body}")
geo = body.get("geofence") or {}
check("ping reports the live distance to the site", geo.get("distanceM", 0) > 1000, f"geo={geo}")
check("ping reports the radius the app should promise", geo.get("radiusM", 0) >= 10, f"geo={geo}")
check("ping says the tech is outside", geo.get("inside") is False, f"geo={geo}")
b = row("flowprobe-manual") or {}
check("clock STILL running (this used to flip to paused)", b.get("clock_state") == "running",
      f"clock_state={b.get('clock_state')}")

print("\n=== 6. a ping at the address auto-arrives an enroute tech ===")
seed("flowprobe-auto", "enroute")
code, body = ping("flowprobe-auto", *SITE)
check("ping accepted", code == 200, f"got {code}")
geo = body.get("geofence") or {}
check("ping says the tech is inside", geo.get("inside") is True, f"geo={geo}")
check("ping hands back the new status so the app can move", body.get("status") == "arrived",
      f"status={body.get('status')}")
b = row("flowprobe-auto") or {}
check("job auto-arrived", b.get("status") == "arrived", f"status={b.get('status')}")
check("clock started", b.get("clock_state") == "running")
check("inside_geofence set by the geofence path", int(b.get("inside_geofence") or 0) == 1)
check("transit time finalised on auto-arrive", b.get("transit_minutes") is not None)

print("\n=== 7. leaving the site after a geofenced arrival pauses the clock ===")
code, body = ping("flowprobe-auto", *FAR)
check("ping accepted", code == 200, f"got {code}")
b = row("flowprobe-auto") or {}
check("clock paused on exit", b.get("clock_state") == "paused", f"clock_state={b.get('clock_state')}")
check("inside_geofence cleared", int(b.get("inside_geofence") or 0) == 0)
check("time was banked, not lost", int(b.get("accumulated_ms") or 0) > 0,
      f"accumulated_ms={b.get('accumulated_ms')}")

print("\n=== cleanup ===")
for t, col in (("tracking_pings", "booking_id"), ("job_events", "booking_id"),
               ("notifications", "booking_id"), ("invoices", "booking_id"),
               ("bookings", "id")):
    try:
        sql(f"DELETE FROM {t} WHERE {col} LIKE 'flowprobe-%'")
    except Exception as e:
        print(f"  cleanup warn on {t}: {e}")
left = sql("SELECT id FROM bookings WHERE id LIKE 'flowprobe-%'")
pings_left = sql("SELECT booking_id FROM tracking_pings WHERE booking_id LIKE 'flowprobe-%'")
check("no probe bookings left in the database", len(left) == 0, f"left={left}")
check("no probe pings left in the database", len(pings_left) == 0, f"left={pings_left}")

print(f"\n{'ALL CLEAN' if not fails else 'FAILED ' + str(len(fails))} — {checks} assertions")
for f in fails:
    print(f"  - {f}")
sys.exit(1 if fails else 0)
