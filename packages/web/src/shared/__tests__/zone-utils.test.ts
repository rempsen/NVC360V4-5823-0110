/**
 * Service-zone geometry. This file had no tests, and two bugs that made the
 * whole zones feature non-functional:
 *
 * 1. inPoly() mixed coordinate frames — polygon vertices were read as
 *    (y=lat, x=lng) but the test point was used as (y=lng, x=lat). The crossing
 *    test therefore compared a latitude against a longitude, which in Canada
 *    (lat ~+50, lng ~-97) is true for every vertex, so no crossing was ever
 *    counted and the function returned false for EVERY point. Consequence: any
 *    tenant that activated a service zone had every address rejected as
 *    "outside all active service zones" (admin work orders and public intake
 *    forms), and zone attribution in reports matched zero jobs.
 *
 * 2. circleToPolygon() converted metres to degrees and then ALSO multiplied by
 *    180/PI, inflating every circle zone by 57.3x — a 5 km radius covered
 *    ~286 km.
 *
 * These tests pin both down with absolute expectations (measured distances, and
 * points whose inside/outside status is obvious), in both hemispheres, so
 * neither can come back unnoticed.
 */
import { describe, it, expect } from "bun:test";
import { inPoly, isInAnyZone, circleToPolygon, rectToPolygon, type LatLng } from "../zone-utils";
import { haversineKm } from "../geo-distance";

/** Downtown-Winnipeg square: lat 49.87..49.92, lng -97.20..-97.08 */
const WPG: LatLng[] = [
  [49.87, -97.20],
  [49.92, -97.20],
  [49.92, -97.08],
  [49.87, -97.08],
];

/** Southern + eastern hemisphere (signs flipped both ways). */
const SYD: LatLng[] = [
  [-33.90, 151.10],
  [-33.80, 151.10],
  [-33.80, 151.30],
  [-33.90, 151.30],
];

describe("inPoly", () => {
  it("accepts the centre of the polygon", () => {
    expect(inPoly(49.895, -97.14, WPG)).toBe(true);
  });

  it("rejects a point outside on each side", () => {
    expect(inPoly(49.80, -97.14, WPG)).toBe(false); // south
    expect(inPoly(49.99, -97.14, WPG)).toBe(false); // north
    expect(inPoly(49.895, -97.30, WPG)).toBe(false); // west
    expect(inPoly(49.895, -97.00, WPG)).toBe(false); // east
  });

  it("rejects a point in a different city", () => {
    expect(inPoly(43.6532, -79.3832, WPG)).toBe(false); // Toronto
    expect(inPoly(51.0447, -114.0719, WPG)).toBe(false); // Calgary
  });

  it("works in the southern/eastern hemisphere", () => {
    expect(inPoly(-33.86, 151.20, SYD)).toBe(true);
    expect(inPoly(-33.86, 151.50, SYD)).toBe(false);
    expect(inPoly(-34.10, 151.20, SYD)).toBe(false);
  });

  it("handles a concave (L-shaped) polygon — the classic ray-casting case", () => {
    // L shape occupying lat 0..2 / lng 0..2 minus the top-right quadrant.
    const L: LatLng[] = [
      [0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2],
    ];
    expect(inPoly(0.5, 0.5, L)).toBe(true);   // in the base
    expect(inPoly(1.5, 0.5, L)).toBe(true);   // in the tall arm
    expect(inPoly(1.5, 1.5, L)).toBe(false);  // in the notch — must be OUT
  });

  it("a degenerate polygon contains nothing", () => {
    expect(inPoly(49.895, -97.14, [[49.87, -97.2], [49.92, -97.2]])).toBe(false);
  });
});

describe("isInAnyZone", () => {
  it("is unrestricted when there are no active zones", () => {
    expect(isInAnyZone(43.6532, -79.3832, [])).toBe(true);
    expect(isInAnyZone(43.6532, -79.3832, [{ polygon: WPG, active: false }])).toBe(true);
  });

  it("requires membership of at least one ACTIVE zone", () => {
    const zones = [{ polygon: WPG, active: true }, { polygon: SYD, active: false }];
    expect(isInAnyZone(49.895, -97.14, zones)).toBe(true);
    expect(isInAnyZone(-33.86, 151.20, zones)).toBe(false); // only in the inactive one
  });

  it("accepts a point in any one of several active zones", () => {
    const zones = [{ polygon: WPG, active: true }, { polygon: SYD, active: true }];
    expect(isInAnyZone(-33.86, 151.20, zones)).toBe(true);
  });
});

describe("circleToPolygon", () => {
  it("produces vertices at (approximately) the requested radius", () => {
    const r = 5_000; // 5 km
    const poly = circleToPolygon(49.895, -97.14, r);
    for (const [lat, lng] of poly) {
      const km = haversineKm(49.895, -97.14, lat, lng);
      // within 1% of 5 km — the old code produced ~286 km here
      expect(km).toBeGreaterThan(4.95);
      expect(km).toBeLessThan(5.05);
    }
  });

  it("contains its own centre and excludes a point just outside the radius", () => {
    const poly = circleToPolygon(49.895, -97.14, 5_000);
    expect(inPoly(49.895, -97.14, poly)).toBe(true);
    // ~0.18 deg north =~ 20 km away
    expect(inPoly(50.08, -97.14, poly)).toBe(false);
  });

  it("scales with latitude (longitude degrees shrink toward the poles)", () => {
    const near = circleToPolygon(0, 0, 10_000);
    const far = circleToPolygon(60, 0, 10_000);
    const spanLng = (p: LatLng[]) => Math.max(...p.map((x) => x[1])) - Math.min(...p.map((x) => x[1]));
    expect(spanLng(far)).toBeGreaterThan(spanLng(near) * 1.5);
  });

  it("returns the requested vertex count", () => {
    expect(circleToPolygon(49.9, -97.1, 1_000, 12).length).toBe(12);
  });
});

describe("rectToPolygon", () => {
  it("contains the midpoint of the two corners and excludes points beyond them", () => {
    const poly = rectToPolygon(49.87, -97.20, 49.92, -97.08);
    expect(inPoly(49.895, -97.14, poly)).toBe(true);
    expect(inPoly(49.86, -97.14, poly)).toBe(false);
    expect(inPoly(49.895, -97.05, poly)).toBe(false);
  });

  it("is corner-order independent", () => {
    const a = rectToPolygon(49.87, -97.20, 49.92, -97.08);
    const b = rectToPolygon(49.92, -97.08, 49.87, -97.20);
    expect(inPoly(49.895, -97.14, a)).toBe(inPoly(49.895, -97.14, b));
  });
});
