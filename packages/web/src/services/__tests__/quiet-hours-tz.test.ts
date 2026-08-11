/**
 * Quiet hours, end to end through the real channelAllowed().
 *
 * The helper maths is covered in shared/__tests__/tz.test.ts; this pins the
 * WIRING: channelAllowed() must read the tenant's company_settings.timezone
 * (which nothing read before) instead of the server's process time zone.
 *
 * Two tenants, same configured window (21:00-08:00 local), different zones —
 * at one single instant one is quiet and the other is not. That can only pass
 * if the tenant's own zone is consulted.
 *
 * Harness: ephemeral in-memory libsql, ids prefixed "qh-".
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";

process.env.DATABASE_URL = ":memory:";
process.env.DATABASE_AUTH_TOKEN = "";

const { db } = await import("../../api/database/index");
const schema = await import("../../api/database/schema");
const { channelAllowed } = await import("../dispatch");
const { clearCompanyTimeZoneCache } = await import("../company-tz");
const { zonedTimeToInstant } = await import("../../shared/tz");

const WPG_CO = "qh-winnipeg-co"; // America/Winnipeg, UTC-5 in August
const SYD_CO = "qh-sydney-co"; // Australia/Sydney, UTC+10 in August
const BAD_CO = "qh-badzone-co"; // unusable timezone string

function ddlFor(table: any): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((col: SQLiteColumn) => {
    const parts = [`"${col.name}"`, col.getSQLType()];
    if (col.primary) parts.push("PRIMARY KEY");
    const dflt = (col as any).default;
    let lit: string | null = null;
    if (dflt !== undefined) {
      lit =
        typeof dflt === "string" ? `'${dflt.replace(/'/g, "''")}'`
        : typeof dflt === "boolean" ? (dflt ? "1" : "0")
        : typeof dflt === "number" ? String(dflt)
        : null;
    }
    if (col.notNull && (lit !== null || col.primary)) parts.push("NOT NULL");
    if (lit !== null) parts.push(`DEFAULT ${lit}`);
    return parts.join(" ");
  });
  return `CREATE TABLE IF NOT EXISTS "${cfg.name}" (${cols.join(", ")})`;
}

beforeAll(async () => {
  const sql = (db as any).$client;
  for (const t of [schema.companySettings, schema.notificationChannels]) {
    await sql.execute(ddlFor(t));
  }
  const settings: Array<[string, string]> = [
    [WPG_CO, "America/Winnipeg"],
    [SYD_CO, "Australia/Sydney"],
    [BAD_CO, "Mars/Olympus_Mons"],
  ];
  for (const [co, tz] of settings) {
    await sql.execute({
      sql: "INSERT OR IGNORE INTO company_settings (id, company_id, timezone) VALUES (?,?,?)",
      args: [`qh-settings-${co}`, co, tz],
    });
    await sql.execute({
      sql: `INSERT OR IGNORE INTO notification_channels
              (id, company_id, quiet_hours_enabled, quiet_start, quiet_end, quiet_channels)
            VALUES (?,?,?,?,?,?)`,
      args: [`qh-chan-${co}`, co, 1, "21:00", "08:00", "sms,email"],
    });
  }
  clearCompanyTimeZoneCache();
});

describe("quiet hours use the tenant's time zone", () => {
  it("16:00 in Winnipeg is a sendable hour (the UTC bug silenced it)", async () => {
    const now = zonedTimeToInstant("America/Winnipeg", 2026, 8, 11, 16, 0);
    expect(now.getUTCHours()).toBe(21); // the hour the old code compared
    expect(await channelAllowed(WPG_CO, "sms", now)).toBe(true);
  });

  it("22:00 in Winnipeg is suppressed", async () => {
    const now = zonedTimeToInstant("America/Winnipeg", 2026, 8, 11, 22, 0);
    expect(await channelAllowed(WPG_CO, "sms", now)).toBe(false);
  });

  it("03:00 in Winnipeg is suppressed (the old code sent at 3 AM)", async () => {
    const now = zonedTimeToInstant("America/Winnipeg", 2026, 8, 11, 3, 0);
    expect(await channelAllowed(WPG_CO, "sms", now)).toBe(false);
  });

  it("the SAME instant is quiet for one tenant and sendable for the other", async () => {
    // 23:00 Winnipeg = 14:00 next-day Sydney.
    const now = zonedTimeToInstant("America/Winnipeg", 2026, 8, 11, 23, 0);
    expect(await channelAllowed(WPG_CO, "sms", now)).toBe(false);
    expect(await channelAllowed(SYD_CO, "sms", now)).toBe(true);
  });

  it("a channel not listed in quietChannels ignores the window", async () => {
    const now = zonedTimeToInstant("America/Winnipeg", 2026, 8, 11, 3, 0);
    expect(await channelAllowed(WPG_CO, "inApp", now)).toBe(true);
  });

  it("an unusable timezone falls back to the default zone, it does not throw", async () => {
    const now = zonedTimeToInstant("America/Winnipeg", 2026, 8, 11, 3, 0);
    expect(await channelAllowed(BAD_CO, "sms", now)).toBe(false);
  });

  it("a tenant with no channel config at all is allowed (unconfigured != blocked)", async () => {
    expect(await channelAllowed("qh-unconfigured-co", "sms", new Date())).toBe(true);
  });
});
