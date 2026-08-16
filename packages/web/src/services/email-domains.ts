/**
 * Multi-tenant outgoing-email domain management on a single shared Resend
 * account. Tenants submit a domain; a superadmin approves it (which creates it
 * in Resend and stores the DNS records); the tenant adds those records; an
 * auto-poller (server.ts) re-checks until Resend reports it verified.
 *
 * A tenant's `emailFromAddress` is only honored once its domain row is
 * `status === "verified"` — see services/email.ts + dispatch.ts send guard.
 */
import { Resend } from "resend";
import { db } from "../api/database";
import * as schema from "../api/database/schema";
import { eq } from "drizzle-orm";

const apiKey = process.env.RESEND_API_KEY;
const resend = apiKey ? new Resend(apiKey) : null;

export interface DnsRecord {
  record: string; // e.g. "SPF" | "DKIM" | "MX" | "DMARC"
  name: string;
  type: string; // "TXT" | "MX" | "CNAME"
  value: string;
  priority?: number;
  ttl?: string | number;
  status?: string; // resend per-record status
}

/** Normalize Resend's record objects into our stable shape. */
function normalizeRecords(records: any[] | undefined | null): DnsRecord[] {
  if (!Array.isArray(records)) return [];
  return records.map((r) => ({
    record: r.record ?? r.type ?? "",
    name: r.name ?? "",
    type: r.type ?? "",
    value: r.value ?? "",
    ...(r.priority != null ? { priority: r.priority } : {}),
    ...(r.ttl != null ? { ttl: r.ttl } : {}),
    ...(r.status ? { status: r.status } : {}),
  }));
}

/** Map Resend's domain status to our row status. */
function mapStatus(resendStatus: string | undefined): string {
  switch ((resendStatus || "").toLowerCase()) {
    case "verified":
      return "verified";
    case "failure":
    case "failed":
      return "failed";
    // not_started / pending / verifying / temporary_failure all mean
    // "DNS not yet confirmed" — keep showing as verifying until Resend says
    // verified or it hard-fails.
    case "not_started":
    case "pending":
    case "verifying":
    case "temporary_failure":
    default:
      return "verifying";
  }
}

export function resendAvailable() {
  return !!resend;
}

/**
 * Create the domain in Resend and persist the returned id + DNS records onto an
 * existing tenant_email_domains row. Called by the superadmin approve flow.
 */
export async function createDomainInResend(rowId: string) {
  if (!resend) throw new Error("RESEND_API_KEY not configured");
  const [row] = await db
    .select()
    .from(schema.tenantEmailDomains)
    .where(eq(schema.tenantEmailDomains.id, rowId))
    .limit(1);
  if (!row) throw new Error("domain row not found");
  if (row.resendDomainId) {
    // Already created — just resync.
    return syncStatus(rowId);
  }
  let domainId: string | undefined;
  let domainData: any;
  const { data, error } = await resend.domains.create({
    name: row.domain,
    region: (row.region as any) || "us-east-1",
  });
  if (error) {
    // Already registered on this Resend account (e.g. a prior attempt) —
    // adopt the existing domain instead of failing.
    if (/already/i.test(error.message || "")) {
      const list = await resend.domains.list();
      const match = (list.data as any)?.data?.find(
        (d: any) => (d.name || "").toLowerCase() === row.domain.toLowerCase(),
      );
      if (!match) throw new Error(error.message || "resend create failed");
      // Fetch full record set for the existing domain.
      const got = await resend.domains.get(match.id);
      domainId = match.id;
      domainData = got.data || match;
    } else {
      throw new Error(error.message || "resend create failed");
    }
  } else {
    domainId = data!.id;
    domainData = data;
  }
  const records = normalizeRecords(domainData?.records);
  const [updated] = await db
    .update(schema.tenantEmailDomains)
    .set({
      resendDomainId: domainId!,
      status: mapStatus(domainData?.status),
      records: JSON.stringify(records),
      lastCheckedAt: new Date(),
    })
    .where(eq(schema.tenantEmailDomains.id, rowId))
    .returning();
  return updated;
}

/**
 * Fetch current state from Resend for a row's resendDomainId and persist it.
 * Returns the updated row (or the existing row if no resendDomainId yet).
 */
