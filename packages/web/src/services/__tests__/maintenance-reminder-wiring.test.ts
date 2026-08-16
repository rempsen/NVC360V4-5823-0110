/**
 * WIRING: the maintenance reminder handler must read the TENANT's zone.
 *
 * maintenance-reminder-tz.test.ts pins the copy builder. This pins that the
 * scheduler handler actually feeds it company_settings.timezone — the copy
 * being correct is worthless if the caller still hands it the server's clock.
 *
 * Two tenants, the SAME due instant, different zones: the office notification
 * each one gets must name a different calendar day. That can only pass if the
 * tenant's own zone is consulted.
 *
 * No SMS can escape: the customers here have no phone number, and there are no
 * Twilio credentials in the test env anyway.
 *
 * Harness: ephemeral in-memory libsql, ids prefixed "mrw-".
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";

process.env.DATABASE_URL = ":memory:";
process.env.DATABASE_AUTH_TOKEN = "";
process.env.TWILIO_AUTH_TOKEN = "";
process.env.TWILIO_ACCOUNT_SID = "";

const { db } = await import("../../api/database/index");
const schema = await import("../../api/database/schema");
await import("../maintenance"); // registers the task handler
const { runDueTasks } = await import("../scheduler");
const { clearCompanyTimeZoneCache } = await import("../company-tz");

const WPG = "mrw-winnipeg-co"; // UTC-5 in August
const SYD = "mrw-sydney-co"; // UTC+10 in August

// Due Aug 17, 2026 at 8:00 PM Winnipeg = Aug 18, 01:00 UTC = Aug 18, 11:00 AM Sydney.
const DUE = Date.parse("2026-08-18T01:00:00.000Z");

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

const sqlClient = () => (db as any).$client;

beforeAll(async () => {
  const s = sqlClient();
  for (const t of [
    schema.companySettings, schema.maintenancePlans, schema.scheduledTasks,
    schema.user, schema.notifications, schema.properties, schema.services,
  ]) {
    await s.execute(ddlFor(t));
  }

  for (const [co, tz] of [
    [WPG, "America/Winnipeg"],
    [SYD, "Australia/Sydney"],
  ] as const) {
    await s.execute({
      sql: "INSERT INTO company_settings (id, company_id, name, timezone) VALUES (?,?,?,?)",
      args: [`cs-${co}`, co, "Test Co", tz],
    });
    // An admin to receive the office copy, and a customer with NO phone.
    await s.execute({
      sql: "INSERT INTO user (id, company_id, name, email, role, email_verified) VALUES (?,?,?,?,?,0)",
      args: [`${co}-admin`, co, "Office", `${co}-admin@example.test`, "admin"],
    });
    await s.execute({
      sql: "INSERT INTO user (id, company_id, name, email, role, email_verified) VALUES (?,?,?,?,?,0)",
      args: [`${co}-cust`, co, "Customer", `${co}-cust@example.test`, "customer"],
    });
    await s.execute({
      sql: `INSERT INTO maintenance_plans
              (id, company_id, name, customer_id, address, interval_days,
               remind_days_before, next_due_at, active)
            VALUES (?,?,?,?,?,?,?,?,1)`,
      args: [`${co}-plan`, co, "Furnace tune-up", `${co}-cust`, "1 Test St", 180, 7, DUE],
    });
    await s.execute({
      sql: `INSERT INTO scheduled_tasks (id, company_id, kind, run_at, payload, status)
            VALUES (?,?,?,?,?,'pending')`,
      args: [`${co}-task`, co, "maintenance_reminder", Date.now() - 60_000,
             JSON.stringify({ planId: `${co}-plan` })],
    });
  }
  clearCompanyTimeZoneCache();
  await runDueTasks();
});

async function officeTitle(companyId: string): Promise<string> {
  const r = await sqlClient().execute({
    sql: "SELECT title FROM notifications WHERE company_id = ? AND type = 'maintenance_due' LIMIT 1",
    args: [companyId],
  });
  return String(r.rows[0]?.title ?? "");
}

describe("maintenance reminder reads the tenant's time zone", () => {
  it("names the Winnipeg tenant's local due date", async () => {
    expect(await officeTitle(WPG)).toBe("Furnace tune-up due Aug 17");
  });

  it("names a DIFFERENT day for the Sydney tenant at the same instant", async () => {
    expect(await officeTitle(SYD)).toBe("Furnace tune-up due Aug 18");
  });

  it("the two tenants genuinely disagree — which is only possible per-tenant", async () => {
    expect(await officeTitle(WPG)).not.toBe(await officeTitle(SYD));
  });
});
