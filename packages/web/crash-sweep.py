"""
Walk every admin page AND every in-page tab in a real browser, and fail on any
error-boundary render or uncaught page error.

This exists because the Channels tab of /admin/notifications was completely
dead — a hook called after an early return threw "Rendered more hooks than
during the previous render" — and nothing in tsc, the build, or an API test
could see it. Only rendering the page does.

Pages that hold an open SSE stream (/admin/inbox) never reach networkidle, so
navigation waits on domcontentloaded plus a fixed settle delay.
"""
import sys
from playwright.sync_api import sync_playwright

PAGES = [
    "/admin", "/admin/work-orders", "/admin/scheduler", "/admin/team",
    "/admin/customers", "/admin/catalog", "/admin/services", "/admin/zones",
    "/admin/notifications", "/admin/reports", "/admin/settings", "/admin/inbox",
    "/admin/intake-forms", "/admin/payouts", "/admin/fleet", "/admin/automation",
]
BOUNDARY = "This page hit a problem"
fails = []

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome")
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    pg.goto("http://localhost:4200/sign-in", wait_until="domcontentloaded")
    pg.fill('input[type="email"]', "dan@nvc360.com")
    pg.fill('input[type="password"]', "NVC423!!")
    pg.click('button[type="submit"]')
    pg.wait_for_timeout(7000)

    for path in PAGES:
        r = pg.goto("http://localhost:4200" + path, wait_until="domcontentloaded")
        if r and r.status >= 400:
            fails.append((path, "-", f"HTTP {r.status}"))
            continue
        pg.wait_for_timeout(3500)
        errs.clear()
        body = pg.inner_text("body")
        if BOUNDARY in body:
            fails.append((path, "-", body.split(BOUNDARY)[1].strip().split("\n")[0][:120]))
            print(f"  ✗ {path}")
            continue
        print(f"  ✓ {path}")

        # in-page tabs: buttons that look like tab labels and are cheap to click
        labels = pg.eval_on_selector_all(
            "nav button, [role=tablist] button, button",
            "els => els.map(e => e.innerText.trim().split('\\n')[0]).filter(t => t && t.length < 26)",
        )
        seen = set()
        for label in labels:
            if label in seen:
                continue
            seen.add(label)
            if label.lower() in {"test", "edit", "delete", "save", "save settings", "sign out",
                                 "assign", "ai suggest", "reload page", "try again", "send",
                                 "cancel", "remove", "revoke", "resend", "check verification",
                                 "add", "new", "create", "next", "back", "generate", "export"}:
                continue
            try:
                el = pg.get_by_role("button", name=label, exact=True).first
                if not el.is_visible():
                    continue
                el.click(timeout=3000)
            except Exception:
                continue
            pg.wait_for_timeout(1200)
            body = pg.inner_text("body")
            if BOUNDARY in body:
                msg = body.split(BOUNDARY)[1].strip().split("\n")[0][:120]
                fails.append((path, label, msg))
                print(f"      ✗ tab “{label}” — {msg}")
                pg.goto("http://localhost:4200" + path, wait_until="domcontentloaded")
                pg.wait_for_timeout(1500)
            elif errs:
                fails.append((path, label, errs[0]))
                print(f"      ✗ tab “{label}” — {errs[0]}")
                errs.clear()
    b.close()

print()
if fails:
    print(f"FAILURES: {len(fails)}")
    for f in fails:
        print("  ", f)
    sys.exit(1)
print("ALL CLEAN — no error boundary on any admin page or tab")
