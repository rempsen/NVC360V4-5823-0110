import { usersForCompany } from "../lib/memberships";
import { Hono } from "hono";
import * as schema from "../database/schema";
import { requireAuth, tenantId } from "../middleware/auth";
import { tdb, type TenantDb } from "../database/tenant";
import { inPoly } from "../../shared/zone-utils";
import { companyTimeZone } from "../../services/company-tz";
import { namedDayBounds, zonedDayKey } from "../../shared/tz";
import type { AppEnv } from "../env";

/* ---------------------------------------------------------------------------
 * Reports engine — aggregated, date-range + filter aware.
 * GET /api/reports/:report?from=ISO&to=ISO&status=&techId=&zone=
 * Returns: { kpis, series, rows, columns, meta }
 * report ∈ revenue | tech-performance | job-status | payroll | catalog |
 *          clients | invoices-ar | zones
 * ------------------------------------------------------------------------- */

type Kpi = { label: string; value: string; sub?: string; tone?: "good" | "bad" | "neutral" | "warn" };
type SeriesPoint = Record<string, number | string>;
type Report = {
  kpis: Kpi[];
  series: { id: string; title: string; type: "bar" | "line" | "pie" | "area"; xKey: string; data: SeriesPoint[]; bars?: { key: string; label: string; color: string }[] };
  series2?: Report["series"];
  rows: Record<string, any>[];
  columns: { key: string; label: string; kind?: "money" | "num" | "date" | "text" | "pct" }[];
  meta?: Record<string, any>;
};

const C = {
  brand: "#06B6D4",
  green: "#34d399",
  red: "#f87171",
  amber: "#fbbf24",
  blue: "#60a5fa",
  purple: "#a78bfa",
  pink: "#f472b6",
  slate: "#94a3b8",
};

/**
 * Inclusive day bounds for the requested range, in the TENANT's time zone.
 *
 * This used setHours() on a Date, i.e. the server process time zone — UTC in
 * production. For a Winnipeg tenant that shifted every range five hours: a
 * report "for August 1" ran from 19:00 Jul 31 to 19:00 Aug 1 local, so evening
 * jobs fell into the next day and the first evening of the range was missing.
 * A bare "2026-08-01" from the date picker also parses as UTC midnight, which
 * is the previous local day — namedDayBounds() takes the calendar date from the
 * string instead of re-deriving it.
 */
function parseRange(c: any, tz: string) {
  const fromQ = c.req.query("from");
  const toQ = c.req.query("to");
  const toB = namedDayBounds(toQ || new Date(), tz);
  const fromB = namedDayBounds(
    fromQ || new Date(toB.end.getTime() - 30 * 86_400_000),
    tz,
  );
  return { from: fromB.start, to: toB.end };
}

