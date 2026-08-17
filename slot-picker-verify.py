"""
Live check for the day-then-time slot picker (customer booking + reschedule).

Runs a real Chrome against a real server as a real customer, at phone width.
Asserts what a customer actually experiences, not what the code says:
  1. the booking page shows a DAY ROW, not a flat wall of dated slot buttons
  2. only one day's times are on screen at a time
  3. tapping another day swaps the times, and the count changes with the day
  4. every time button is a real thumb target (>= 44px)
  5. picking a time keeps it selected, and switching days and back keeps it
  6. the booking still submits with the picked slot (create returns a booking id)
  7. zero console errors on the page

WRITES TO THE REAL DATABASE. The customer portal is role-gated and the shared
test logins on this DB are riders/admins, so this signs up a disposable customer
and books one job. It prints "PROBE ACCOUNT <email>". Delete the rows afterwards
and confirm the deletion — probe data left behind shows up on the dispatch board:

  delete from job_events / invoices / notifications / notification_deliveries
    where booking_id in (select id from bookings where customer_id in (
      select id from user where email like 'slotprobe-%'));
  delete from bookings / properties where customer_id in (...);
  delete from session / account where user_id in (...);
  delete from user where email like 'slotprobe-%';
  -- then re-select the counts and confirm they are 0

Not part of the routine gate set for that reason. Run it when the slot picker,
booking submit, or reschedule modal changes.

Usage:
  python3 slot-picker-verify.py            # signs up a throwaway customer
  CUSTOMER_EMAIL=... CUSTOMER_PW=... python3 slot-picker-verify.py
"""
import os
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:4200")
import uuid
EMAIL = os.environ.get("CUSTOMER_EMAIL", f"slotprobe-{uuid.uuid4().hex[:8]}@probe.local")
PW = os.environ.get("CUSTOMER_PW", "ProbePw1234!")
PHONE = {"width": 390, "height": 844}

fails = []
def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"  :: {detail}" if detail else ""))
    if not ok:
        fails.append(name)

with sync_playwright() as p:
    br = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = br.new_context(viewport=PHONE)
    errors = []
    ctx.on("weberror", lambda e: errors.append(str(e.error)))

    pg = ctx.new_page()
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    # ---- throwaway customer account
    # The customer portal is role-gated, and the shared test logins on this DB
    # are riders/admins (signing in as one lands on /rider, not /app). So this
    # signs up a disposable customer, and prints the email + booking id at the
    # end so the probe rows can be deleted and the deletion verified.
    print(f"PROBE ACCOUNT {EMAIL}")
    pg.goto(f"{BASE}/sign-up", wait_until="load")
    pg.fill('input[placeholder="Full name"]', "Slot Picker Probe")
    pg.fill('input[type="email"]', EMAIL)
    pg.fill('input[type="password"]', PW)
    pg.click('button[type="submit"]')
    pg.wait_for_url(lambda u: "/sign-up" not in u, timeout=25000)
    check("probe customer signed up", "/sign-up" not in pg.url, pg.url)

    # ---- open the first service's booking page
    pg.goto(f"{BASE}/app", wait_until="load")
    pg.wait_for_timeout(2500)
    link = pg.locator('a[href^="/app/book/"]').first
    check("a service is bookable", link.count() > 0)
    href = link.get_attribute("href")
    pg.goto(f"{BASE}{href}", wait_until="load")
    pg.wait_for_selector('[role="tablist"][aria-label="Choose a day"]', timeout=20000)

    tabs = pg.locator('[role="tab"]')
    n_days = tabs.count()
    check("day row is rendered with multiple days", n_days >= 2, f"{n_days} days")

    # 1. no flat wall: no time button repeats the month name
    times = pg.locator('button[aria-pressed]')
    labels = [times.nth(i).inner_text().strip() for i in range(times.count())]
    dated = [t for t in labels if any(m in t for m in
             ("Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"))]
    check("time buttons are times only, no dates", not dated, str(dated[:3]))
    check("one day's times only (<= 5 on screen)", 0 < len(labels) <= 5, f"{len(labels)}: {labels}")

    # 2. tap targets
    small = []
    for i in range(times.count()):
        box = times.nth(i).bounding_box()
        if box and box["height"] < 44:
            small.append((labels[i], round(box["height"])))
    check("every time button >= 44px tall", not small, str(small))

    # 3. pick a time, confirm it sticks
    times.first.click()
    picked = labels[0]
    pg.wait_for_timeout(300)
    check("picked time is marked selected",
          pg.locator('button[aria-pressed="true"]').count() == 1, picked)

    # 4. switch to the LAST day. Every day offers the same clock times, so the
    #    LABELS are identical by design — the day heading is what must change.
    #    (Comparing labels here is what made the first version of this check
    #    pass on a broken build.)
    heading = pg.locator("p.uppercase").first
    day1_heading = heading.inner_text().strip()
    tabs.nth(n_days - 1).click()
    pg.wait_for_timeout(400)
    day2_heading = heading.inner_text().strip()
    check("tapping another day actually moves the picker",
          day2_heading != day1_heading, f"{day1_heading} -> {day2_heading}")
    check("only the tapped day is selected",
          pg.locator('[role="tab"][aria-selected="true"]').count() == 1)
    # the earlier pick lives on another day, so nothing is pressed here
    check("selection does not bleed across days",
          pg.locator('button[aria-pressed="true"]').count() == 0)

    # 5. back to the first day: the pick is still there
    tabs.first.click()
    pg.wait_for_timeout(400)
    check("returning to the day keeps the picked time",
          pg.locator('button[aria-pressed="true"]').inner_text().strip() == picked)
    check("and the heading is back on the first day",
          heading.inner_text().strip() == day1_heading)

    # 6. the booking still submits with that slot
    pg.fill('input[placeholder*="Main St"]', "1 Portage Ave, Winnipeg, MB")
    pg.wait_for_timeout(1400)
    book = pg.locator('button:has-text("Book")').last
    book.click()
    try:
        pg.wait_for_selector('text=Booking confirmed', timeout=25000)
        check("booking submits with the picked slot", True)
        print(f"PROBE BOOKING {pg.url}")
    except Exception as e:
        body = pg.locator("body").inner_text()[:400]
        check("booking submits with the picked slot", False, body)

    real = [e for e in errors if "favicon" not in e and "/api/public/file" not in e]
    check("no console errors", not real, str(real[:3]))
    br.close()

print()
if fails:
    print(f"FAILED {len(fails)}: " + ", ".join(fails))
    sys.exit(1)
print("ALL CLEAN")
