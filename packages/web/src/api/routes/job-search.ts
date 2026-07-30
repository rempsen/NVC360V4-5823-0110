import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  eq, and, or, like, gte, lte, isNull, isNotNull, inArray, desc, asc, sql,
} from "drizzle-orm";
import { requireAuth, tenantId } from "../middleware/auth";
import { isAdminRole } from "../lib/permissions";
import { toCsv, toPdf, buildJobPdf, fileResponse, type JobUnitLine, type JobPhoto } from "./export";

type SessionUser = { id: string; role?: string; email: string; name: string };

const isStaff = (u: SessionUser) => isAdminRole(u?.role) || u?.role === "dispatcher";

/* -------------------------------------------------------------------------- */
/*  Column catalog — every field a dispatcher can export, summary + detail.   */
/* -------------------------------------------------------------------------- */
export type ExpCol = { key: string; label: string; kind?: "money" | "num" | "pct" | "date"; group: "summary" | "detail" };

export const JOB_COLUMNS: ExpCol[] = [
  // summary
  { key: "jobNumber", label: "Job #", group: "summary" },
  { key: "title", label: "Title", group: "summary" },
  { key: "status", label: "Status", group: "summary" },
  { key: "priority", label: "Priority", group: "summary" },
  { key: "service", label: "Service", group: "summary" },
  { key: "customerName", label: "Customer", group: "summary" },
  { key: "customerPhone", label: "Phone", group: "summary" },
  { key: "customerEmail", label: "Email", group: "summary" },
  { key: "address", label: "Address", group: "summary" },
  { key: "region", label: "Region", group: "summary" },
  { key: "technician", label: "Technician", group: "summary" },
  { key: "scheduledAt", label: "Scheduled", kind: "date", group: "summary" },
  { key: "completedAt", label: "Completed", kind: "date", group: "summary" },
  { key: "total", label: "Total", kind: "money", group: "summary" },
  { key: "paymentStatus", label: "Payment", group: "summary" },
  // detail
  { key: "id", label: "Job ID", group: "detail" },
  { key: "createdAt", label: "Created", kind: "date", group: "detail" },
  { key: "startedAt", label: "Started", kind: "date", group: "detail" },
  { key: "assignStatus", label: "Assign status", group: "detail" },
  { key: "subtotal", label: "Subtotal", kind: "money", group: "detail" },
  { key: "taxAmount", label: "Tax", kind: "money", group: "detail" },
  { key: "taxLabel", label: "Tax label", group: "detail" },
  { key: "lineItemsCost", label: "Line items cost", kind: "money", group: "detail" },
  { key: "lineItemsPrice", label: "Line items price", kind: "money", group: "detail" },
  { key: "onSiteMinutes", label: "On-site min", kind: "num", group: "detail" },
  { key: "transitMinutes", label: "Transit min", kind: "num", group: "detail" },
  { key: "mileageKm", label: "Mileage km", kind: "num", group: "detail" },
  { key: "techPay", label: "Tech pay", kind: "money", group: "detail" },
  { key: "notes", label: "Notes", group: "detail" },
  { key: "lineItemsText", label: "Line items", group: "detail" },
];

const COL_BY_KEY = Object.fromEntries(JOB_COLUMNS.map((c) => [c.key, c]));

/* -------------------------------------------------------------------------- */
/*  Filter parsing → drizzle where clause                                     */
/* -------------------------------------------------------------------------- */
type Filters = {
  q?: string;            // free text: customer / address / title / job#
  status?: string[];     // multi
  priority?: string[];
  serviceId?: string;
  riderId?: string;      // technician
  paymentStatus?: string[];
  region?: string;
  tagId?: string;        // client tag
  notes?: string;        // free-text in notes
  schedFrom?: number; schedTo?: number;
  doneFrom?: number; doneTo?: number;
  priceMin?: number; priceMax?: number;
  jobId?: string;        // exact id or job-number prefix
  includeDeleted?: boolean;
};

