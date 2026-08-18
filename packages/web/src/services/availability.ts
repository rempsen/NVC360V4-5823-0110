/**
 * "Is this tech free then?" — the DB half of shared/availability.ts.
 *
 * Reads the technician's other work and their booked time off and turns a clash
 * into one sentence the dispatcher can act on. The routes return it as a
 * forceable 409, so the office confirms rather than being blocked: overriding is
 * a normal dispatch decision, doing it by accident is not.
 *
 * FAILS OPEN. If this query throws (DB blip, odd data), dispatch continues. A
 * warning that can't be computed must never stop the office from booking work.
 */
import { and, eq, gte, isNull, lte, ne } from "drizzle-orm";
import { db } from "../api/database";
import * as schema from "../api/database/schema";
import { TERMINAL_STATUSES } from "../shared/job-status";
import {
  findOverlappingJob,
  findTimeOff,
  jobMinutes,
  overlapMessage,
  timeOffMessage,
  type JobSlot,
} from "../shared/availability";
import { companyTimeZone } from "./company-tz";

export interface AvailabilityBlock {
  kind: "overlap" | "timeoff";
  message: string;
  /** The job they're already on, when kind is "overlap". */
  clashBookingId?: string;
}

export interface AvailabilityInput {
  riderId: string | null | undefined;
  scheduledAt: number | Date | null | undefined;
  /** The job being moved/assigned, so it doesn't clash with itself. */
  bookingId?: string | null;
  /** Used to size the window; falls back to the service's duration, then an hour. */
  durationMins?: number | null;
  serviceId?: string | null;
}

/** Wide enough to catch a long job either side, narrow enough to stay an index seek. */
const WINDOW_MS = 25 * 60 * 60 * 1000;

async function serviceMinutes(companyId: string, serviceId?: string | null): Promise<number | null> {
  if (!serviceId) return null;
  const [svc] = await db
    .select({ durationMins: schema.services.durationMins })
    .from(schema.services)
    .where(and(eq(schema.services.companyId, companyId), eq(schema.services.id, serviceId)))
    .limit(1);
  return svc?.durationMins ?? null;
}

async function techLabel(companyId: string, riderId: string): Promise<string> {
  const [row] = await db
    .select({ name: schema.user.name })
    .from(schema.riders)
    .innerJoin(schema.user, eq(schema.user.id, schema.riders.userId))
    .where(and(eq(schema.riders.companyId, companyId), eq(schema.riders.id, riderId)))
    .limit(1);
  return (row?.name ?? "").trim();
}

async function workerNoun(companyId: string): Promise<string> {
  const [row] = await db
    .select({ noun: schema.companySettings.workerNoun })
    .from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, companyId))
    .limit(1);
  return (row?.noun || "technician").toLowerCase();
}

export async function findAvailabilityBlock(
  companyId: string,
  input: AvailabilityInput,
): Promise<AvailabilityBlock | null> {
  const riderId = input.riderId;
  const startRaw = input.scheduledAt;
  if (!riderId || startRaw == null) return null;
  const start = startRaw instanceof Date ? startRaw.getTime() : Number(startRaw);
  if (!Number.isFinite(start)) return null;

  try {
    const tz = await companyTimeZone(companyId);
    const durationMins = jobMinutes(input.durationMins ?? (await serviceMinutes(companyId, input.serviceId)));

    // The tech's other live work anywhere near this time. Archived (soft-deleted),
    // completed and cancelled jobs are not clashes.
    const rows = await db
      .select({
        id: schema.bookings.id,
        riderId: schema.bookings.riderId,
        scheduledAt: schema.bookings.scheduledAt,
        status: schema.bookings.status,
        title: schema.bookings.title,
        durationMins: schema.services.durationMins,
      })
      .from(schema.bookings)
      .leftJoin(schema.services, eq(schema.services.id, schema.bookings.serviceId))
      .where(
        and(
          eq(schema.bookings.companyId, companyId),
          eq(schema.bookings.riderId, riderId),
          isNull(schema.bookings.deletedAt),
          gte(schema.bookings.scheduledAt, new Date(start - WINDOW_MS)),
          lte(schema.bookings.scheduledAt, new Date(start + WINDOW_MS)),
          ...TERMINAL_STATUSES.map((s) => ne(schema.bookings.status, s)),
        ),
      );

    const others: JobSlot[] = rows.map((r) => ({
      id: r.id,
      riderId: r.riderId,
      scheduledAt: r.scheduledAt ? new Date(r.scheduledAt).getTime() : null,
      durationMins: r.durationMins,
      status: r.status,
      title: r.title,
    }));

    const clash = findOverlappingJob(
      { id: input.bookingId ?? null, riderId, scheduledAt: start, durationMins },
      others,
    );
    if (clash) {
      const [name, noun] = await Promise.all([techLabel(companyId, riderId), workerNoun(companyId)]);
      return {
        kind: "overlap",
        message: overlapMessage(name, clash, tz, noun),
        clashBookingId: clash.id,
      };
    }

    const shiftRows = await db
      .select()
      .from(schema.techShifts)
      .where(
        and(
          eq(schema.techShifts.companyId, companyId),
          eq(schema.techShifts.riderId, riderId),
          eq(schema.techShifts.kind, "timeoff"),
          // A day either side covers every zone offset.
          gte(schema.techShifts.date, new Date(start - 48 * 60 * 60 * 1000)),
          lte(schema.techShifts.date, new Date(start + 48 * 60 * 60 * 1000)),
        ),
      );

    const off = findTimeOff(
      { riderId, scheduledAt: start },
      shiftRows.map((s) => ({
        id: s.id,
        riderId: s.riderId,
        kind: s.kind,
        date: s.date ? new Date(s.date).getTime() : 0,
        startMin: s.startMin,
        endMin: s.endMin,
        note: s.note,
      })),
      tz,
    );
    if (off) {
      const [name, noun] = await Promise.all([techLabel(companyId, riderId), workerNoun(companyId)]);
      return { kind: "timeoff", message: timeOffMessage(name, off, noun) };
    }

    return null;
  } catch {
    return null;
  }
}
