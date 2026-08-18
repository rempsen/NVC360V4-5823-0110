import { api } from "./api";
import { ok } from "./api-ok";
import { ApiError } from "./api-error";

/**
 * Dispatch a job to a technician, with the one confirmation the dispatcher needs.
 *
 * `POST /bookings/:id/assign` now refuses four cases it used to wave through:
 * a job somebody is actively working (en route / on site / clocked in),
 * re-offering a job to the tech who already accepted it, sending a tech to a job
 * at a time they are already booked, and sending them out on a day they booked
 * off. All four come back 409 with `forceable: true`, because all four are
 * legitimate dispatcher intentions — a van breaks down and the work has to move.
 * Anything else (completed, cancelled, or the job changed underneath us) is a
 * hard no and is left to the global error toast to explain.
 *
 * The confirmation wording follows the reason: the reassign copy talks about
 * clearing drive time and on-site clocks, which is nonsense for "Mike is already
 * booked at 2:00 PM".
 *
 * Returns `{ cancelled: true }` when the dispatcher backs out of the
 * confirmation, so the caller can close quietly instead of showing an error for
 * something the user chose not to do.
 */
export type AssignResult = { cancelled: true } | { cancelled: false };

type ConfirmFn = (opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}) => Promise<boolean>;

export async function assignJob(opts: {
  bookingId: string;
  riderId: string;
  techName?: string;
  confirm: ConfirmFn;
}): Promise<AssignResult> {
  const post = async (force?: boolean) =>
    ok(
      await api.bookings[":id"].assign.$post({
        param: { id: opts.bookingId },
        json: force ? { riderId: opts.riderId, force: true } : { riderId: opts.riderId },
      }),
    );

  try {
    await post();
    return { cancelled: false };
  } catch (e) {
    const body =
      e instanceof ApiError
        ? (e.body as { forceable?: boolean; reason?: string } | undefined)
        : undefined;
    if (!(e instanceof ApiError) || e.status !== 409 || !body?.forceable) throw e;

    const busy = body.reason === "overlap" || body.reason === "timeoff";
    const yes = await opts.confirm({
      title: busy
        ? "Send them anyway?"
        : opts.techName
          ? `Reassign this job to ${opts.techName}?`
          : "Reassign this job?",
      message: busy
        ? `${e.message} You can dispatch them anyway — check they can actually make it.`
        : `${e.message} Their drive time and on-site clock for this visit will be cleared, and the new technician has to accept the job.`,
      confirmLabel: busy ? "Dispatch anyway" : "Reassign",
    });
    if (!yes) return { cancelled: true };

    await post(true);
    return { cancelled: false };
  }
}
