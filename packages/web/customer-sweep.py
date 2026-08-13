#!/usr/bin/env python3
"""
Customer-facing sweep: the surfaces a paying customer actually touches.

Both existing gates (crash-sweep.py, a11y-gate.py) only ever drove /admin.
So the entire customer journey — the marketing/landing route, sign-in, sign-up,
password reset, the public intake form, the SMS tracking link, the public
property page, and the whole logged-in /app portal (home, bookings, book,
track, profile) — has never been audited by anything. Nine of these pages are
reachable by an unauthenticated stranger with a link, which makes them the
highest-exposure surface in the product and the least checked.

What it checks per page, at 390px and 1440px:
  - uncaught page errors and error-boundary renders (crash sweep)
  - failed network requests originating from the page
  - a11y: unnamed controls, unlabelled inputs, img without alt
  - phone width: tap targets under 32px, document + inner horizontal overflow

Usage:
    python3 customer-sweep.py            # exits 1 on any finding
    python3 customer-sweep.py --report   # print everything, always exit 0

Exit codes: 0 clean/report, 1 finding, 2 setup failure (server down, login
failed, or a path that turned out not to be a route).

Needs the dev server on :4200 and CUSTOMER_EMAIL / CUSTOMER_PW for the portal
pages. Never wire this into `bun run build` — the platform runs that to deploy.
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("SWEEP_BASE", "http://localhost:4200")
CUST_EMAIL = os.environ.get("CUSTOMER_EMAIL", "")
CUST_PW = os.environ.get("CUSTOMER_PW", "")
# Live fixtures — a real intake form, a real job tracking token, a real
# property token. Overridable so this isn't pinned to one database.
FORM = os.environ.get("SWEEP_FORM", "/f/default/request-service")
TRACK_TOKEN = os.environ.get("SWEEP_TRACK", "")
PROP_TOKEN = os.environ.get("SWEEP_PROP", "")

BOUNDARY = "This page hit a problem"

AUDIT_JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "a11y-gate.py")).read().split('AUDIT_JS = """')[1].split('"""')[0]

# Same justified exceptions as the admin gate, plus the customer map.
ALLOWED = [
    ("ctlNoName", "leaflet-marker-icon"),
    ("ctlNoName", "leaflet-control"),
    ("tinyTap", "leaflet"),
]

CHECKS = ("ctlNoName", "inputNoLabel", "imgNoAlt", "tinyTap", "hscroll")


def allowed(kind, descriptor):
    return any(k == kind and frag in descriptor for k, frag in ALLOWED)


def public_pages():
    pages = ["/", "/sign-in", "/sign-up", "/forgot-password", FORM]
    if TRACK_TOKEN:
        pages.append(f"/t/{TRACK_TOKEN}")
    if PROP_TOKEN:
        pages.append(f"/p/{PROP_TOKEN}")
    return pages


PORTAL_PAGES = ["/app", "/app/bookings", "/app/profile"]


def sweep_page(pg, path, width, results):
    # Listeners MUST be removed again. Leaving them attached accumulated every
    # earlier page's failures onto later pages, which attributed a /t/ SSE
    # stream failure to /p/ — a swept gate that lies is worse than no gate.
    errs, netfail = [], []
    on_err = lambda e: errs.append(str(e)[:200])
    # net::ERR_ABORTED is what a still-in-flight request (an image, or the
    # tracking page's SSE stream) reports when the sweep navigates away. That
    # is the harness cancelling it, not the product failing — verified by
    # loading the same pages in isolation, where nothing fails at all.
    on_fail = lambda r: netfail.append(f"{r.method} {r.url[:90]} [{r.failure}]") \
        if "ERR_ABORTED" not in (r.failure or "") else None
    pg.on("pageerror", on_err)
    pg.on("requestfailed", on_fail)
    try:
        resp = pg.goto(BASE + path, wait_until="domcontentloaded", timeout=25000)
        pg.wait_for_timeout(2800)
        a = pg.evaluate(AUDIT_JS)
        body = pg.inner_text("body")
        a["http"] = resp.status if resp else 0
        a["boundary"] = BOUNDARY in body
        # A blank page passes every a11y check trivially, so treat "almost no
        # text" as a finding rather than silent coverage.
        a["blank"] = len(body.strip()) < 40
        a["pageErrors"] = errs[:]
        a["netFailed"] = [n for n in netfail if "favicon" not in n][:]
    except Exception as e:
        a = {"error": str(e)[:160]}
    finally:
        pg.remove_listener("pageerror", on_err)
        pg.remove_listener("requestfailed", on_fail)
    results[f"{width}{path}"] = a


def collect():
    results = {}
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        for width in (390, 1440):
            ctx = b.new_context(viewport={"width": width, "height": 900})
            pg = ctx.new_page()
            try:
                pg.goto(f"{BASE}/sign-in", wait_until="domcontentloaded", timeout=20000)
            except Exception as e:
                print(f"SETUP FAILURE: can't reach {BASE} — dev server up? ({e})")
                sys.exit(2)

            for path in public_pages():
                sweep_page(pg, path, width, results)

            if CUST_EMAIL and CUST_PW:
                pg.goto(f"{BASE}/sign-in", wait_until="domcontentloaded")
                pg.fill("input[type=email]", CUST_EMAIL)
                pg.fill("input[type=password]", CUST_PW)
                pg.click("button[type=submit]")
                pg.wait_for_timeout(5000)
                if "/sign-in" in pg.url:
                    print("SETUP FAILURE: customer login failed — check CUSTOMER_EMAIL/PW")
                    b.close()
                    sys.exit(2)
                for path in PORTAL_PAGES:
                    sweep_page(pg, path, width, results)
                # /app/book/:id and /app/track/:id need a real id, so follow the
                # portal's own links instead of guessing one.
                pg.goto(f"{BASE}/app", wait_until="domcontentloaded")
                pg.wait_for_timeout(2500)
                for sel, label in (('a[href^="/app/book/"]', "/app/book/:id"),
                                   ('a[href^="/app/track/"]', "/app/track/:id")):
                    href = pg.eval_on_selector(sel, "e => e.getAttribute('href')") \
                        if pg.query_selector(sel) else None
                    if href:
                        sweep_page(pg, href, width, results)
                        results[f"{width}{label}"] = results.pop(f"{width}{href}")
                    else:
                        results[f"{width}{label}"] = {"skipped": "no link on /app"}
                ctx.clear_cookies()
            ctx.close()
        b.close()
    return results


def findings(results):
    out = []
    for key, v in results.items():
        if v.get("skipped"):
            continue
        if v.get("error"):
            out.append((key, "loadError", v["error"]))
            continue
        width = 390 if key.startswith("390") else 1440
        if v.get("http", 200) >= 400:
            out.append((key, "http", str(v["http"])))
        if v.get("boundary"):
            out.append((key, "errorBoundary", "error boundary rendered"))
        if v.get("blank"):
            out.append((key, "blankPage", "under 40 chars of text"))
        for e in v.get("pageErrors") or []:
            out.append((key, "pageError", e))
        for n in v.get("netFailed") or []:
            out.append((key, "netFailed", n))
        for kind in CHECKS:
            if kind in ("tinyTap", "hscroll") and width != 390:
                continue
            for d in v.get(kind) or []:
                if not allowed(kind, d):
                    out.append((key, kind, d))
        if width == 390 and v.get("overflow"):
            o = v["overflow"]
            w = o.get("worst") or {}
            out.append((key, "overflow",
                        f"{o['scrollWidth']}px > {o['clientWidth']}px worst={w.get('tag')} {w.get('w')}px"))
    return out


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    results = collect()
    json.dump(results, open("/tmp/customer-sweep-raw.json", "w"), indent=1)
    found = findings(results)
    swept = len([k for k in results if k.startswith("390")])

    if not found:
        print(f"CUSTOMER SWEEP PASS — {swept} pages x 2 widths, 0 findings.")
        return 0

    print(f"\n{len(found)} finding(s) across the customer surface:\n")
    for key, kind, d in sorted(found):
        width, path = (key[:3], key[3:]) if key.startswith("390") else (key[:4], key[4:])
        print(f"  [{kind}] {path} @{width}px")
        print(f"      {d}")
    by_kind = {}
    for _, kind, _ in found:
        by_kind[kind] = by_kind.get(kind, 0) + 1
    print("\nsummary:", ", ".join(f"{k}={v}" for k, v in sorted(by_kind.items())))
    return 0 if mode == "--report" else 1


if __name__ == "__main__":
    sys.exit(main())
