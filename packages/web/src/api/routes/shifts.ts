/**
 * Technician shifts and time off.
 *
 * This router used to read `await c.req.json()` and write it straight to the
 * table: an unparseable date became a stored Invalid Date, `startMin`/`endMin`
 * took any value (a string, -60, 5000, or an end before the start), a stale
 * `riderId` hit the foreign key as a bare 500, and PUT/DELETE answered 200 for
 * ids that don't exist.
 *
 * It also stored the wrong DAY. The picker sends "2026-09-15"; `new Date()` reads
 * that as UTC midnight, which for every North American tenant is the previous
 * local day — so time off booked for Tuesday was stored, listed and (now that
 * dispatch enforces it) applied as Monday. The day is resolved on the COMPANY's
 * clock via `namedDayBounds`, the same way report day buckets are.
 */
import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../database/schema";
import { eq, and, gte, lte } from "drizzle-orm";
import { requireAuth, requireAdmin, tx, tenantId } from "../middleware/auth";
import { jsonBody, id as idField, longText } from "../lib/validate";
import { companyTimeZone } from "../../services/company-tz";
import { namedDayBounds } from "../../shared/tz";
import type { AppEnv } from "../env";

const MINUTES_IN_DAY = 24 * 60;

/** A day the office named ("2026-09-15") or a timestamp from an older client. */
const dayField = z
  .union([
    z.string().trim().min(1, "Pick a date"),
    z.number().finite("Pick a date"),
  ])
  .refine(
    (v) => (typeof v === "number" ? Number.isFinite(v) : !Number.isNaN(new Date(v).getTime())),
    "That date could not be read",
  );

const minuteField = (label: string) =>
  z
    .number({ message: `${label} must be a time` })
    .int(`${label} must be a whole number of minutes`)
    .min(0, `${label} must be within the day`)
    .max(MINUTES_IN_DAY, `${label} must be within the day`);

const kindField = z.enum(["shift", "timeoff"], { message: "Kind must be shift or timeoff" });

const ShiftCreate = z
  .object({
    riderId: idField("Technician"),
    kind: kindField.optional(),
    date: dayField,
    startMin: minuteField("Start").optional(),
    endMin: minuteField("End").optional(),
    note: longText(500).optional(),
  })
  .refine((v) => (v.startMin ?? 540) < (v.endMin ?? 1020), {
    message: "The end time has to be after the start time",
    path: ["endMin"],
  });

const ShiftPatch = z
  .object({
    kind: kindField,
    date: dayField,
    startMin: minuteField("Start"),
    endMin: minuteField("End"),
    note: longText(500),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

/** Start of the named day on the company's clock. */
async function dayStart(companyId: string, date: string | number): Promise<Date> {
  const tz = await companyTimeZone(companyId);
  return namedDayBounds(typeof date === "number" ? new Date(date) : date, tz).start;
}

export const shiftsRoutes = new Hono<AppEnv>()
  // list shifts/time-off, optional ?riderId & ?from & ?to (ms)
  .get("/", requireAuth, async (c) => {
    const riderId = c.req.query("riderId");
    const from = Number(c.req.query("from"));
    const to = Number(c.req.query("to"));
    const conds = [];
    if (riderId) conds.push(eq(schema.techShifts.riderId, riderId));
    // A non-numeric ?from used to become `new Date(NaN)` in the WHERE clause,
    // which matches nothing — an empty calendar with no error.
    if (Number.isFinite(from)) conds.push(gte(schema.techShifts.date, new Date(from)));
    if (Number.isFinite(to)) conds.push(lte(schema.techShifts.date, new Date(to)));
    const rows = await tx(c).select(
      schema.techShifts,
      conds.length ? and(...conds) : undefined,
    );
    return c.json({ shifts: rows }, 200);
  })
  .post("/", requireAdmin, jsonBody(ShiftCreate), async (c) => {
    const co = tenantId(c);
    const b = c.req.valid("json");
    const t = tx(c);
    // Resolve the tech inside this tenant: a stale id was a 500 on the FK, and an
    // id from another company was accepted outright.
    const rider = await t.selectOne(schema.riders, eq(schema.riders.id, b.riderId));
    if (!rider) return c.json({ message: "Technician not found" }, 404);
    const [shift] = await t.insert(schema.techShifts, {
      riderId: b.riderId,
      kind: b.kind || "shift",
      date: await dayStart(co, b.date),
      startMin: b.startMin ?? 540,
      endMin: b.endMin ?? 1020,
      note: b.note ?? "",
    });
    return c.json({ shift }, 201);
  })
  .put("/:id", requireAdmin, jsonBody(ShiftPatch), async (c) => {
    const co = tenantId(c);
    const id = c.req.param("id");
    const b = c.req.valid("json");
    const t = tx(c);
    const prev = await t.selectOne(schema.techShifts, eq(schema.techShifts.id, id));
    if (!prev) return c.json({ message: "Not found" }, 404);

    // Validate the RESULT, not just the fields sent: moving only the start time
    // could still leave the shift ending before it begins.
    const startMin = b.startMin ?? prev.startMin;
    const endMin = b.endMin ?? prev.endMin;
    if (startMin >= endMin)
      return c.json({ message: "The end time has to be after the start time" }, 400);

    const patch: Record<string, unknown> = {};
    if (b.kind !== undefined) patch.kind = b.kind;
    if (b.note !== undefined) patch.note = b.note;
    if (b.startMin !== undefined) patch.startMin = b.startMin;
    if (b.endMin !== undefined) patch.endMin = b.endMin;
    if (b.date !== undefined) patch.date = await dayStart(co, b.date);

    const [shift] = await t.update(
      schema.techShifts,
      patch as Partial<typeof schema.techShifts.$inferInsert>,
      eq(schema.techShifts.id, id),
    );
    return c.json({ shift }, 200);
  })
  .delete("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const t = tx(c);
    const prev = await t.selectOne(schema.techShifts, eq(schema.techShifts.id, id));
    if (!prev) return c.json({ message: "Not found" }, 404);
    await t.delete(schema.techShifts, eq(schema.techShifts.id, id));
    return c.json({ ok: true }, 200);
  });