function parseFilters(c: any): Filters {
  const q = (k: string) => { const v = c.req.query(k); return v && v.trim() ? v.trim() : undefined; };
  const arr = (k: string) => { const v = q(k); return v ? v.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined; };
  const num = (k: string) => { const v = q(k); return v != null && v !== "" && !isNaN(Number(v)) ? Number(v) : undefined; };
  return {
    q: q("q"),
    status: arr("status"),
    priority: arr("priority"),
    serviceId: q("serviceId"),
    riderId: q("riderId"),
    paymentStatus: arr("paymentStatus"),
    region: q("region"),
    tagId: q("tagId"),
    notes: q("notes"),
    schedFrom: num("schedFrom"), schedTo: num("schedTo"),
    doneFrom: num("doneFrom"), doneTo: num("doneTo"),
    priceMin: num("priceMin"), priceMax: num("priceMax"),
    jobId: q("jobId"),
    includeDeleted: q("includeDeleted") === "1",
  };
}

// job number = first 8 chars of id, uppercased (display helper)
const jobNumber = (id: string) => id.replace(/-/g, "").slice(0, 8).toUpperCase();

async function buildWhere(f: Filters, cid: string): Promise<any[]> {
  const b = schema.bookings;
  const conds: any[] = [];
  // tenant boundary: every job-search query is constrained to the caller's company
  conds.push(eq(b.companyId, cid));
  if (!f.includeDeleted) conds.push(isNull(b.deletedAt));

  if (f.status?.length) conds.push(inArray(b.status, f.status));
  if (f.priority?.length) conds.push(inArray(b.priority, f.priority));
  if (f.paymentStatus?.length) conds.push(inArray(b.paymentStatus, f.paymentStatus));
  if (f.serviceId) conds.push(eq(b.serviceId, f.serviceId));
  if (f.riderId) {
    if (f.riderId === "__unassigned__") conds.push(isNull(b.riderId));
    else conds.push(eq(b.riderId, f.riderId));
  }
  if (f.region) conds.push(eq(b.region, f.region));
  if (f.notes) conds.push(like(b.notes, `%${f.notes}%`));
  if (f.schedFrom != null) conds.push(gte(b.scheduledAt, new Date(f.schedFrom)));
  if (f.schedTo != null) conds.push(lte(b.scheduledAt, new Date(f.schedTo)));
  if (f.doneFrom != null) { conds.push(isNotNull(b.finishedAt)); conds.push(gte(b.finishedAt, new Date(f.doneFrom))); }
  if (f.doneTo != null) { conds.push(isNotNull(b.finishedAt)); conds.push(lte(b.finishedAt, new Date(f.doneTo))); }
  if (f.priceMin != null) conds.push(gte(b.total, f.priceMin));
  if (f.priceMax != null) conds.push(lte(b.total, f.priceMax));

  // job id / number: exact id, or id-prefix match on normalized id
  if (f.jobId) {
    const raw = f.jobId.trim();
    conds.push(or(eq(b.id, raw), like(b.id, `${raw.toLowerCase()}%`)) as any);
  }

  // free text across customer name/phone/email + address + title
  if (f.q) {
    const t = `%${f.q}%`;
    const matchingCustomers = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(and(eq(schema.user.companyId, cid), or(like(schema.user.name, t), like(schema.user.email, t), like(schema.user.phone, t))) as any);
    const custIds = matchingCustomers.map((r) => r.id);
    const ors: any[] = [like(b.address, t), like(b.title, t), like(b.customerPhone, t)];
    if (custIds.length) ors.push(inArray(b.customerId, custIds));
    conds.push(or(...ors) as any);
  }

  // client tag filter → customers carrying that tag
  if (f.tagId) {
    const tagged = await db
      .select({ entityId: schema.entityTags.entityId })
      .from(schema.entityTags)
      .where(and(eq(schema.entityTags.companyId, cid), eq(schema.entityTags.tagId, f.tagId), eq(schema.entityTags.entityType, "client")));
    const ids = tagged.map((r) => r.entityId);
    conds.push(ids.length ? inArray(b.customerId, ids) : sql`1 = 0`);
  }

  return conds;
}

