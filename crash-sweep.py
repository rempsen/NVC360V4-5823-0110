"""Live crash sweep: sign in as admin, visit every admin page in a real browser,
fail on any console error, page error, failed request or rendered error boundary.

Usage: python3 crash-sweep.py            (server must be on :4200)
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4200"
ADMIN = ("admin@nvc360.app", "admin123")

PAGES = [
    "/admin", "/admin/fleet", "/admin/scheduler", "/admin/work-orders",
    "/admin/builder", "/admin/techs", "/admin/clients", "/admin/automation",
    "/admin/maintenance", "/admin/inbox", "/admin/change-requests",
    "/admin/integrations", "/admin/api-access", "/admin/intake-forms",
    "/admin/reports", "/admin/zones", "/admin/payouts", "/admin/tags",
    "/admin/audit", "/admin/settings", "/admin/catalog", "/admin/options",
    "/admin/services", "/admin/reviews", "/admin/notifications",
]

IGNORE = (
    "favicon", "sentry", "ResizeObserver", "Download the React DevTools",
    "chrome-extension", "/api/auth/get-session",
    # benign for a sandbox sweep, not app faults:
    "/stream",              # SSE aborted when the sweep navigates away
    "basemaps.cartocdn",    # map tiles, no outbound CDN in the sandbox
    "/api/public/file/",    # dev storage is missing some uploaded demo images
    # the console version of a bad request carries no URL, so it can't be
    # filtered by origin — the response listener below reports it with its URL.
    "Failed to load resource",
)


def sweep(width, height, label, results):
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        ctx = b.new_context(viewport={"width": width, "height": height})
        pg = ctx.new_page()
        pg.goto(f"{BASE}/sign-in")
        pg.fill('input[type="email"]', ADMIN[0])
        pg.fill('input[type="password"]', ADMIN[1])
        pg.click('button[type="submit"]')
        pg.wait_for_url("**/admin**", timeout=30000)

        # A fresh page per path: with one shared page, a request cancelled by
        # navigating away (SSE streams, in-flight queries) surfaced as a failure
        # on the NEXT page in the list.
        for path in PAGES:
            errs = []
            tab = ctx.new_page()
            tab.set_viewport_size({"width": width, "height": height})
            tab.on("console", lambda m, e=errs: e.append(m.text) if m.type == "error" else None)
            tab.on("pageerror", lambda ex, e=errs: e.append(f"pageerror: {ex}"))
            tab.on("requestfailed", lambda r, e=errs: e.append(f"reqfail: {r.url}"))
            tab.on(
                "response",
                lambda r, e=errs: e.append(f"http {r.status}: {r.url}") if r.status >= 400 else None,
            )
            tab.goto(f"{BASE}{path}", wait_until="load", timeout=45000)
            tab.wait_for_timeout(2200)
            body = tab.inner_text("body")
            if "Something went wrong" in body or "Unexpected error" in body:
                errs.append("error boundary rendered")
            if len(body.strip()) < 40:
                errs.append("page rendered empty")
            errs = [e for e in errs if not any(i in e for i in IGNORE)]
            status = "CLEAN" if not errs else "FAIL"
            results.append((label, path, status, errs))
            print(f"[{label}] {path}: {status}" + ("" if not errs else f" -> {errs[:3]}"))
            tab.close()
        b.close()


def main():
    results = []
    sweep(1440, 900, "desktop", results)
    sweep(390, 844, "mobile", results)
    bad = [r for r in results if r[2] != "CLEAN"]
    print(f"\n{len(results) - len(bad)}/{len(results)} clean")
    if bad:
        for label, path, _, errs in bad:
            print(f"  {label} {path}: {errs}")
        sys.exit(1)
    print("ALL CLEAN")


main()
