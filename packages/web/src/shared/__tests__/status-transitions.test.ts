import { describe, expect, it } from "bun:test";
import { canTransition, transitionError, NEXT_STATUSES } from "../job-status";
import { DEFAULT_GEOFENCE_RADIUS_M, resolveGeofenceRadiusM } from "../geo-distance";

/**
 * The bug these tests exist for: `POST /bookings/:id/status` accepted ANY
 * status string, so a driver (or a retried request, or a hand-crafted call)
 * could go enroute -> completed. That skips arrival entirely: no transit time
 * is finalised, the customer never gets the "your tech is here" notification,
 * and the job is billed as done from the van. It is also how a completed job
 * could be dragged back to enroute and re-fire the on-my-way SMS.
 */
describe("canTransition", () => {
  it("walks the normal field flow", () => {
    expect(canTransition("confirmed", "assigned")).toBe(true);
    expect(canTransition("assigned", "enroute")).toBe(true);
    expect(canTransition("enroute", "arrived")).toBe(true);
    expect(canTransition("arrived", "in_progress")).toBe(true);
    expect(canTransition("arrived", "completed")).toBe(true);
    expect(canTransition("in_progress", "completed")).toBe(true);
  });

  it("refuses to complete a job the tech never arrived at", () => {
    expect(canTransition("enroute", "completed")).toBe(false);
    expect(canTransition("assigned", "completed")).toBe(false);
    expect(canTransition("confirmed", "completed")).toBe(false);
  });

  it("refuses to reopen a finished or cancelled job", () => {
    expect(canTransition("completed", "enroute")).toBe(false);
    expect(canTransition("completed", "arrived")).toBe(false);
    expect(canTransition("cancelled", "enroute")).toBe(false);
    expect(canTransition("completed", "cancelled")).toBe(false);
  });

  it("never moves a job backwards down the flow", () => {
    expect(canTransition("arrived", "enroute")).toBe(false);
    expect(canTransition("enroute", "assigned")).toBe(false);
    expect(canTransition("in_progress", "arrived")).toBe(false);
  });

  it("treats re-sending the current status as a harmless no-op", () => {
    // A retried request on flaky signal must not 409 the driver.
    for (const s of ["assigned", "enroute", "arrived", "in_progress", "completed"])
      expect(canTransition(s, s)).toBe(true);
  });

  it("lets an active job be cancelled from any live stage", () => {
    for (const s of ["confirmed", "assigned", "enroute", "arrived", "onsite", "in_progress", "paused"])
      expect(canTransition(s, "cancelled")).toBe(true);
  });

  it("accepts onsite and paused as live equivalents of arrived / in_progress", () => {
    expect(canTransition("onsite", "completed")).toBe(true);
    expect(canTransition("paused", "completed")).toBe(true);
    expect(canTransition("onsite", "in_progress")).toBe(true);
  });

  it("rejects statuses that are not part of the flow at all", () => {
    expect(canTransition("enroute", "nonsense")).toBe(false);
    expect(canTransition("nonsense", "enroute")).toBe(false);
    expect(canTransition(undefined, "enroute")).toBe(false);
  });

  it("allows the first assignment out of an empty/pending state", () => {
    expect(canTransition("pending", "confirmed")).toBe(true);
    expect(canTransition("pending", "assigned")).toBe(true);
  });

  it("explains the refusal in words a driver can act on", () => {
    const msg = transitionError("enroute", "completed");
    expect(msg).toBeTruthy();
    expect(msg!.toLowerCase()).toContain("arrive");
    expect(transitionError("arrived", "completed")).toBeNull();
  });

  it("exposes the allowed next statuses for a stage", () => {
    expect(NEXT_STATUSES.enroute).toContain("arrived");
    expect(NEXT_STATUSES.enroute).not.toContain("completed");
  });
});

describe("resolveGeofenceRadiusM", () => {
  it("defaults to the documented radius, matching the DB column default", () => {
    expect(DEFAULT_GEOFENCE_RADIUS_M).toBe(150);
    expect(resolveGeofenceRadiusM(undefined)).toBe(DEFAULT_GEOFENCE_RADIUS_M);
    expect(resolveGeofenceRadiusM(null)).toBe(DEFAULT_GEOFENCE_RADIUS_M);
  });

  it("never lets a junk or zero value silently shrink the radius to nothing", () => {
    // radius 0 => auto-arrive can never fire => the driver waits forever.
    expect(resolveGeofenceRadiusM(0)).toBe(DEFAULT_GEOFENCE_RADIUS_M);
    expect(resolveGeofenceRadiusM(-50)).toBe(DEFAULT_GEOFENCE_RADIUS_M);
    expect(resolveGeofenceRadiusM("nonsense")).toBe(DEFAULT_GEOFENCE_RADIUS_M);
    expect(resolveGeofenceRadiusM(NaN)).toBe(DEFAULT_GEOFENCE_RADIUS_M);
  });

  it("honours a real configured radius", () => {
    expect(resolveGeofenceRadiusM(40)).toBe(40);
    expect(resolveGeofenceRadiusM("75")).toBe(75);
  });

  it("clamps absurd values instead of trusting them", () => {
    // 5m is below consumer GPS accuracy; 5km would auto-arrive across town.
    expect(resolveGeofenceRadiusM(1)).toBe(10);
    expect(resolveGeofenceRadiusM(99999)).toBe(2000);
  });
});