const money = (n: number) => `$${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Day bucket in the tenant's time zone (see parseRange). */
const dayKey = (d: Date, tz: string) => zonedDayKey(d, tz);
const niceDay = (k: string) => {
  const [, m, d] = k.split("-");
  return `${["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m)]} ${Number(d)}`;
};

// Zone attribution uses the SHARED point-in-polygon (shared/zone-utils.ts).
// This file used to carry its own copy of it, with the same axis-swap bug, so
// zone reports attributed zero jobs to every zone. One implementation now.

async function techNameMap(t: TenantDb) {
  const riders = await t.select(schema.riders);
  const users = await usersForCompany(t.companyId);
  const uById = new Map(users.map((u) => [u.id, u]));
  const map = new Map<string, { name: string; riderId: string }>();
  for (const r of riders) {
    const u = uById.get(r.userId);
    map.set(r.id, { name: u?.name ?? "Unknown", riderId: r.id });
  }
  return { map, riders, users, uById };
}

export const reportsRoutes = new Hono<AppEnv>()
  // dropdown options for the report filter bar
  .get("/meta/filters", requireAuth, async (c) => {
    const t = tdb(tenantId(c));
    const { map } = await techNameMap(t);
    const techs = [...map.entries()].map(([id, v]) => ({ id, name: v.name })).sort((a, b) => a.name.localeCompare(b.name));
    const zones = (await t.select(schema.serviceZones)).map((z) => ({ id: z.id, name: z.name }));
    const statuses = ["pending", "confirmed", "assigned", "enroute", "arrived", "in_progress", "completed", "cancelled"];
    return c.json({ techs, zones, statuses }, 200);
  })
  .get("/:report", requireAuth, async (c) => {
    const report = c.req.param("report");
    const t = tdb(tenantId(c));
    const tz = await companyTimeZone(tenantId(c));
    const { from, to } = parseRange(c, tz);
    const fStatus = c.req.query("status") || "";
    const fTech = c.req.query("techId") || "";
    const fZone = c.req.query("zone") || "";

    const inRange = (d?: Date | number | null) => {
      if (d == null) return false;
      const t = typeof d === "number" ? d : new Date(d).getTime();
      return t >= from.getTime() && t <= to.getTime();
    };

    // ---- shared dataset: bookings in range (+ filters) ----
    const loadBookings = async () => {
      let bs = await t.select(schema.bookings);
      bs = bs.filter((b) => inRange(b.scheduledAt));
      if (fStatus) bs = bs.filter((b) => b.status === fStatus);
      if (fTech) bs = bs.filter((b) => b.riderId === fTech);
      return bs;
    };

    let out: Report;

    switch (report) {
      /* ============================ REVENUE ============================ */
      case "revenue": {
        const bs = (await loadBookings()).filter((b) => b.status !== "cancelled");
        const services = await t.select(schema.services);
        const svcById = new Map(services.map((s) => [s.id, s.name]));

        const byDay = new Map<string, { revenue: number; jobs: number; tax: number }>();
        const bySvc = new Map<string, { revenue: number; jobs: number }>();
        let revenue = 0, tax = 0, cogs = 0;
        for (const b of bs) {
          const total = Number(b.total || b.price || 0);
          revenue += total;
          tax += Number(b.taxAmount || 0);
          cogs += Number(b.lineItemsCost || 0);
          const k = dayKey(new Date(b.scheduledAt), tz);
          const d = byDay.get(k) ?? { revenue: 0, jobs: 0, tax: 0 };
          d.revenue += total; d.jobs += 1; d.tax += Number(b.taxAmount || 0);
          byDay.set(k, d);
          const sName = svcById.get(b.serviceId) ?? "Other";
          const sv = bySvc.get(sName) ?? { revenue: 0, jobs: 0 };
          sv.revenue += total; sv.jobs += 1; bySvc.set(sName, sv);
        }
        const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => ({ day: niceDay(k), revenue: Math.round(v.revenue), jobs: v.jobs }));
        const svcRows = [...bySvc.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
        const aov = bs.length ? revenue / bs.length : 0;
        const margin = revenue - cogs;

        out = {
          kpis: [
            { label: "Revenue", value: money(revenue), tone: "good" },
            { label: "Jobs", value: String(bs.length), tone: "neutral" },
            { label: "Avg order value", value: money(aov), tone: "neutral" },
            { label: "Tax collected", value: money(tax), tone: "neutral" },
            { label: "Gross margin", value: money(margin), sub: revenue ? `${Math.round((margin / revenue) * 100)}%` : "—", tone: "good" },
          ],
          series: {
            id: "rev-day", title: "Revenue by day", type: "area", xKey: "day", data: days,
            bars: [{ key: "revenue", label: "Revenue", color: C.brand }],
          },
          series2: {
            id: "rev-svc", title: "Revenue by service", type: "pie", xKey: "name",
            data: svcRows.map(([name, v]) => ({ name, value: Math.round(v.revenue) })),
          },
          rows: svcRows.map(([name, v]) => ({ service: name, jobs: v.jobs, revenue: v.revenue, avg: v.jobs ? v.revenue / v.jobs : 0 })),
          columns: [
            { key: "service", label: "Service", kind: "text" },
            { key: "jobs", label: "Jobs", kind: "num" },
            { key: "revenue", label: "Revenue", kind: "money" },
            { key: "avg", label: "Avg / job", kind: "money" },
          ],
        };
        break;
      }

      /* ====================== TECH PERFORMANCE ====================== */
      case "tech-performance": {
        const bs = await loadBookings();
        const { map } = await techNameMap(t);
        const reviews = await t.select(schema.reviews);
        const ratingByRider = new Map<string, { sum: number; n: number }>();
        for (const r of reviews) {
          const b = bs.find((x) => x.id === r.bookingId);
          const rid = b?.riderId;
          if (!rid) continue;
          const cur = ratingByRider.get(rid) ?? { sum: 0, n: 0 };
          cur.sum += Number(r.rating || 0); cur.n += 1; ratingByRider.set(rid, cur);
        }
        const agg = new Map<string, { name: string; jobs: number; completed: number; revenue: number; pay: number; mins: number; transitMins: number; km: number }>();
        for (const b of bs) {
          if (!b.riderId) continue;
          const nm = map.get(b.riderId)?.name ?? "Unknown";
          const a = agg.get(b.riderId) ?? { name: nm, jobs: 0, completed: 0, revenue: 0, pay: 0, mins: 0, transitMins: 0, km: 0 };
          a.jobs += 1;
          if (b.status === "completed") a.completed += 1;
          a.revenue += Number(b.total || b.price || 0);
          a.pay += Number(b.techPay || 0);
          a.mins += Number(b.onSiteMinutes || 0);
          a.transitMins += Number(b.transitMinutes || 0);
          a.km += Number(b.mileageKm || 0);
          agg.set(b.riderId, a);
        }
        const rows = [...agg.entries()].map(([rid, a]) => {
          const r = ratingByRider.get(rid);
          return {
            technician: a.name,
            jobs: a.jobs,
            completed: a.completed,
            completionPct: a.jobs ? (a.completed / a.jobs) * 100 : 0,
            revenue: a.revenue,
            pay: a.pay,
            rating: r && r.n ? r.sum / r.n : 0,
            hours: a.mins / 60,
            transitHours: a.transitMins / 60,
            km: a.km,
          };
        }).sort((a, b) => b.revenue - a.revenue);

        const totalJobs = rows.reduce((s, r) => s + r.jobs, 0);
        const totalRev = rows.reduce((s, r) => s + r.revenue, 0);
        const ratedRows = rows.filter((r) => r.rating > 0);
        const avgRating = ratedRows.length
          ? ratedRows.reduce((s, r) => s + r.rating, 0) / ratedRows.length : 0;

        out = {
          kpis: [
            { label: "Active techs", value: String(rows.length), tone: "neutral" },
            { label: "Jobs handled", value: String(totalJobs), tone: "neutral" },
            { label: "Revenue", value: money(totalRev), tone: "good" },
            { label: "Avg rating", value: avgRating ? avgRating.toFixed(2) : "—", tone: "good" },
          ],
          series: {
            id: "tech-rev", title: "Revenue by technician", type: "bar", xKey: "technician",
            data: rows.slice(0, 12).map((r) => ({ technician: r.technician, revenue: Math.round(r.revenue), pay: Math.round(r.pay) })),
            bars: [{ key: "revenue", label: "Revenue", color: C.brand }, { key: "pay", label: "Pay", color: C.amber }],
          },
          rows,
          columns: [
            { key: "technician", label: "Technician", kind: "text" },
            { key: "jobs", label: "Jobs", kind: "num" },
            { key: "completed", label: "Completed", kind: "num" },
            { key: "completionPct", label: "Completion", kind: "pct" },
            { key: "revenue", label: "Revenue", kind: "money" },
            { key: "pay", label: "Tech pay", kind: "money" },
            { key: "rating", label: "Rating", kind: "num" },
            { key: "hours", label: "On-site hrs", kind: "num" },
            { key: "transitHours", label: "Transit hrs", kind: "num" },
            { key: "km", label: "KM", kind: "num" },
          ],
        };
        break;
      }

      /* ======================== JOB STATUS ======================== */
      case "job-status": {
        const bs = await loadBookings();
        const order = ["pending", "confirmed", "assigned", "enroute", "arrived", "in_progress", "completed", "cancelled"];
        const counts = new Map<string, number>();
        for (const b of bs) counts.set(b.status, (counts.get(b.status) ?? 0) + 1);
        const completed = counts.get("completed") ?? 0;
        const cancelled = counts.get("cancelled") ?? 0;
        const active = bs.length - completed - cancelled;
        const data = order.filter((s) => counts.has(s)).map((s) => ({ status: s.replace(/_/g, " "), count: counts.get(s) ?? 0 }));

        // priority split
        const prio = new Map<string, number>();
        for (const b of bs) prio.set(b.priority, (prio.get(b.priority) ?? 0) + 1);

        out = {
          kpis: [
            { label: "Total jobs", value: String(bs.length), tone: "neutral" },
            { label: "Completed", value: String(completed), sub: bs.length ? `${Math.round((completed / bs.length) * 100)}%` : "—", tone: "good" },
            { label: "Active / open", value: String(active), tone: "warn" },
            { label: "Cancelled", value: String(cancelled), sub: bs.length ? `${Math.round((cancelled / bs.length) * 100)}%` : "—", tone: "bad" },
          ],
          series: {
            id: "status", title: "Jobs by status", type: "bar", xKey: "status", data,
            bars: [{ key: "count", label: "Jobs", color: C.brand }],
          },
          series2: {
            id: "prio", title: "By priority", type: "pie", xKey: "name",
            data: [...prio.entries()].map(([name, value]) => ({ name, value })),
          },
          rows: data.map((d) => ({ status: d.status, count: d.count, pct: bs.length ? (d.count / bs.length) * 100 : 0 })),
          columns: [
            { key: "status", label: "Status", kind: "text" },
            { key: "count", label: "Jobs", kind: "num" },
            { key: "pct", label: "Share", kind: "pct" },
          ],
        };
        break;
      }

      /* ========================= PAYROLL ========================= */
      case "payroll": {
        const { map } = await techNameMap(t);
        let payouts = await t.select(schema.payouts);
        payouts = payouts.filter((p) => inRange(p.periodStart) || inRange(p.periodEnd));
        if (fTech) payouts = payouts.filter((p) => p.riderId === fTech);

        const agg = new Map<string, { name: string; jobs: number; gross: number; fee: number; net: number; paid: number; pending: number }>();
        for (const p of payouts) {
          const nm = map.get(p.riderId)?.name ?? "Unknown";
          const a = agg.get(p.riderId) ?? { name: nm, jobs: 0, gross: 0, fee: 0, net: 0, paid: 0, pending: 0 };
          a.jobs += p.jobsCount; a.gross += p.gross; a.fee += p.fee; a.net += p.net;
          if (p.status === "paid") a.paid += p.net; else a.pending += p.net;
          agg.set(p.riderId, a);
        }
        const rows = [...agg.values()].map((a) => ({ technician: a.name, jobs: a.jobs, gross: a.gross, fee: a.fee, net: a.net, paid: a.paid, pending: a.pending }))
          .sort((a, b) => b.net - a.net);
        const tGross = rows.reduce((s, r) => s + r.gross, 0);
        const tNet = rows.reduce((s, r) => s + r.net, 0);
        const tPending = rows.reduce((s, r) => s + r.pending, 0);

        out = {
          kpis: [
            { label: "Gross earnings", value: money(tGross), tone: "neutral" },
            { label: "Platform fees", value: money(rows.reduce((s, r) => s + r.fee, 0)), tone: "neutral" },
            { label: "Net payable", value: money(tNet), tone: "good" },
            { label: "Pending payout", value: money(tPending), tone: "warn" },
          ],
          series: {
            id: "pay", title: "Net pay by technician", type: "bar", xKey: "technician",
            data: rows.slice(0, 12).map((r) => ({ technician: r.technician, net: Math.round(r.net), paid: Math.round(r.paid) })),
            bars: [{ key: "net", label: "Net", color: C.green }, { key: "paid", label: "Paid", color: C.brand }],
          },
          rows,
          columns: [
            { key: "technician", label: "Technician", kind: "text" },
            { key: "jobs", label: "Jobs", kind: "num" },
            { key: "gross", label: "Gross", kind: "money" },
            { key: "fee", label: "Fee", kind: "money" },
            { key: "net", label: "Net", kind: "money" },
            { key: "paid", label: "Paid", kind: "money" },
            { key: "pending", label: "Pending", kind: "money" },
          ],
        };
        break;
      }

      /* ========================= CATALOG ========================= */
      case "catalog": {
        const bs = (await loadBookings()).filter((b) => b.status !== "cancelled");
        const items = await t.select(schema.catalogItems);
        const itemById = new Map(items.map((i) => [i.id, i]));
        const agg = new Map<string, { name: string; sku: string; category: string; qty: number; revenue: number; cost: number }>();
        for (const b of bs) {
          let li: any[] = [];
          try { li = JSON.parse(b.lineItems || "[]"); } catch { /* ignore */ }
          for (const l of li) {
            const key = l.itemId || l.sku || l.name;
            const meta = itemById.get(l.itemId);
            const a = agg.get(key) ?? { name: l.name || meta?.name || "Item", sku: l.sku || meta?.sku || "", category: meta?.category || "General", qty: 0, revenue: 0, cost: 0 };
            a.qty += Number(l.qty || 0);
            a.revenue += Number(l.price ?? (l.unitPrice || 0) * (l.qty || 0));
            a.cost += Number(l.cost ?? (l.unitCost || 0) * (l.qty || 0));
            agg.set(key, a);
          }
        }
        const rows = [...agg.values()].map((a) => ({ ...a, margin: a.revenue - a.cost, marginPct: a.revenue ? ((a.revenue - a.cost) / a.revenue) * 100 : 0 }))
          .sort((a, b) => b.margin - a.margin);
        const tRev = rows.reduce((s, r) => s + r.revenue, 0);
        const tCost = rows.reduce((s, r) => s + r.cost, 0);
        const byCat = new Map<string, number>();
        for (const r of rows) byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.margin);

        out = {
          kpis: [
            { label: "Catalog revenue", value: money(tRev), tone: "good" },
            { label: "COGS", value: money(tCost), tone: "neutral" },
            { label: "Margin", value: money(tRev - tCost), tone: "good" },
            { label: "Margin %", value: tRev ? `${Math.round(((tRev - tCost) / tRev) * 100)}%` : "—", tone: "good" },
          ],
          series: {
            id: "cat-top", title: "Top items by margin", type: "bar", xKey: "name",
            data: rows.slice(0, 10).map((r) => ({ name: r.name, margin: Math.round(r.margin), revenue: Math.round(r.revenue) })),
            bars: [{ key: "revenue", label: "Revenue", color: C.brand }, { key: "margin", label: "Margin", color: C.green }],
          },
          series2: {
            id: "cat-pie", title: "Margin by category", type: "pie", xKey: "name",
            data: [...byCat.entries()].map(([name, value]) => ({ name, value: Math.round(value) })),
          },
          rows,
          columns: [
            { key: "name", label: "Item", kind: "text" },
            { key: "sku", label: "SKU", kind: "text" },
            { key: "category", label: "Category", kind: "text" },
            { key: "qty", label: "Qty", kind: "num" },
            { key: "revenue", label: "Revenue", kind: "money" },
            { key: "cost", label: "Cost", kind: "money" },
            { key: "margin", label: "Margin", kind: "money" },
            { key: "marginPct", label: "Margin %", kind: "pct" },
          ],
        };
        break;
      }

      /* ========================== CLIENTS ========================== */
      case "clients": {
        const bs = (await loadBookings()).filter((b) => b.status !== "cancelled");
        const users = await usersForCompany(t.companyId);
        const uById = new Map(users.map((u) => [u.id, u]));
        const agg = new Map<string, { name: string; email: string; jobs: number; revenue: number; first: number; last: number }>();
        for (const b of bs) {
          const u = uById.get(b.customerId);
          const a = agg.get(b.customerId) ?? { name: u?.name ?? "Unknown", email: u?.email ?? "", jobs: 0, revenue: 0, first: Infinity, last: 0 };
          a.jobs += 1; a.revenue += Number(b.total || b.price || 0);
          const t = new Date(b.scheduledAt).getTime();
          a.first = Math.min(a.first, t); a.last = Math.max(a.last, t);
          agg.set(b.customerId, a);
        }
        const rows = [...agg.values()].map((a) => ({
          client: a.name, email: a.email, jobs: a.jobs, revenue: a.revenue,
          avg: a.jobs ? a.revenue / a.jobs : 0,
          lastSeen: new Date(a.last).toISOString(),
          type: a.jobs > 1 ? "Returning" : "New",
        })).sort((a, b) => b.revenue - a.revenue);
        const returning = rows.filter((r) => r.type === "Returning").length;
        const tRev = rows.reduce((s, r) => s + r.revenue, 0);

        out = {
          kpis: [
            { label: "Active clients", value: String(rows.length), tone: "neutral" },
            { label: "Returning", value: String(returning), sub: rows.length ? `${Math.round((returning / rows.length) * 100)}%` : "—", tone: "good" },
            { label: "New", value: String(rows.length - returning), tone: "neutral" },
            { label: "Revenue", value: money(tRev), tone: "good" },
          ],
          series: {
            id: "top-clients", title: "Top clients by revenue", type: "bar", xKey: "client",
            data: rows.slice(0, 10).map((r) => ({ client: r.client, revenue: Math.round(r.revenue) })),
            bars: [{ key: "revenue", label: "Revenue", color: C.brand }],
          },
          series2: {
            id: "mix", title: "New vs returning", type: "pie", xKey: "name",
            data: [{ name: "Returning", value: returning }, { name: "New", value: rows.length - returning }],
          },
          rows,
          columns: [
            { key: "client", label: "Client", kind: "text" },
            { key: "email", label: "Email", kind: "text" },
            { key: "jobs", label: "Jobs", kind: "num" },
            { key: "revenue", label: "Revenue", kind: "money" },
            { key: "avg", label: "Avg / job", kind: "money" },
            { key: "type", label: "Type", kind: "text" },
            { key: "lastSeen", label: "Last job", kind: "date" },
          ],
        };
        break;
      }

      /* ======================= INVOICES / AR ======================= */
      case "invoices-ar": {
        let inv = await t.select(schema.invoices);
        inv = inv.filter((i) => inRange(i.createdAt));
        const users = await usersForCompany(t.companyId);
        const uById = new Map(users.map((u) => [u.id, u]));
        const now = Date.now();
        let paid = 0, unpaid = 0;
        const aging = { current: 0, d30: 0, d60: 0, d90: 0 };
        const rows = inv.map((i) => {
          const total = Number(i.total || 0);
          if (i.status === "paid") paid += total; else unpaid += total;
          let bucket = "current";
          if (i.status !== "paid") {
            const age = (now - new Date(i.createdAt).getTime()) / 86_400_000;
            if (age > 90) { aging.d90 += total; bucket = "90+"; }
            else if (age > 60) { aging.d60 += total; bucket = "61-90"; }
            else if (age > 30) { aging.d30 += total; bucket = "31-60"; }
            else { aging.current += total; bucket = "0-30"; }
          }
          return {
            number: i.number, client: uById.get(i.customerId)?.name ?? "—",
            amount: i.amount, tax: i.tax, total: i.total, status: i.status,
            method: i.method, aging: i.status === "paid" ? "—" : bucket,
            createdAt: new Date(i.createdAt).toISOString(),
          };
        }).sort((a, b) => (a.status === b.status ? 0 : a.status === "unpaid" ? -1 : 1));

        out = {
          kpis: [
            { label: "Invoiced", value: money(paid + unpaid), tone: "neutral" },
            { label: "Collected", value: money(paid), tone: "good" },
            { label: "Outstanding (AR)", value: money(unpaid), tone: "warn" },
            { label: "Overdue 60+", value: money(aging.d60 + aging.d90), tone: "bad" },
          ],
          series: {
            id: "aging", title: "AR aging", type: "bar", xKey: "bucket",
            data: [
              { bucket: "0-30", amount: Math.round(aging.current) },
              { bucket: "31-60", amount: Math.round(aging.d30) },
              { bucket: "61-90", amount: Math.round(aging.d60) },
              { bucket: "90+", amount: Math.round(aging.d90) },
            ],
            bars: [{ key: "amount", label: "Outstanding", color: C.amber }],
          },
          series2: {
            id: "collect", title: "Collected vs outstanding", type: "pie", xKey: "name",
            data: [{ name: "Collected", value: Math.round(paid) }, { name: "Outstanding", value: Math.round(unpaid) }],
          },
          rows,
          columns: [
            { key: "number", label: "Invoice", kind: "text" },
            { key: "client", label: "Client", kind: "text" },
            { key: "total", label: "Total", kind: "money" },
            { key: "tax", label: "Tax", kind: "money" },
            { key: "status", label: "Status", kind: "text" },
            { key: "method", label: "Method", kind: "text" },
            { key: "aging", label: "Aging", kind: "text" },
            { key: "createdAt", label: "Issued", kind: "date" },
          ],
        };
        break;
      }

      /* =========================== ZONES =========================== */
      case "zones": {
        const bs = (await loadBookings()).filter((b) => b.status !== "cancelled");
        const zones = await t.select(schema.serviceZones);
        const parsed = zones.map((z) => {
          let poly: [number, number][] = [];
          try { poly = JSON.parse(z.polygon || "[]"); } catch { /* */ }
          return { id: z.id, name: z.name, poly };
        });
        const agg = new Map<string, { name: string; jobs: number; revenue: number }>();
        agg.set("__none", { name: "Outside zones", jobs: 0, revenue: 0 });
        for (const z of parsed) agg.set(z.id, { name: z.name, jobs: 0, revenue: 0 });
        for (const b of bs) {
          let zid = "__none";
          for (const z of parsed) {
            if (z.poly.length >= 3 && inPoly(b.lat, b.lng, z.poly)) { zid = z.id; break; }
          }
          const a = agg.get(zid)!;
          a.jobs += 1; a.revenue += Number(b.total || b.price || 0);
        }
        const rows = [...agg.values()].filter((a) => a.jobs > 0).map((a) => ({
          zone: a.name, jobs: a.jobs, revenue: a.revenue, avg: a.jobs ? a.revenue / a.jobs : 0,
        })).sort((a, b) => b.revenue - a.revenue);
        const tRev = rows.reduce((s, r) => s + r.revenue, 0);

        out = {
          kpis: [
            { label: "Zones with activity", value: String(rows.filter((r) => r.zone !== "Outside zones").length), tone: "neutral" },
            { label: "Total jobs", value: String(rows.reduce((s, r) => s + r.jobs, 0)), tone: "neutral" },
            { label: "Revenue", value: money(tRev), tone: "good" },
            { label: "Top zone", value: rows[0]?.zone ?? "—", tone: "good" },
          ],
          series: {
            id: "zone-rev", title: "Revenue by zone", type: "bar", xKey: "zone",
            data: rows.map((r) => ({ zone: r.zone, revenue: Math.round(r.revenue), jobs: r.jobs })),
            bars: [{ key: "revenue", label: "Revenue", color: C.brand }],
          },
          series2: {
            id: "zone-pie", title: "Job share by zone", type: "pie", xKey: "name",
            data: rows.map((r) => ({ name: r.zone, value: r.jobs })),
          },
          rows,
          columns: [
            { key: "zone", label: "Zone", kind: "text" },
            { key: "jobs", label: "Jobs", kind: "num" },
            { key: "revenue", label: "Revenue", kind: "money" },
            { key: "avg", label: "Avg / job", kind: "money" },
          ],
        };
        break;
      }

      default:
        return c.json({ message: "Unknown report" }, 400);
    }

    void fZone; // reserved (zone pre-filter) — zones report attributes internally
    return c.json({ report, from: from.toISOString(), to: to.toISOString(), ...out }, 200);
  });
