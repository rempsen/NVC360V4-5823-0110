import { Hono } from "hono";
import { db } from "../database";
import { tdb } from "../database/tenant";
import * as schema from "../database/schema";
import { eq, and, gte, lte } from "drizzle-orm";
import { requireAuth, loadMemberships } from "../middleware/auth";
import { isAdminRole } from "../lib/permissions";
import { buildCalendar, type CalEvent } from "../../services/ics";

type SessionUser = { id: string; role?: string; email: string; name: string };

function ensureToken(existing: string | null): string {
  return existing && existing.length > 10 ? existing : crypto.randomUUID().replace(/-/g, "");
}

function baseUrl(c: any): string {
  const env = process.env.APP_URL || process.env.PUBLIC_URL;
  if (env) return env.replace(/\/$/, "");
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

/** Resolve the set of bookings a given user should see on their calendar. */
async function bookingsForUser(u: { id: string; role: string | null; companyId: string }) {
  const t = tdb(u.companyId);
  if (isAdminRole(u.role)) {
    return t.select(schema.bookings);
  }
  if (u.role === "rider") {
    const rp = await t.selectOne(schema.riders, eq(schema.riders.userId, u.id));
    if (!rp) return [];
    return t.select(schema.bookings, eq(schema.bookings.riderId, rp.id));
  }
  return t.select(schema.bookings, eq(schema.bookings.customerId, u.id));
}

async function eventFor(
  b: typeof schema.bookings.$inferSelect,
  base: string,
  companyId: string,
): Promise<CalEvent> {
  const t = tdb(companyId);
  const svc = await t.selectOne(schema.services, eq(schema.services.id, b.serviceId));
  const [cust] = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.id, b.customerId));
  let techName = "";
  if (b.riderId) {
    const r = await t.selectOne(schema.riders, eq(schema.riders.id, b.riderId));
    if (r) {
      const [ru] = await db.select().from(schema.user).where(eq(schema.user.id, r.userId));
      techName = ru?.name ?? "";
    }
  }
  const start = new Date(b.scheduledAt);
  const durMins = svc?.durationMins ?? 60;
  const end = new Date(start.getTime() + durMins * 60_000);
  const descLines = [
    svc?.name ? `Service: ${svc.name}` : "",
    cust?.name ? `Client: ${cust.name}` : "",
    b.customerPhone ? `Phone: ${b.customerPhone}` : "",
    techName ? `Technician: ${techName}` : "Technician: Unassigned",
    `Status: ${b.status}`,
    b.priority ? `Priority: ${b.priority}` : "",
    b.total ? `Total: $${Number(b.total).toFixed(2)}` : "",
    b.notes ? `Notes: ${b.notes}` : "",
    b.publicToken ? `Track: ${base}/t/${b.publicToken}` : "",
  ].filter(Boolean);
  return {
    uid: `booking-${b.id}@nvc360`,
    title: b.title || svc?.name || "Job",
    description: descLines.join("\n"),
    location: b.address,
    start,
    end,
    status: b.status === "cancelled" ? "CANCELLED" : "CONFIRMED",
    url: b.publicToken ? `${base}/t/${b.publicToken}` : undefined,
    alarmMinutesBefore: 60,
    lat: b.lat,
    lng: b.lng,
  };
}

export const calendarRoutes = new Hono()
  // Return (creating if needed) the current user's personal feed URLs.
  .get("/feed", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    const [row] = await db.select().from(schema.user).where(eq(schema.user.id, u.id));
    let token = (row as any)?.calendarToken as string | null;
    if (!token) {
      token = ensureToken(null);
      await db
        .update(schema.user)
        .set({ calendarToken: token } as any)
        .where(eq(schema.user.id, u.id));
    }
    const base = baseUrl(c);
    const httpsUrl = `${base}/api/calendar/${token}.ics`;
    const webcal = httpsUrl.replace(/^https?:\/\//, "webcal://");
    return c.json(
      {
        token,
        url: httpsUrl,
        webcal,
        google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
        outlook: `https://outlook.office.com/calendar/0/addfromweb?url=${encodeURIComponent(httpsUrl)}&name=${encodeURIComponent("NVC360 Schedule")}`,
      },
      200,
    );
  })
  // Regenerate the token (invalidates the old subscription URL).
  .post("/feed/regenerate", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    const token = ensureToken(null);
    await db
      .update(schema.user)
      .set({ calendarToken: token } as any)
      .where(eq(schema.user.id, u.id));
    return c.json({ token }, 200);
  })
  // Public token-authed iCal feed. Subscribed by Google Calendar / Outlook.
  // NOTE: must be mounted so this path resolves to /api/calendar/:token.ics
  .get("/:file", async (c) => {
    const file = c.req.param("file");
    const token = file.replace(/\.ics$/i, "");
    if (!token || token.length < 10) return c.text("Not found", 404);
    const [u] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.calendarToken as any, token));
    if (!u) return c.text("Not found", 404);

    // Window: 60 days back, 180 days forward (keeps feed small + fast).
    const now = Date.now();
    const from = new Date(now - 60 * 86_400_000);
    const to = new Date(now + 180 * 86_400_000);

    // A person can work for several companies, and this feed is the single
    // calendar they subscribe to — so it has to be the union of their jobs at
    // every company, each read with the role they hold THERE. Reading only
    // u.companyId hid every job from their non-home companies.
    const memberships = await loadMemberships(u.id);
    const scopes = memberships.length
      ? memberships.map((m) => ({ companyId: m.companyId, role: m.role }))
      : [{ companyId: (u as any).companyId || "default", role: u.role }];

    const perCompany = await Promise.all(
      scopes.map(async (s) => {
        const rows = await bookingsForUser({ id: u.id, role: s.role, companyId: s.companyId });
        return rows
          .filter((b) => {
            const t = new Date(b.scheduledAt).getTime();
            return t >= from.getTime() && t <= to.getTime();
          })
          .map((b) => ({ booking: b, companyId: s.companyId }));
      }),
    );
    const scoped = perCompany.flat();

    const base = baseUrl(c);
    const events = await Promise.all(scoped.map((x) => eventFor(x.booking, base, x.companyId)));
    const calName =
      isAdminRole(u.role)
        ? "NVC360 — Dispatch Schedule"
        : u.role === "rider"
          ? `NVC360 — ${u.name}'s Jobs`
          : "NVC360 — My Appointments";
    const ics = buildCalendar(events, { name: calName, refreshMinutes: 30 });
    return new Response(ics, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `inline; filename="nvc360-${u.role ?? "schedule"}.ics"`,
        "Cache-Control": "no-cache, max-age=0",
      },
    });
  });

// silence unused import lint if tree-shaken
void and;
void gte;
void lte;
