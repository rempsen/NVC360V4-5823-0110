/**
 * Tenant time zones.
 *
 * company_settings.timezone was editable and unread: every server-side
 * local-time decision used the process time zone, and the server runs UTC.
 * These tests pin the three behaviours that were wrong, using the real
 * Winnipeg offsets (CDT = UTC-5 in August, CST = UTC-6 in January) so a
 * regression to `getHours()` / `setHours()` fails here.
 */
import { describe, it, expect } from "bun:test";
import {
  DEFAULT_TZ,
  isValidTimeZone,
  safeTimeZone,
  zonedDayBounds,
  zonedDayKey,
  zonedMinutesOfDay,
  zonedTimeToInstant,
  namedDayBounds,
  zoneOffsetMs,
} from "../tz";

const WPG = "America/Winnipeg";

describe("time zone plumbing", () => {
  it("the process itself is UTC — which is why none of this could be left implicit", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
  });

  it("rejects nonsense zones instead of throwing", () => {
    expect(isValidTimeZone(WPG)).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(safeTimeZone("Mars/Olympus_Mons")).toBe(DEFAULT_TZ);
    expect(safeTimeZone(null)).toBe(DEFAULT_TZ);
    expect(safeTimeZone(WPG)).toBe(WPG);
  });

  it("tracks DST: Winnipeg is UTC-5 in August and UTC-6 in January", () => {
    expect(zoneOffsetMs(new Date("2026-08-11T18:00:00Z"), WPG)).toBe(-5 * 3_600_000);
    expect(zoneOffsetMs(new Date("2026-01-11T18:00:00Z"), WPG)).toBe(-6 * 3_600_000);
  });

  it("round-trips a local wall clock to an instant and back", () => {
    const inst = zonedTimeToInstant(WPG, 2026, 8, 11, 9, 30);
    expect(inst.toISOString()).toBe("2026-08-11T14:30:00.000Z");
    expect(zonedMinutesOfDay(inst, WPG)).toBe(9 * 60 + 30);
    expect(zonedDayKey(inst, WPG)).toBe("2026-08-11");
  });
});

describe("quiet hours are the tenant's local hours", () => {
  // Configured 21:00 -> 08:00. In a UTC process, `new Date().getHours()` made
  // this suppress 16:00-02:00 LOCAL: no customer SMS all afternoon.
  const start = 21 * 60;
  const end = 8 * 60;
  const inQuiet = (cur: number) => (start <= end ? cur >= start && cur < end : cur >= start || cur < end);

  const at = (h: number, m = 0) => zonedTimeToInstant(WPG, 2026, 8, 11, h, m);

  it("16:00 local is NOT quiet (the old code silenced it)", () => {
    const now = at(16);
    expect(now.getUTCHours()).toBe(21); // what the old getHours() saw
    expect(inQuiet(zonedMinutesOfDay(now, WPG))).toBe(false);
  });

  it("22:00 local IS quiet", () => {
    expect(inQuiet(zonedMinutesOfDay(at(22), WPG))).toBe(true);
  });

  it("03:00 local IS quiet (the old code sent at 3 AM)", () => {
    const now = at(3);
    expect(now.getUTCHours()).toBe(8); // old code: exactly the end of the window
    expect(inQuiet(zonedMinutesOfDay(now, WPG))).toBe(true);
  });

  it("09:00 local is NOT quiet", () => {
    expect(inQuiet(zonedMinutesOfDay(at(9), WPG))).toBe(false);
  });
});

describe("a technician's 'today' is the tenant's local day", () => {
  it("at 20:00 local, the window still covers this morning", () => {
    const now = zonedTimeToInstant(WPG, 2026, 8, 11, 20, 0);
    const { start, end } = zonedDayBounds(now, WPG);
    expect(start.toISOString()).toBe("2026-08-11T05:00:00.000Z"); // 00:00 local
    expect(end.toISOString()).toBe("2026-08-12T04:59:59.999Z"); // 23:59:59.999 local

    const thisMorning = zonedTimeToInstant(WPG, 2026, 8, 11, 8, 0);
    const thisEvening = zonedTimeToInstant(WPG, 2026, 8, 11, 20, 30);

    // The old UTC window (00:00Z Aug 12 -> 23:59Z Aug 12) dropped the morning
    // job and kept the evening one, so the tech's earnings reset at 19:00.
    expect(thisMorning >= start && thisMorning <= end).toBe(true);
    expect(thisEvening >= start && thisEvening <= end).toBe(true);

    const yesterdayEvening = zonedTimeToInstant(WPG, 2026, 8, 10, 20, 0);
    const tomorrowMorning = zonedTimeToInstant(WPG, 2026, 8, 12, 8, 0);
    expect(yesterdayEvening >= start && yesterdayEvening <= end).toBe(false);
    expect(tomorrowMorning >= start && tomorrowMorning <= end).toBe(false);
  });

  it("the local day is 24h across a DST spring-forward (23h) and fall-back (25h)", () => {
    const spring = zonedDayBounds(zonedTimeToInstant(WPG, 2026, 3, 8, 12), WPG);
    const fall = zonedDayBounds(zonedTimeToInstant(WPG, 2026, 11, 1, 12), WPG);
    const hours = (b: { start: Date; end: Date }) => (b.end.getTime() + 1 - b.start.getTime()) / 3_600_000;
    expect(hours(spring)).toBe(23);
    expect(hours(fall)).toBe(25);
  });
});

describe("report day buckets and ranges use the tenant's calendar", () => {
  it("a job at 21:00 local Aug 11 belongs to Aug 11, not Aug 12", () => {
    const completed = zonedTimeToInstant(WPG, 2026, 8, 11, 21, 0);
    expect(completed.toISOString()).toBe("2026-08-12T02:00:00.000Z");
    expect(zonedDayKey(completed, WPG)).toBe("2026-08-11");
  });

  it("a date picked as 'YYYY-MM-DD' means that local day, not UTC midnight", () => {
    const { start, end } = namedDayBounds("2026-08-01", WPG);
    expect(start.toISOString()).toBe("2026-08-01T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-02T04:59:59.999Z");
    // The old code took new Date("2026-08-01") = 00:00Z, i.e. 19:00 Jul 31
    // local, and ran the range from there.
    expect(zonedDayKey(start, WPG)).toBe("2026-08-01");
  });

  it("an unparseable range falls back to today rather than producing NaN bounds", () => {
    const { start, end } = namedDayBounds("not a date", WPG);
    expect(Number.isNaN(start.getTime())).toBe(false);
    expect(Number.isNaN(end.getTime())).toBe(false);
    expect(end > start).toBe(true);
  });
});
