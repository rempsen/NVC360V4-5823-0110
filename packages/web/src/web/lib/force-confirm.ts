import { ApiError } from "./api-error";

/**
 * "Are you sure?" for a refusal the office is allowed to override.
 *
 * The scheduling routes (assign, drag-to-reschedule, create, edit) now refuse to
 * put a technician in two places at once, or to send them out on a day they
 * booked off. Those refusals come back 409 with `forceable: true` and a plain
 * message, because overriding them is a normal dispatch decision — doing it
 * without noticing is not.
 *
 * `run(force)` is called once; if the server pushes back with a forceable 409 the
 * dispatcher is asked, and it is called again with `force: true`. Returns null
 * when they back out, so callers can close quietly instead of showing an error
 * for something the user chose not to do.
 */
export type ConfirmFn = (opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}) => Promise<boolean>;

export async function runWithForceConfirm<T>(
  run: (force: boolean) => Promise<T>,
  confirm: ConfirmFn,
  copy: { title?: string; confirmLabel?: string } = {},
): Promise<T | null> {
  try {
    return await run(false);
  } catch (e) {
    const body =
      e instanceof ApiError
        ? (e.body as { forceable?: boolean; reason?: string } | undefined)
        : undefined;
    if (!(e instanceof ApiError) || e.status !== 409 || !body?.forceable) throw e;

    const yes = await confirm({
      title: copy.title ?? "Do it anyway?",
      message: `${e.message} You can go ahead anyway — check the schedule works.`,
      confirmLabel: copy.confirmLabel ?? "Continue anyway",
    });
    if (!yes) return null;
    return await run(true);
  }
}

/**
 * A forceable 409 from a plain `fetch`-style call site (the work-order modal
 * reads `res.ok` itself rather than going through the throwing client), so the
 * "ask, then repeat with force" branch can be told apart from a real failure.
 */
export class BusyError extends Error {
  constructor(message: string) {
    super(message || "That time is already taken.");
    this.name = "BusyError";
  }
}