/* -------------------------------------------------------------------------- */
/*  Enrichment for export rows                                                */
/* -------------------------------------------------------------------------- */
async function enrichRows(rows: (typeof schema.bookings.$inferSelect)[]) {
  const svcIds = [...new Set(rows.map((r) => r.serviceId).filter((id): id is string => !!id))];
  const riderIds = [...new Set(rows.map((r) => r.riderId).filter(Boolean) as string[])];
  const custIds = [...new Set(rows.map((r) => r.customerId).filter((id): id is string => !!id))];

  const svcMap = new Map<string, any>();
  if (svcIds.length) (await db.select().from(schema.services).where(inArray(schema.services.id, svcIds))).forEach((s) => svcMap.set(s.id, s));
  const riderMap = new Map<string, any>();
  if (riderIds.length) {
    const rs = await db.select().from(schema.riders).where(inArray(schema.riders.id, riderIds));
    const userIds = rs.map((r) => r.userId);
    const um = new Map<string, any>();
    if (userIds.length) (await db.select().from(schema.user).where(inArray(schema.user.id, userIds))).forEach((u) => um.set(u.id, u));
    rs.forEach((r) => riderMap.set(r.id, { ...r, name: um.get(r.userId)?.name, phone: um.get(r.userId)?.phone }));
  }
  const custMap = new Map<string, any>();
  if (custIds.length) (await db.select().from(schema.user).where(inArray(schema.user.id, custIds))).forEach((u) => custMap.set(u.id, u));

  return rows.map((b) => {
    const svc = svcMap.get(b.serviceId);
    const rider = b.riderId ? riderMap.get(b.riderId) : null;
    const cust = custMap.get(b.customerId);
    let lineItemsText = "";
    try {
      const li = JSON.parse(b.lineItems || "[]");
      lineItemsText = Array.isArray(li) ? li.map((x: any) => `${x.qty ?? 1}× ${x.name}`).join("; ") : "";
    } catch { /* ignore */ }
    return {
      id: b.id,
      jobNumber: jobNumber(b.id),
      title: b.title,
      status: b.status,
      priority: b.priority,
      service: svc?.name ?? "",
      serviceId: b.serviceId,
      customerName: cust?.name ?? "",
      customerPhone: b.customerPhone || cust?.phone || "",
      customerEmail: cust?.email ?? "",
      address: b.address,
      region: b.region,
      lat: b.lat ?? null,
      lng: b.lng ?? null,
      technician: rider?.name ?? (b.riderId ? "—" : "Unassigned"),
      riderId: b.riderId,
      scheduledAt: b.scheduledAt,
      completedAt: b.finishedAt,
      startedAt: b.startedAt,
      createdAt: b.createdAt,
      assignStatus: b.assignStatus,
      subtotal: b.subtotal,
      taxAmount: b.taxAmount,
      taxLabel: b.taxLabel,
      lineItemsCost: b.lineItemsCost,
      lineItemsPrice: b.lineItemsPrice,
      onSiteMinutes: b.onSiteMinutes,
      transitMinutes: b.transitMinutes,
      mileageKm: b.mileageKm,
      techPay: b.techPay,
      total: b.total || b.price,
      paymentStatus: b.paymentStatus,
      notes: b.notes,
      lineItemsText,
      deletedAt: b.deletedAt,
    };
  });
}

async function logExport(cid: string, actor: SessionUser, format: string, count: number, filters: Filters, columns: string[]) {
  try {
    await db.insert(schema.auditLog).values({
      companyId: cid,
      actorId: actor.id,
      actorName: actor.name || actor.email,
      action: "export",
      entityType: "job_search",
      entityId: "",
      summary: `Exported ${count} job${count === 1 ? "" : "s"} as ${format.toUpperCase()}`,
      meta: JSON.stringify({ format, count, columns, filters }),
    });
  } catch { /* non-fatal */ }
}

