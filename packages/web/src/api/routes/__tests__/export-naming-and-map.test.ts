/**
 * Export filenames must carry the TENANT name (a BMD Materials job report is
 * useless if it downloads as "nvc360-job-…"), and the route section must use a
 * real basemap when a Maps key exists while never failing the export when it
 * doesn't.
 */
import { describe, expect, test, afterEach } from "bun:test";

import { slugifyName, fetchRouteBasemap, fetchSiteBasemap } from "../../lib/export-map";

const route = [
  { lat: 49.86, lng: -97.19, phase: "enroute" },
  { lat: 49.865, lng: -97.2, phase: "enroute" },
  { lat: 49.87, lng: -97.21, phase: "onsite" },
  { lat: 49.8701, lng: -97.2101, phase: "onsite" },
  { lat: 49.86, lng: -97.19, phase: "return" },
];

describe("tenant-aware export filenames", () => {
  test("company name becomes a safe filename token", () => {
    expect(slugifyName("BMD Materials")).toBe("bmd-materials");
    expect(slugifyName("Dan's HVAC & Co. (Winnipeg)")).toBe("dan-s-hvac-co-winnipeg");
    expect(slugifyName("  ---  ")).toBe("");
    expect(slugifyName(undefined)).toBe("");
    expect(slugifyName(null)).toBe("");
  });

  test("no quotes, slashes or newlines survive (Content-Disposition safety)", () => {
    const s = slugifyName('ev"il/../name\nhere');
    expect(s).not.toContain('"');
    expect(s).not.toContain("/");
    expect(s).not.toContain("\n");
    expect(/^[a-z0-9-]*$/.test(s)).toBe(true);
  });

  test("long names are truncated", () => {
    expect(slugifyName("a".repeat(200)).length).toBeLessThanOrEqual(40);
  });
});

describe("route basemap", () => {
  const KEY = process.env.GOOGLE_MAPS_API_KEY;
  afterEach(() => {
    if (KEY === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = KEY;
  });

  test("returns null (caller falls back to the vector sketch) with no API key", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    expect(await fetchRouteBasemap(route)).toBeNull();
    expect(await fetchSiteBasemap(route)).toBeNull();
  });

  test("returns null for degenerate input instead of throwing", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "fake-key-not-used";
    expect(await fetchRouteBasemap([])).toBeNull();
    expect(await fetchRouteBasemap([route[0]])).toBeNull();
    expect(
      await fetchRouteBasemap([
        { lat: NaN, lng: NaN, phase: "enroute" },
        { lat: NaN, lng: NaN, phase: "return" },
      ]),
    ).toBeNull();
    expect(await fetchSiteBasemap([])).toBeNull();
  });

  test("a bad key yields null, never a throw and never a non-PNG body", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "definitely-invalid-key";
    expect(await fetchRouteBasemap(route)).toBeNull();
  });

  test("with a real key it returns a PNG of the driven route", async () => {
    if (!KEY) return; // key-less CI: covered by the null-path tests above
    process.env.GOOGLE_MAPS_API_KEY = KEY;
    const png = await fetchRouteBasemap(route);
    expect(png).not.toBeNull();
    expect(png!.length).toBeGreaterThan(10_000); // real tiles, not a stub
    expect(png!.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const site = await fetchSiteBasemap(route);
    expect(site).not.toBeNull();
    expect(site!.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  }, 30_000);
});
