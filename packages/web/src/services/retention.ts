/**
 * Data retention sweeps. Keeps high-write tables bounded.
 *
 * tracking_pings is the heaviest table — raw GPS history is only useful for a
 * short window (live tracking + mileage reconciliation). We keep recent pings
 * and purge older ones. Mileage totals are already persisted on the booking,
 * so purging history is lossless for billing.
 *
 * EXCEPTION: pings belonging to a COMPLETED booking are never purged by this
 * sweep — the completed-job report page draws the driver's actual route from
 * this raw history, and that has to stay available indefinitely, not just for
 * the retention window. Non-completed bookings (still open, or cancelled)
 * still purge on the normal schedule.
 *
 * NOTE: this runs in-process today (single node). When moving to multi-node,
 * this should run from ONE worker (or a DB-level scheduled job / cron) to avoid
 * every replica issuing the same DELETE.
 */
import { db } from "../api/database";
import { sql } from "drizzle-orm";
import { log, captureException } from "../api/lib/logger";

const PING_RETENTION_DAYS = Number(process.env.PING_RETENTION_DAYS ?? 7);

/** Delete tracking pings older than the retention window (in batches),
 *  skipping any ping whose booking has status = 'completed'. */
export async function purgeOldPings(): Promise<number> {
  const cutoff = Date.now() - PING_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    // batch-delete to avoid long write locks on Turso
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const res = await db.run(
        sql`DELETE FROM tracking_pings WHERE id IN (
          SELECT tp.id FROM tracking_pings tp
          LEFT JOIN bookings b ON b.id = tp.booking_id
          WHERE tp.created_at < ${cutoff}
            AND (b.status IS NULL OR b.status != 'completed')
          LIMIT 5000
        )`,
      );
      const n = Number((res as any)?.rowsAffected ?? 0);
      total += n;
      if (n < 5000) break;
    }
    if (total > 0) log.info("retention: purged tracking pings", { total, cutoff });
    return total;
  } catch (e) {
    captureException(e, { job: "purgeOldPings" });
    return 0;
  }
}

/** Expire idempotency keys older than 24h (replay protection window). */
export async function purgeOldIdempotencyKeys(): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    await db.run(sql`DELETE FROM idempotency_keys WHERE created_at < ${cutoff}`);
  } catch (e) {
    captureException(e, { job: "purgeOldIdempotencyKeys" });
  }
}

let started = false;
/** Start periodic retention sweeps. Idempotent. */
export function startRetentionSweeps() {
  if (started) return;
  started = true;
  const run = () => {
    void purgeOldPings();
    void purgeOldIdempotencyKeys();
  };
  // first sweep shortly after boot, then every 6h
  setTimeout(run, 30_000).unref?.();
  setInterval(run, 6 * 60 * 60 * 1000).unref?.();
  log.info("retention sweeps scheduled", { pingRetentionDays: PING_RETENTION_DAYS });
}
