#!/usr/bin/env python3
"""
Accessibility regression gate for the admin surface.

Drives every admin page in real Chrome at phone (390px) and desktop (1440px)
width and FAILS (exit 1) if it finds a regression in any of:

  - a button/link/[role=button] with no accessible name  (icon-only control
    that a screen reader or voice control can't address)
  - a form input/select/textarea with no associated label
  - an <img> with no alt attribute
  - a tap target under 32px at phone width
  - horizontal overflow at phone width (page broken on mobile web)

Why this exists: a July/August 2026 audit found 43 unnamed icon-only controls
and 3 unlabelled selects across the admin. They were all fixed, but nothing
stopped the next icon-only button from reintroducing the problem. This makes
that a build failure instead of something we rediscover in an audit months
later.

IMPORTANT — DO NOT wire this into `bun run build`.
The platform runs the build script to deploy. A gate that needs Chrome, a
booted dev server and a live database will fail in that environment and block
publishing. This is a standalone check: run it locally or in CI against a
running server, never as part of the deploy build.

Usage:
    # needs the dev server up (tmux 'web', port 4200)
    python3 a11y-gate.py                 # gate: exits 1 on any regression
    python3 a11y-gate.py --report        # print findings, always exit 0
    python3 a11y-gate.py --update-baseline   # accept current state as allowed

Exit codes: 0 = clean (or report mode), 1 = regression found, 2 = setup failure
(server down, login failed) so a broken harness is never mistaken for a pass.
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("A11Y_BASE", "http://localhost:4200")
EMAIL = os.environ.get("A11Y_EMAIL", "dan@nvc360.com")
PW = os.environ.get("A11Y_PW", "NVC423!!")
BASELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "a11y-baseline.json")

PAGES = [
    # Every path here is checked against the real router: a path that does not
    # exist renders AdminNotFound, which is a clean, tiny page that passes every
    # check trivially. /admin/bookings, /admin/team, /admin/users and
    # /admin/customers were all in these lists and none of them are routes, so
    # the gates were quietly auditing a 404 instead of the work-orders table,
    # the tech roster and the client list. The 404 guard below makes that
    # impossible to repeat silently.
    "/admin", "/admin/work-orders", "/admin/scheduler", "/admin/fleet",
    "/admin/techs", "/admin/clients", "/admin/services", "/admin/catalog",
    "/admin/options", "/admin/builder", "/admin/intake-forms", "/admin/zones",
    "/admin/reports", "/admin/notifications", "/admin/settings", "/admin/inbox",
    "/admin/payouts", "/admin/automation", "/admin/maintenance", "/admin/tags",
    "/admin/audit", "/admin/api-access", "/admin/integrations",
    "/admin/reviews", "/admin/companies",
]

# Findings we accept and will not fail on, with the reason. Keep this list SHORT
# and justified — every entry is a real gap someone using a screen reader hits.
# Matching is substring-based against the finding's descriptor.
ALLOWED = [
    # Leaflet builds its own marker DOM; we don't control these nodes. The map
    # pages provide an accessible list of the same data alongside the map.
    ("ctlNoName", "leaflet-marker-icon"),
    ("ctlNoName", "leaflet-control"),
    ("tinyTap", "leaflet"),
    # Deliberate horizontal scrollers with a visible affordance, not layout
    # accidents. A phone-shaped replacement would cost more than it buys:
    # the notification grid is a real event x recipient x channel matrix, and
    # the other two are tab/chip strips that are meant to swipe.
    ("hscroll", "overflow-x-auto rounded-2xl border border-white/5 nvc-card"),
    ("hscroll", "mb-5 flex gap-1 overflow-x-auto border-b border-white/5"),
    ("hscroll", "nvc-glass no-scrollbar pointer-events-auto"),
]

AUDIT_JS = """
() => {
  const out = {overflow:null, imgNoAlt:[], ctlNoName:[], inputNoLabel:[],
               tinyTap:[], hscroll:[], notFound:false};
  const de = document.documentElement;
  // A path that isn't a route renders the admin 404, which passes every check
  // below trivially and reports as coverage it never had.
  out.notFound = (document.body.innerText || '').includes("This admin page doesn't exist");
  // Document-level overflow was the only width check here, so a table inside
  // its own overflow-x-auto -- exactly how the work-orders list hid the
  // customer, tech and total behind a sideways scroll on a phone -- was
  // invisible to this gate. Inner scrollers count too.
  document.querySelectorAll('div, section, main, ul, ol').forEach(el => {
    if (el.scrollWidth <= el.clientWidth + 8) return;
    const ov = getComputedStyle(el).overflowX;
    if (ov !== 'auto' && ov !== 'scroll') return;
    out.hscroll.push(el.scrollWidth + 'px in ' + el.clientWidth + 'px ' +
                     (el.className || '').toString().slice(0, 80));
  });
  out.overflow = de.scrollWidth > de.clientWidth + 2
    ? {scrollWidth: de.scrollWidth, clientWidth: de.clientWidth} : null;
  if (out.overflow) {
    let worst=null;
    document.querySelectorAll('*').forEach(el=>{
      const r=el.getBoundingClientRect();
      if (r.width>de.clientWidth+2 && (!worst||r.width>worst.w)) {
        worst={w:Math.round(r.width), tag:el.tagName.toLowerCase(),
               cls:(el.className||'').toString().slice(0,90)};
      }
    });
    out.overflow.worst = worst;
  }

  document.querySelectorAll('img').forEach(i=>{
    if (!i.hasAttribute('alt')) out.imgNoAlt.push((i.getAttribute('src')||'').slice(0,60));
  });

  // An accessible name can come from aria-label, title, text content, an
  // alt-bearing child image, or aria-labelledby pointing at real text.
  const name = el => {
    const byId = el.getAttribute('aria-labelledby');
    let ref = '';
    if (byId) ref = byId.split(/\\s+/).map(i=>document.getElementById(i))
                        .filter(Boolean).map(n=>n.textContent||'').join(' ');
    return (
      (el.getAttribute('aria-label')||'') || (el.getAttribute('title')||'') ||
      (el.textContent||'').trim() ||
      (el.querySelector('img[alt]')?.getAttribute('alt')||'') || ref
    ).trim();
  };

  document.querySelectorAll('button, a[href], [role=button]').forEach(el=>{
    const r = el.getBoundingClientRect();
    if (r.width===0 && r.height===0) return;             // not rendered
    if (el.getAttribute('aria-hidden')==='true') return; // intentionally hidden
    const cls = (el.className||'').toString().slice(0,70);
    if (!name(el)) out.ctlNoName.push(el.tagName.toLowerCase()+'.'+cls);
    if ((r.width<32 || r.height<32) && r.width>0)
      out.tinyTap.push(Math.round(r.width)+'x'+Math.round(r.height)+' '+
                       ((name(el)||el.tagName)+' '+cls).slice(0,60));
  });

  document.querySelectorAll('input, select, textarea').forEach(el=>{
    if (el.type==='hidden') return;
    const id = el.id;
    const hasLabel = (id && document.querySelector(`label[for="${id}"]`)) ||
                     el.closest('label') || el.getAttribute('aria-label') ||
                     el.getAttribute('aria-labelledby') || el.getAttribute('placeholder');
    if (!hasLabel) out.inputNoLabel.push((el.tagName+':'+(el.type||'')+':'+(el.name||'')).slice(0,60));
  });
  return out;
}
"""

CHECKS = ("ctlNoName", "inputNoLabel", "imgNoAlt", "tinyTap", "hscroll")


def allowed(kind: str, descriptor: str) -> bool:
    return any(k == kind and frag in descriptor for k, frag in ALLOWED)


def collect():
    """Drive every page at both widths. Returns {key: audit dict}."""
    results = {}
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        ctx = b.new_context(viewport={"width": 1440, "height": 900})
        pg = ctx.new_page()
        try:
            pg.goto(f"{BASE}/sign-in", wait_until="domcontentloaded", timeout=20000)
        except Exception as e:
            print(f"SETUP FAILURE: can't reach {BASE} — is the dev server up? ({e})")
            sys.exit(2)
        pg.fill("input[type=email]", EMAIL)
        pg.fill("input[type=password]", PW)
        pg.click("button[type=submit]")
        pg.wait_for_timeout(4000)
        if "/sign-in" in pg.url:
            print("SETUP FAILURE: login failed — check A11Y_EMAIL / A11Y_PW")
            sys.exit(2)

        for width in (390, 1440):
            pg.set_viewport_size({"width": width, "height": 900})
            for path in PAGES:
                try:
                    pg.goto(BASE + path, wait_until="domcontentloaded", timeout=20000)
                    pg.wait_for_timeout(2200)
                    a = pg.evaluate(AUDIT_JS)
                except Exception as e:
                    a = {"error": str(e)[:140]}
                if a.get("notFound"):
                    print(f"SETUP FAILURE: {path} is not a route — it renders the "
                          f"admin 404, so auditing it proves nothing. Fix PAGES.")
                    b.close()
                    sys.exit(2)
                results[f"{width}{path}"] = a
        b.close()
    return results


def findings(results):
    """Flatten to a list of (key, kind, descriptor), dropping allowed ones."""
    out = []
    for key, v in results.items():
        if v.get("error"):
            out.append((key, "loadError", v["error"]))
            continue
        width = 390 if key.startswith("390") else 1440
        for kind in CHECKS:
            # tap-target size and overflow only matter at phone width
            if kind in ("tinyTap", "hscroll") and width != 390:
                continue
            for d in v.get(kind) or []:
                if not allowed(kind, d):
                    out.append((key, kind, d))
        if width == 390 and v.get("overflow"):
            o = v["overflow"]
            w = (o.get("worst") or {})
            out.append((key, "overflow",
                        f"{o['scrollWidth']}px > {o['clientWidth']}px worst={w.get('tag')} {w.get('w')}px"))
    return out


def load_baseline():
    if not os.path.exists(BASELINE):
        return set()
    with open(BASELINE) as f:
        return {tuple(x) for x in json.load(f).get("accepted", [])}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    results = collect()
    found = findings(results)
    json.dump(results, open("/tmp/a11y-gate-raw.json", "w"), indent=1)

    if mode == "--update-baseline":
        with open(BASELINE, "w") as f:
            json.dump({
                "_comment": "Accepted pre-existing a11y findings. Shrink this list, never grow it.",
                "accepted": sorted([list(x) for x in found]),
            }, f, indent=1)
        print(f"baseline written: {len(found)} accepted finding(s) -> {BASELINE}")
        return 0

    base = load_baseline()
    new = [f for f in found if tuple(f) not in base]
    fixed = [f for f in base if f not in {tuple(x) for x in found}]

    by_kind = {}
    for _, kind, _ in new:
        by_kind[kind] = by_kind.get(kind, 0) + 1

    if new:
        print(f"\n{len(new)} NEW accessibility finding(s):\n")
        for key, kind, d in new:
            width, path = (key[:3], key[3:]) if key.startswith("390") else (key[:4], key[4:])
            print(f"  [{kind}] {path} @{width}px")
            print(f"      {d}")
        print("\nsummary:", ", ".join(f"{k}={v}" for k, v in sorted(by_kind.items())))
        print("""
How to fix:
  ctlNoName    icon-only button/link -> add aria-label (and title for a tooltip)
  inputNoLabel <select>/<input> -> add aria-label, or a <label for=...>
  imgNoAlt     add alt="" for decorative, or real descriptive text
  tinyTap      make it at least 32x32 at 390px (padding, not font-size)
  hscroll      an inner overflow-x-auto scrolls sideways on a phone — give the
               list a stacked card layout below md/lg instead of a wide table
  overflow     something is wider than the viewport — usually a table or a
               fixed-width element that needs overflow-x-auto or a min-w-0
  loadError    the page threw or timed out — that's a real bug, not an a11y one
""")
    if fixed:
        print(f"{len(fixed)} baseline finding(s) no longer present — "
              f"run --update-baseline to shrink the allowlist.")

    if mode == "--report":
        print(f"\n(report mode) total findings: {len(found)}, new vs baseline: {len(new)}")
        return 0
    if new:
        return 1
    print(f"A11Y GATE PASS — {len(PAGES)} pages x 2 widths, no new findings "
          f"({len(base)} accepted in baseline).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