/* -------------------------------------------------------------------------- */
/*  Routes                                                                    */
/* -------------------------------------------------------------------------- */
export const jobSearchRoutes = new Hono()
  // facet options for the filter UI (services, technicians, statuses, regions, tags)
  .get("/facets", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isStaff(u)) return c.json({ message: "Forbidden" }, 403);
    const cid = tenantId(c);
    const services = await db.select({ id: schema.services.id, name: schema.services.name }).from(schema.services).where(eq(schema.services.companyId, cid));
    const riderRows = await db.select().from(schema.riders).where(eq(schema.riders.companyId, cid));
    const userIds = riderRows.map((r) => r.userId);
    const um = new Map<string, any>();
    if (userIds.length) (await db.select().from(schema.user).where(inArray(schema.user.id, userIds))).forEach((x) => um.set(x.id, x));
    const technicians = riderRows.map((r) => ({ id: r.id, name: um.get(r.userId)?.name ?? "Tech" }));
    const tags = await db.select({ id: schema.tags.id, label: schema.tags.label, color: schema.tags.color }).from(schema.tags).where(and(eq(schema.tags.companyId, cid), or(eq(schema.tags.scope, "client"), eq(schema.tags.scope, "both"))) as any);
    const regionRows = await db.selectDistinct({ region: schema.bookings.region }).from(schema.bookings).where(eq(schema.bookings.companyId, cid));
    const regions = regionRows.map((r) => r.region).filter(Boolean).sort();
    return c.json({
      services,
      technicians,
      tags,
      regions,
      statuses: ["pending", "confirmed", "assigned", "enroute", "arrived", "in_progress", "completed", "cancelled"],
      priorities: ["low", "normal", "high", "urgent"],
      paymentStatuses: ["unpaid", "paid", "refunded"],
      columns: JOB_COLUMNS,
    }, 200);
  })

  // paginated, filtered search
  .get("/search", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isStaff(u)) return c.json({ message: "Forbidden" }, 403);
    const f = parseFilters(c);
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const pageSize = Math.min(200, Math.max(5, Number(c.req.query("pageSize")) || 25));
    const sortKey = c.req.query("sort") || "scheduledAt";
    const dir = c.req.query("dir") === "asc" ? asc : desc;
    const sortMap: Record<string, any> = {
      scheduledAt: schema.bookings.scheduledAt,
      createdAt: schema.bookings.createdAt,
      completedAt: schema.bookings.finishedAt,
      total: schema.bookings.total,
      status: schema.bookings.status,
      priority: schema.bookings.priority,
    };
    const orderCol = sortMap[sortKey] ?? schema.bookings.scheduledAt;

    const cid = tenantId(c);
    const conds = await buildWhere(f, cid);
    const whereExpr = conds.length ? and(...conds) : undefined;

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.bookings)
      .where(whereExpr as any);

    const rows = await db
      .select()
      .from(schema.bookings)
      .where(whereExpr as any)
      .orderBy(dir(orderCol))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const enriched = await enrichRows(rows);
    return c.json({ jobs: enriched, total: Number(count), page, pageSize, pages: Math.ceil(Number(count) / pageSize) }, 200);
  })

  // export filtered results: ?format=csv|json|pdf&columns=a,b,c (omit columns = summary set)
  .get("/export", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isStaff(u)) return c.json({ message: "Forbidden" }, 403);
    const f = parseFilters(c);
    const format = (c.req.query("format") || "csv").toLowerCase();
    const colsParam = c.req.query("columns");
    const pickedKeys = colsParam ? colsParam.split(",").map((s) => s.trim()).filter((k) => COL_BY_KEY[k]) : JOB_COLUMNS.filter((c) => c.group === "summary").map((c) => c.key);
    const cols = pickedKeys.map((k) => COL_BY_KEY[k]);

    const cid = tenantId(c);
    const conds = await buildWhere(f, cid);
    const whereExpr = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(schema.bookings).where(whereExpr as any).orderBy(desc(schema.bookings.scheduledAt)).limit(10000);
    const enriched = await enrichRows(rows);

    await logExport(cid, u, format, enriched.length, f, pickedKeys);
    const stamp = Date.now();
    const title = "Work Orders";
    const subtitle = `${enriched.length} jobs · exported ${new Date().toLocaleString("en-CA")}`;

    if (format === "json") {
      const slim = enriched.map((r: any) => Object.fromEntries(pickedKeys.map((k) => [k, r[k]])));
      return fileResponse(JSON.stringify(slim, null, 2), `nvc360-jobs-${stamp}.json`, "application/json");
    }
    if (format === "pdf") {
      const fmtRows = enriched.map((r: any) => {
        const o: any = {};
        for (const col of cols) {
          let v = r[col.key];
          if (col.kind === "date" && v) v = new Date(v).toLocaleString("en-CA");
          o[col.key] = v;
        }
        return o;
      });
      const buf = await toPdf(fmtRows, cols, title, subtitle);
      return fileResponse(buf, `nvc360-jobs-${stamp}.pdf`, "application/pdf");
    }
    // csv (default)
    const csvRows = enriched.map((r: any) => {
      const o: any = {};
      for (const col of cols) {
        let v = r[col.key];
        if (col.kind === "date" && v) v = new Date(v).toISOString();
        o[col.label] = v ?? "";
      }
      return o;
    });
    const csv = toCsv(csvRows, cols.map((c) => c.label));
    return fileResponse(csv, `nvc360-jobs-${stamp}.csv`, "text/csv; charset=utf-8");
  })

  // single-job full detail export (all fields) — for the per-job detail option
  .get("/:id/export", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isStaff(u)) return c.json({ message: "Forbidden" }, 403);
    const id = c.req.param("id");
    const format = (c.req.query("format") || "pdf").toLowerCase();
    const [b] = await db.select().from(schema.bookings).where(and(eq(schema.bookings.id, id), eq(schema.bookings.companyId, tenantId(c))));
    if (!b) return c.json({ message: "Not found" }, 404);
    const [enriched] = await enrichRows([b]);
    await logExport(tenantId(c), u, format, 1, { jobId: id }, JOB_COLUMNS.map((c) => c.key));
    const stamp = Date.now();

    if (format === "json") {
      return fileResponse(JSON.stringify({ ...enriched, raw: b }, null, 2), `nvc360-job-${jobNumber(b.id)}-${stamp}.json`, "application/json");
    }
    // PDF: vertical label/value sheet (one column = label, one = value)
    const rows = JOB_COLUMNS.map((col) => {
      let v: any = (enriched as any)[col.key];
      if (col.kind === "date" && v) v = new Date(v).toLocaleString("en-CA");
      if (col.kind === "money" && v != null) v = `$${Number(v).toFixed(2)}`;
      return { field: col.label, value: v ?? "" };
    });
    // parse ad-hoc per-unit line items (kind === "unit") for the internal pay breakdown
    let unitLines: JobUnitLine[] = [];
    try {
      const li = JSON.parse(b.lineItems || "[]");
      if (Array.isArray(li)) {
        unitLines = li
          .filter((x: any) => x && x.kind === "unit")
          .map((x: any) => ({
            name: String(x.name ?? "Item"),
            unit: String(x.unit ?? ""),
            qty: Number(x.qty ?? 0),
            unitPrice: Number(x.unitPrice ?? 0),
            unitCost: Number(x.unitCost ?? 0),
            price: Number(x.price ?? 0),
            cost: Number(x.cost ?? 0),
          }));
      }
    } catch { /* ignore malformed lineItems */ }

    // Fetch job photos for the PDF
    let jobPhotos: JobPhoto[] = [];
    try {
      const photoRows = await db.select().from(schema.jobPhotos).where(eq(schema.jobPhotos.bookingId, id));
      jobPhotos = photoRows.map((p: any) => ({ url: p.url, caption: p.caption ?? "" }));
    } catch { /* skip photos if query fails */ }

    // Tenant branding (logo + name + color) for the PDF header, and the raw
    // GPS route for a simple graphical route diagram.
    const brandRow = await db.select().from(schema.companySettings).where(eq(schema.companySettings.companyId, tenantId(c))).then((r) => r[0]).catch(() => null);
    const brand = brandRow ? { name: brandRow.name, logo: brandRow.logo, brandColor: brandRow.brandColor } : null;
    let route: { lat: number; lng: number; phase: string }[] = [];
    try {
      const pingRows = await db.select().from(schema.trackingPings).where(eq(schema.trackingPings.bookingId, id));
      pingRows.sort((x, y) => Number(x.createdAt) - Number(y.createdAt));
      route = pingRows.map((p) => ({ lat: p.lat, lng: p.lng, phase: p.phase }));
    } catch { /* skip route if query fails */ }

    const baseUrl = new URL(c.req.url).origin;
    const buf = await buildJobPdf(rows, unitLines, `Job ${jobNumber(b.id)} — ${enriched.customerName}`, enriched.address, jobPhotos, brand, route, baseUrl);
    return fileResponse(buf, `nvc360-job-${jobNumber(b.id)}-${stamp}.pdf`, "application/pdf");
  })

  // Consolidated read-only report for the completed-job report page: every
  // field the report needs in one call (times, mileage, route breadcrumbs,
  // photos, line-item + tech-pay breakdown) instead of the report page
  // stitching together several separate requests.
  .get("/:id/report", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isStaff(u)) return c.json({ message: "Forbidden" }, 403);
    const id = c.req.param("id");
    const b = await db.select().from(schema.bookings).where(and(eq(schema.bookings.id, id), eq(schema.bookings.companyId, tenantId(c)))).then((r) => r[0]);
    if (!b) return c.json({ message: "Not found" }, 404);

    const svc = b.serviceId ? await db.select().from(schema.services).where(eq(schema.services.id, b.serviceId)).then((r) => r[0]) : null;
    const cust = b.customerId ? await db.select().from(schema.user).where(eq(schema.user.id, b.customerId)).then((r) => r[0]) : null;
    let rider: any = null;
    if (b.riderId) {
      const rp = await db.select().from(schema.riders).where(eq(schema.riders.id, b.riderId)).then((r) => r[0]);
      if (rp) {
        const ru = await db.select().from(schema.user).where(eq(schema.user.id, rp.userId)).then((r) => r[0]);
        rider = { id: rp.id, name: ru?.name, phone: ru?.phone, photoUrl: rp.photoUrl, vehicle: rp.vehicle };
      }
    }

    const photoRows = await db.select().from(schema.jobPhotos).where(eq(schema.jobPhotos.bookingId, id));
    photoRows.sort((x, y) => Number(x.createdAt) - Number(y.createdAt));

    const pingRows = await db.select().from(schema.trackingPings).where(eq(schema.trackingPings.bookingId, id));
    pingRows.sort((x, y) => Number(x.createdAt) - Number(y.createdAt));

    let lineItems: any[] = [];
    try {
      const li = JSON.parse(b.lineItems || "[]");
      if (Array.isArray(li)) lineItems = li;
    } catch { /* ignore malformed lineItems */ }

    return c.json(
      {
        id: b.id,
        jobNumber: jobNumber(b.id),
        title: b.title,
        status: b.status,
        priority: b.priority,
        service: svc?.name ?? "",
        address: b.address,
        region: b.region,
        lat: b.lat ?? null,
        lng: b.lng ?? null,
        notes: b.notes,
        customer: cust ? { id: cust.id, name: cust.name, phone: b.customerPhone || cust.phone, email: cust.email } : null,
        technician: rider,
        timeline: {
          scheduledAt: b.scheduledAt,
          assignedAt: b.assignedAt,
          acceptedAt: b.acceptedAt,
          enrouteAt: b.enrouteAt,
          startedAt: b.startedAt,
          finishedAt: b.finishedAt,
          createdAt: b.createdAt,
        },
        transitMinutes: b.transitMinutes,
        onSiteMinutes: b.onSiteMinutes,
        mileageKm: b.mileageKm,
        route: pingRows.map((p) => ({ lat: p.lat, lng: p.lng, phase: p.phase, createdAt: p.createdAt })),
        photos: photoRows.map((p) => ({ id: p.id, url: p.url, caption: p.caption, createdAt: p.createdAt })),
        pricing: {
          lineItems,
          subtotal: b.subtotal,
          taxAmount: b.taxAmount,
          taxLabel: b.taxLabel,
          total: b.total || b.price,
          paymentStatus: b.paymentStatus,
          lineItemsCost: b.lineItemsCost,
          lineItemsPrice: b.lineItemsPrice,
        },
        techPay: {
          total: b.techPay,
          breakdown: (() => {
            try { return JSON.parse(b.techPayBreakdown || "null"); } catch { return null; }
          })(),
        },
      },
      200,
    );
  })

  // soft-delete (archive) a job — never lose data
  .delete("/:id", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isStaff(u)) return c.json({ message: "Forbidden" }, 403);
    const id = c.req.param("id");
    const cid = tenantId(c);
    await db.update(schema.bookings).set({ deletedAt: new Date() }).where(and(eq(schema.bookings.id, id), eq(schema.bookings.companyId, cid)));
    await db.insert(schema.auditLog).values({
      companyId: cid,
      actorId: u.id, actorName: u.name || u.email, action: "delete",
      entityType: "booking", entityId: id, summary: "Archived (soft-deleted) work order", meta: "{}",
    });
    return c.json({ ok: true }, 200);
  })

  // restore a soft-deleted job
  .post("/:id/restore", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isStaff(u)) return c.json({ message: "Forbidden" }, 403);
    const id = c.req.param("id");
    const cid = tenantId(c);
    await db.update(schema.bookings).set({ deletedAt: null }).where(and(eq(schema.bookings.id, id), eq(schema.bookings.companyId, cid)));
    await db.insert(schema.auditLog).values({
      companyId: cid,
      actorId: u.id, actorName: u.name || u.email, action: "update",
      entityType: "booking", entityId: id, summary: "Restored archived work order", meta: "{}",
    });
    return c.json({ ok: true }, 200);
  });