export async function syncStatus(rowId: string) {
  if (!resend) throw new Error("RESEND_API_KEY not configured");
  const [row] = await db
    .select()
    .from(schema.tenantEmailDomains)
    .where(eq(schema.tenantEmailDomains.id, rowId))
    .limit(1);
  if (!row) throw new Error("domain row not found");
  if (!row.resendDomainId) return row;
  const { data, error } = await resend.domains.get(row.resendDomainId);
  if (error) {
    await db
      .update(schema.tenantEmailDomains)
      .set({ lastCheckedAt: new Date() })
      .where(eq(schema.tenantEmailDomains.id, rowId));
    return row;
  }
  const records = normalizeRecords((data as any)?.records);
  const nextStatus = mapStatus((data as any)?.status);
  if (row.status === "verified" && nextStatus !== "verified") {
    // A working sending domain just stopped working. Every email for this
    // tenant is now failing its first send, so this must not be silent.
    console.error(
      `[email-domain] ${row.domain} (company ${row.companyId}) regressed verified -> ${nextStatus}. ` +
        `Outbound mail for this tenant is falling back to the platform sender until DNS is fixed.`,
    );
  }
  const [updated] = await db
    .update(schema.tenantEmailDomains)
    .set({
      status: nextStatus,
      ...(records.length ? { records: JSON.stringify(records) } : {}),
      lastCheckedAt: new Date(),
    })
    .where(eq(schema.tenantEmailDomains.id, rowId))
    .returning();
  return updated;
}

/**
 * Ask Resend to (re)trigger verification, then sync status. Tenant "Check
 * verification" button + poller both call this.
 *
 * IMPORTANT: Resend's verify() endpoint re-triggers a fresh DNS re-check even
 * on an ALREADY-verified domain — which flips its status to "pending" for
 * several seconds while it re-validates, before settling back to "verified".
 * Since we poll every 2 minutes (and the button can be clicked any time), if
 * we called verify() unconditionally we'd keep re-arming that reset window
 * and could catch the domain mid-reset ("pending") right after it had
 * genuinely finished verifying — so a truly-verified domain could get stuck
 * oscillating and never visibly settle in our UI. Fix: check current status
 * first (a plain, side-effect-free get()); only call verify() to nudge a
 * re-check when the domain isn't already verified.
 */
export async function triggerVerify(rowId: string) {
  if (!resend) throw new Error("RESEND_API_KEY not configured");
  const [row] = await db
    .select()
    .from(schema.tenantEmailDomains)
    .where(eq(schema.tenantEmailDomains.id, rowId))
    .limit(1);
  if (!row) throw new Error("domain row not found");
  if (!row.resendDomainId) return row; // not approved yet

  // Pure read first — no side effects, safe to call as often as we like.
  const current = await syncStatus(rowId);
  if (current?.status === "verified") return current;

  // Not verified yet — ask Resend to (re)check DNS, then read the fresh result.
  await resend.domains.verify(row.resendDomainId).catch(() => {});
  return syncStatus(rowId);
}

/** Delete the domain in Resend (best-effort) and remove the DB row. */
export async function removeDomain(rowId: string) {
  const [row] = await db
    .select()
    .from(schema.tenantEmailDomains)
    .where(eq(schema.tenantEmailDomains.id, rowId))
    .limit(1);
  if (!row) return;
  if (resend && row.resendDomainId) {
    await resend.domains.remove(row.resendDomainId).catch(() => {});
  }
  await db.delete(schema.tenantEmailDomains).where(eq(schema.tenantEmailDomains.id, rowId));
}

/**
 * Resolve the verified sending domain for a company, if any. Used by the send
 * guard to decide whether a tenant's custom from-address may be honored.
 */
export async function verifiedDomainsForCompany(companyId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(schema.tenantEmailDomains)
    .where(eq(schema.tenantEmailDomains.companyId, companyId));
  return rows.filter((r) => r.status === "verified").map((r) => r.domain.toLowerCase());
}

/**
 * How stale a settled (verified/failed) domain may get before we look again.
 *
 * A domain is not verified once and forever: DNS drifts, a record gets edited
 * or overwritten, a registrar migration drops a TXT. Found live — nvc360.com
 * sat in our table as "verified" for six weeks while Resend had already
 * flipped it to "failed", because we only ever polled unsettled rows. Every
 * email from that tenant was failing its first send and nobody was told.
 */
export const RECHECK_MS = 6 * 60 * 60 * 1000; // 6 hours

type PollRow = { status?: string | null; lastCheckedAt?: Date | number | null };

/** Should this row be re-checked against Resend right now? */
export function needsPoll(row: PollRow, now: number = Date.now()): boolean {
  const status = (row.status || "").toLowerCase();

  // Still waiting on the tenant's DNS — check on every tick, this is the
  // window where they are sitting in the UI clicking "Check verification".
  if (status === "pending" || status === "verifying") return true;

  // Settled either way: re-check slowly. "failed" is included so a tenant who
  // quietly fixes their DNS recovers without anyone pressing a button.
  if (status !== "verified" && status !== "failed") return false;

  const last = row.lastCheckedAt instanceof Date ? row.lastCheckedAt.getTime() : row.lastCheckedAt;
  if (last == null || !Number.isFinite(last)) return true; // never checked
  return now - Number(last) >= RECHECK_MS;
}

/** All rows due for a status check — unsettled every tick, settled every RECHECK_MS. */
export async function rowsNeedingPoll() {
  const rows = await db.select().from(schema.tenantEmailDomains);
  const now = Date.now();
  return rows.filter((r) => needsPoll(r, now));
}
