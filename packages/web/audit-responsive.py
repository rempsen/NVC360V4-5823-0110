"""
Responsive audit of the admin console at real mobile/tablet viewports.

Why this exists: `mb shot --width` only resizes for the screenshot, so every
layout measurement taken through `mb js` was actually reading the 1024px
desktop layout. Those "no overflow" readings were measuring the wrong viewport.
This drives real 390px and 768px viewports.

Reports, per page:
  - horizontal overflow that is NOT inside an overflow-x scroll container
    (inside one it's intentional table scroll, not breakage)
  - text clipped by an ancestor's overflow:hidden with no ellipsis
  - tap targets under 44x44 (Apple HIG minimum)

Run: python3 audit-responsive.py [--shots]
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:4200")
EMAIL = "dan@nvc360.com"
PASSWORD = "NVC423!!"
SHOTS = "--shots" in sys.argv
OUT = "/tmp/responsive"
if SHOTS:
    os.makedirs(OUT, exist_ok=True)

PAGES = [
    ("dashboard", "/admin"),
    ("work-orders", "/admin/work-orders"),
    ("scheduler", "/admin/scheduler"),
    ("catalog", "/admin/catalog"),
    ("notifications", "/admin/notifications"),
    ("team", "/admin/techs"),
    ("zones", "/admin/zones"),
    ("reports", "/admin/reports"),
]

AUDIT_JS = r"""
() => {
  const lim = document.documentElement.clientWidth;
  const scrollable = (el) => {
    let p = el.parentElement;
    while (p) {
      const s = getComputedStyle(p);
      // hidden/clip also mean the child cannot visibly escape (leaflet panes)
      if (["auto", "scroll", "hidden", "clip"].includes(s.overflowX)) return true;
      p = p.parentElement;
    }
    return false;
  };
  const desc = (e) =>
    e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + "." + String(e.className || "").slice(0, 50);

  const overflow = [], clipped = [], small = [];
  for (const e of document.querySelectorAll("*")) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;

    if (r.right > lim + 1 && !scrollable(e)) {
      overflow.push({ el: desc(e), n: Math.round(r.right), text: (e.textContent || "").trim().slice(0, 40) });
    }

    // .sr-only is clipped on purpose -- it is the screen-reader-only pattern
    if (e.children.length === 0 && (e.textContent || "").trim() && !e.classList.contains("sr-only")) {
      if (e.scrollWidth > e.clientWidth + 1) {
        const s = getComputedStyle(e);
        if (s.textOverflow !== "ellipsis" && s.overflow !== "visible") {
          clipped.push({ el: desc(e), n: 0, text: e.textContent.trim().slice(0, 40) });
        }
      }
    }

    if (["BUTTON", "A"].includes(e.tagName) || e.getAttribute("role") === "button") {
      if ((e.textContent || "").trim() || e.querySelector("svg")) {
        if ((r.width < 44 || r.height < 44) && r.width > 0) {
          small.push({
            el: desc(e),
            n: 0,
            text: Math.round(r.width) + "x" + Math.round(r.height) + " " + (e.textContent || "").trim().slice(0, 22),
          });
        }
      }
    }
  }
  const uniq = (a) => [...new Map(a.map((x) => [x.el + x.text, x])).values()];
  return {
    vw: lim,
    docScroll: document.documentElement.scrollWidth,
    overflow: uniq(overflow).slice(0, 8),
    clipped: uniq(clipped).slice(0, 8),
    small: uniq(small).slice(0, 10),
  };
}
"""

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome")
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()

    page.goto(f"{BASE}/sign-in", wait_until="domcontentloaded")
    page.fill('input[type="email"]', EMAIL)
    page.fill('input[type="password"]', PASSWORD)
    page.click('button[type="submit"]')
    try:
        page.wait_for_url("**/admin**", timeout=30_000)
    except Exception:
        pass
    page.wait_for_timeout(2500)
    print("signed in ->", page.url)

    total = 0
    for width in (390, 768):
        page.set_viewport_size({"width": width, "height": 844 if width == 390 else 1024})
        print("\n" + "=" * 62)
        print(f"  VIEWPORT {width}px")
        print("=" * 62)
        for name, path in PAGES:
            page.goto(f"{BASE}{path}", wait_until="domcontentloaded")
            page.wait_for_timeout(2200)
            r = page.evaluate(AUDIT_JS)
            if SHOTS:
                page.screenshot(path=f"{OUT}/{width}-{name}.png")
            n = len(r["overflow"]) + len(r["clipped"]) + len(r["small"])
            total += n
            print(f"\n{name} ({r['vw']}px, scrollWidth {r['docScroll']}){' - clean' if n == 0 else ''}")
            if r["overflow"]:
                print("  OVERFLOW (not in a scroll container):")
                for o in r["overflow"]:
                    print(f"    right={o['n']} {o['el']} \"{o['text']}\"")
            if r["clipped"]:
                print("  CLIPPED TEXT:")
                for o in r["clipped"]:
                    print(f"    {o['el']} \"{o['text']}\"")
            if r["small"]:
                print("  TAP TARGETS < 44px:")
                for o in r["small"]:
                    print(f"    {o['text']} -> {o['el']}")

    print(f"\nTOTAL ISSUES: {total}")
    browser.close()
