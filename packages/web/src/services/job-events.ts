/**
 * Job event log — the append-only narrative of a work order.
 *
 * Every call is fire-and-forget safe: logging a timeline entry must never be
 * able to fail the operation that produced it. Callers can `await` this, but a
 * throw inside is swallowed and logged.
 *
 * customerVisible is the gate for what the homeowner sees on /t/:token. The
 * defaults below encode that policy in one place so individual call sites can't
 * accidentally leak internal activity (declines, staff notes, pricing) to the
 * client. Pass an explicit `customerVisible` to override.
 */
import { db } from "../api/database";
import * as schema from "../api/database/schema";
import { eq, and, asc } from "drizzle-orm";

export type JobEventKind =
  // lifecycle (mirrors dispatch.ts NvcEvent)
  | "created"
  | "assigned"
  | "accepted"
  | "declined"
  | "enroute"
  | "arrived"
  | "started"
  | "completed"
  | "cancelled"
  // activity
  | "photo_added"
  | "signature_captured"
  | "note_added"
  | "checklist_completed"
  | "message"
  | "review_submitted";

/**
 * Timeline policy. `visible` = shown to the customer on the public page.
 * `label` is the default human string; call sites can override it with
 * something more specific (e.g. the actual checklist step name).
 */
const EVENT_POLICY: Record<JobEventKind, { visible: boolean; label: string }> = {
  created: { visible: true, label: "Service request received" },
  assigned: { visible: true, label: "Technician assigned" },
  // internal: the customer should never see that someone turned their job down
  accepted: { visible: false, label: "Technician accepted the job" },
  declined: { visible: false, label: "Technician declined the job" },
  enroute: { visible: true, label: "Technician on the way" },
  arrived: { visible: true, label: "Technician arrived on site" },
  started: { visible: true, label: "Work started" },
  completed: { visible: true, label: "Work completed" },
  cancelled: { visible: true, label: "Appointment cancelled" },
  photo_added: { visible: true, label: "Photo added" },
  signature_captured: { visible: true, label: "Sign-off captured" },
  // field notes are written for the office, not the client
  note_added: { visible: false, label: "Note added" },
  checklist_completed: { visible: true, label: "Checklist step completed" },
  message: { visible: false, label: "Message sent" },
  review_submitted: { visible: false, label: "Review submitted" },
};

export async function logJobEvent(opts: {
  companyId: string;
  bookingId: string;
  kind: JobEventKind;
  actorRole?: "system" | "dispatch" | "tech" | "client";
  actorName?: string;
  label?: string;
  detail?: string;
  meta?: Record<string, unknown>;
  /** Override the default visibility policy for this kind. */
  customerVisible?: boolean;
}): Promise<void> {
  try {
    const policy = EVENT_POLICY[opts.kind] ?? { visible: false, label: opts.kind };
    await db.insert(schema.jobEvents).values({
      companyId: opts.companyId,
      bookingId: opts.bookingId,
      kind: opts.kind,
      actorRole: opts.actorRole ?? "system",
      actorName: opts.actorName ?? "",
      label: opts.label || policy.label,
      detail: opts.detail ?? "",
      meta: JSON.stringify(opts.meta ?? {}),
      customerVisible: opts.customerVisible ?? policy.visible,
    });
  } catch (e) {
    console.error("[job-events] log failed", opts.kind, opts.bookingId, e);
  }
}

/** Whether a given event kind is customer-facing by default. */
export function isCustomerVisible(kind: JobEventKind): boolean {
  return EVENT_POLICY[kind]?.visible ?? false;
}

/** Full timeline for a job, oldest first. `onlyCustomerVisible` for public pages. */
export async function jobTimeline(
  bookingId: string,
  opts: { onlyCustomerVisible?: boolean } = {},
) {
  const where = opts.onlyCustomerVisible
    ? and(
        eq(schema.jobEvents.bookingId, bookingId),
        eq(schema.jobEvents.customerVisible, true),
      )
    : eq(schema.jobEvents.bookingId, bookingId);

  const rows = await db
    .select()
    .from(schema.jobEvents)
    .where(where)
    .orderBy(asc(schema.jobEvents.createdAt));

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    actorRole: r.actorRole,
    actorName: r.actorName,
    label: r.label,
    detail: r.detail,
    meta: (() => {
      try {
        return JSON.parse(r.meta || "{}");
      } catch {
        return {};
      }
    })(),
    at: r.createdAt,
  }));
}
