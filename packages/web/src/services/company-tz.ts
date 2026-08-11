/**
 * The active tenant's time zone, for server-side local-time decisions.
 *
 * Cached briefly: quiet-hours checks run once per notification per channel, and
 * the today-stats endpoint is polled by every technician's phone, so this would
 * otherwise be a settings read on a hot path. A tenant changing their time zone
 * takes effect within a minute.
 */
import { eq } from "drizzle-orm";
import { db } from "../api/database";
import * as schema from "../api/database/schema";
import { DEFAULT_TZ, safeTimeZone } from "../shared/tz";

const TTL_MS = 60_000;
const cache = new Map<string, { tz: string; at: number }>();

export async function companyTimeZone(companyId: string): Promise<string> {
  if (!companyId) return DEFAULT_TZ;
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tz;

  let tz = DEFAULT_TZ;
  try {
    const [row] = await db
      .select({ timezone: schema.companySettings.timezone })
      .from(schema.companySettings)
      .where(eq(schema.companySettings.companyId, companyId))
      .limit(1);
    tz = safeTimeZone(row?.timezone);
  } catch {
    // Settings unreadable (missing row, DB blip) — never fail the caller over
    // a display concern.
    tz = DEFAULT_TZ;
  }
  cache.set(companyId, { tz, at: Date.now() });
  return tz;
}

/** Test/admin escape hatch: forget cached zones. */
export function clearCompanyTimeZoneCache(): void {
  cache.clear();
}
