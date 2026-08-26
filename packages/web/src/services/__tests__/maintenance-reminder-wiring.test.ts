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
import { ensureSchema } from "../../api/database/__tests__/setup";

process.env.TWILIO_AUTH_TOKEN = "";
process.env.TWILIO_ACCOUNT_SID = "";

await ensureSchema();

const { db } = await import("../../api/database/index");
await import("../maintenance"); // registers the task handler
const { runDueTasks } = await import("../scheduler");
const { clearCompanyTimeZoneCache } = await import("../company-tz");

const WPG = "mrw-winnipeg-co"; // UTC-5 in August
const SYD = "mrw-sydney-co"; // UTC+10 in August

// Due Aug 17, 2026 at 8:00 PM Winnipeg = Aug 18, 01:00 UTC = Aug 18, 11:00 AM Sydney.
const DUE = Date.parse("2026-08-18T01:00:00.000Z");

const sqlClient = () => (db as any).$client;

beforeAll(async () => {
  const s = sqlClient();

  for (const [co, tz] of [
    [WPG, "America/Winnipeg"],
    [SYD, "Australia/Sydney"],
  ] as const) {
    await s.query(
      "INSERT INTO company_settings (id, company_id, name, timezone) VALUES ($1,$2,$3,$4)",
      [`cs-${co}`, co, "Test Co", tz],
    );
    // An admin to receive the office copy, and a customer with NO phone.
    await s.query(
      "INSERT INTO \"user\" (id, company_id, name, email, role, email_verified) VALUES ($1,$2,$3,$4,$5,$6)",
      [`${co}-admin`, co, "Office", `${co}-admin@example.test`, "admin", false],
    );
    await s.query(
      "INSERT INTO \"user\" (id, company_id, name, email, role, email_verified) VALUES ($1,$2,$3,$4,$5,$6)",
      [`${co}-cust`, co, "Customer", `${co}-cust@example.test`, "customer", false],
    );
    await s.query(
      `INSERT INTO maintenance_plans
              (id, company_id, name, customer_id, address, interval_days,
               remind_days_before, next_due_at, active)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`,
      [`${co}-plan`, co, "Furnace tune-up", `${co}-cust`, "1 Test St", 180, 7, new Date(DUE)],
    );
    await s.query(
      `INSERT INTO scheduled_tasks (id, company_id, kind, run_at, payload, status)
            VALUES ($1,$2,$3,$4,$5,'pending')`,
      [`${co}-task`, co, "maintenance_reminder", new Date(Date.now() - 60_000),
             JSON.stringify({ planId: `${co}-plan` })],
    );
  }
  clearCompanyTimeZoneCache();
  await runDueTasks();
});

async function officeTitle(companyId: string): Promise<string> {
  const r = await sqlClient().query(
    "SELECT title FROM notifications WHERE company_id = $1 AND type = 'maintenance_due' LIMIT 1",
    [companyId],
  );
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
