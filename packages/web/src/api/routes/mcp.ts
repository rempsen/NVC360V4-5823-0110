import { Hono } from "hono";
import { db } from "../database";
import { tdb, type TenantDb } from "../database/tenant";
import * as schema from "../database/schema";
import { eq, and, gte, lte, like } from "drizzle-orm";
import { resolveApiKey, scopeAllows, type ApiKeyContext } from "../middleware/auth";
import { audit } from "../lib/audit";
import { attachMembership } from "../lib/memberships";
import { user as userTable } from "../database/auth-schema";

/**
 * Remote MCP server (streamable HTTP / JSON-RPC 2.0).
 *
 * Implements the Model Context Protocol over a single HTTP endpoint so external
 * agents (Claude Code, Claude Desktop, custom clients) can discover and call
 * tools backed by the NVC360 database. Auth is via API-key Bearer token; each
 * tool declares a required scope which is checked against the key's grants.
 *
 * Protocol surface implemented: initialize, tools/list, tools/call, ping.
 */

const SERVER_INFO = { name: "nvc360-mcp", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";

type ToolDef = {
  name: string;
  description: string;
  scope: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, any>, t: TenantDb) => Promise<unknown>;
};

const num = (v: unknown, d?: number) =>
  v === undefined || v === null || v === "" ? d : Number(v);

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const TOOLS: ToolDef[] = [
  // -------------------- Work orders --------------------
  {
    name: "list_work_orders",
    description:
      "List work orders / jobs. Optional filters: status, riderId (tech), priority, search (matches title/address), limit (default 50), since/until ISO date on scheduledAt.",
    scope: "workorders:read",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "pending|confirmed|assigned|enroute|arrived|in_progress|completed|cancelled" },
        riderId: { type: "string" },
        priority: { type: "string", description: "low|normal|high|urgent" },
        search: { type: "string" },
        since: { type: "string", description: "ISO date — scheduledAt >= " },
        until: { type: "string", description: "ISO date — scheduledAt <= " },
        limit: { type: "number" },
      },
    },
    handler: async (a, t) => {
      const conds = [] as any[];
      if (a.status) conds.push(eq(schema.bookings.status, String(a.status)));
      if (a.riderId) conds.push(eq(schema.bookings.riderId, String(a.riderId)));
      if (a.priority) conds.push(eq(schema.bookings.priority, String(a.priority)));
      if (a.search) conds.push(like(schema.bookings.title, `%${a.search}%`));
      if (a.since) conds.push(gte(schema.bookings.scheduledAt, new Date(a.since)));
      if (a.until) conds.push(lte(schema.bookings.scheduledAt, new Date(a.until)));
      const limit = Math.min(num(a.limit, 50)!, 200);
      const all = await t.select(schema.bookings, conds.length ? and(...conds) : undefined);
      const rows = all
        .sort((x, y) => (y.scheduledAt?.getTime() ?? 0) - (x.scheduledAt?.getTime() ?? 0))
        .slice(0, limit);
      return { count: rows.length, workOrders: rows };
    },
  },
  {
    name: "get_work_order",
    description: "Get a single work order by id, including line items, field data, photos, and reviews.",
    scope: "workorders:read",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: async (a, t) => {
      const wo = await t.selectOne(schema.bookings, eq(schema.bookings.id, String(a.id)));
      if (!wo) throw new Error("work order not found");
      const photos = await t.select(schema.jobPhotos, eq(schema.jobPhotos.bookingId, wo.id));
      const msgs = await t.select(schema.messages, eq(schema.messages.bookingId, wo.id));
      return { workOrder: wo, photos, messages: msgs };
    },
  },
  {
    name: "create_work_order",
    description:
      "Create a work order. Required: customerId, serviceId, scheduledAt (ISO), address. Optional: title, priority, notes, riderId, lat, lng, price.",
    scope: "workorders:write",
    inputSchema: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        serviceId: { type: "string" },
        scheduledAt: { type: "string", description: "ISO datetime" },
        address: { type: "string" },
        title: { type: "string" },
        priority: { type: "string" },
        notes: { type: "string" },
        riderId: { type: "string" },
        lat: { type: "number" },
        lng: { type: "number" },
        price: { type: "number" },
      },
      required: ["customerId", "serviceId", "scheduledAt", "address"],
    },
    handler: async (a, t) => {
      const [wo] = await t.insert(schema.bookings, {
        customerId: String(a.customerId),
        serviceId: String(a.serviceId),
        scheduledAt: new Date(a.scheduledAt),
        address: String(a.address),
        title: a.title ?? "",
        priority: a.priority ?? "normal",
        notes: a.notes ?? "",
        riderId: a.riderId ?? null,
        lat: num(a.lat, 43.6532)!,
        lng: num(a.lng, -79.3832)!,
        price: num(a.price, 0)!,
        status: a.riderId ? "assigned" : "pending",
      });
      await audit({ companyId: t.companyId, actorName: "API/MCP", action: "create", entityType: "booking", entityId: wo.id, summary: `Created work order via MCP "${wo.title || wo.id}"` });
      return { workOrder: wo };
    },
  },
  {
    name: "update_work_order",
    description: "Update a work order by id. Provide any subset of: status, priority, notes, scheduledAt (ISO), address, title, price.",
    scope: "workorders:write",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
        notes: { type: "string" },
        scheduledAt: { type: "string" },
        address: { type: "string" },
        title: { type: "string" },
        price: { type: "number" },
      },
      required: ["id"],
    },
    handler: async (a, t) => {
      const patch: Record<string, unknown> = {};
      for (const k of ["status", "priority", "notes", "address", "title"]) if (k in a) patch[k] = a[k];
      if ("scheduledAt" in a) patch.scheduledAt = new Date(a.scheduledAt);
      if ("price" in a) patch.price = num(a.price);
      const [wo] = await t.update(schema.bookings, patch as any, eq(schema.bookings.id, String(a.id)));
      if (!wo) throw new Error("work order not found");
      await audit({ companyId: t.companyId, actorName: "API/MCP", action: "update", entityType: "booking", entityId: wo.id, summary: `Updated work order via MCP` });
      return { workOrder: wo };
    },
  },
  {
    name: "assign_work_order",
    description: "Assign or reassign a work order to a technician. Args: id (work order), riderId (technician).",
    scope: "workorders:assign",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, riderId: { type: "string" } },
      required: ["id", "riderId"],
    },
    handler: async (a, t) => {
      const [wo] = await t.update(
        schema.bookings,
        { riderId: String(a.riderId), status: "assigned", assignStatus: "offered", assignedAt: new Date() } as any,
        eq(schema.bookings.id, String(a.id)),
      );
      if (!wo) throw new Error("work order not found");
      await audit({ companyId: t.companyId, actorName: "API/MCP", action: "assign", entityType: "booking", entityId: wo.id, summary: `Assigned work order to ${a.riderId} via MCP` });
      return { workOrder: wo };
    },
  },

  // -------------------- Technicians --------------------
  {
    name: "list_technicians",
    description: "List technicians with status, location, skill class, rating. Optional filter: status, skillClass.",
    scope: "techs:read",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string" }, skillClass: { type: "string" } },
    },
    handler: async (a, t) => {
      const conds = [] as any[];
      if (a.status) conds.push(eq(schema.riders.status, String(a.status)));
      if (a.skillClass) conds.push(eq(schema.riders.skillClass, String(a.skillClass)));
      const rows = await db
        .select({
          id: schema.riders.id,
          userId: schema.riders.userId,
          name: userTable.name,
          email: userTable.email,
          phone: schema.riders.phone,
          status: schema.riders.status,
          skillClass: schema.riders.skillClass,
          skills: schema.riders.skills,
          rating: schema.riders.rating,
          completedJobs: schema.riders.completedJobs,
          lat: schema.riders.lat,
          lng: schema.riders.lng,
          locationUpdatedAt: schema.riders.locationUpdatedAt,
          approval: schema.riders.approval,
        })
        .from(schema.riders)
        .leftJoin(userTable, eq(schema.riders.userId, userTable.id))
        .where(t.scope(schema.riders, conds.length ? and(...conds) : undefined));
      return { count: rows.length, technicians: rows };
    },
  },

  // -------------------- Clients --------------------
  {
    name: "list_clients",
    description: "List clients (customers). Optional: search (name/email), limit.",
    scope: "clients:read",
    inputSchema: {
      type: "object",
      properties: { search: { type: "string" }, limit: { type: "number" } },
    },
    handler: async (a, t) => {
      const conds = [eq(userTable.role, "customer"), eq(userTable.companyId, t.companyId)] as any[];
      if (a.search) conds.push(like(userTable.name, `%${a.search}%`));
      const rows = await db
        .select({ id: userTable.id, name: userTable.name, email: userTable.email, phone: userTable.phone, address: userTable.address, createdAt: userTable.createdAt })
        .from(userTable)
        .where(and(...conds))
        .limit(Math.min(num(a.limit, 50)!, 200));
      return { count: rows.length, clients: rows };
    },
  },
  {
    name: "get_client",
    description: "Get a client by id with their work order history.",
    scope: "clients:read",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (a, t) => {
      const [client] = await db
        .select()
        .from(userTable)
        .where(and(eq(userTable.id, String(a.id)), eq(userTable.companyId, t.companyId)))
        .limit(1);
      if (!client) throw new Error("client not found");
      const jobs = (await t.select(schema.bookings, eq(schema.bookings.customerId, client.id))).sort(
        (x, y) => (y.scheduledAt?.getTime() ?? 0) - (x.scheduledAt?.getTime() ?? 0),
      );
      return { client, workOrders: jobs };
    },
  },
  {
    name: "create_client",
    description: "Create a client. Required: name, email. Optional: phone, address.",
    scope: "clients:write",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, address: { type: "string" } },
      required: ["name", "email"],
    },
    handler: async (a, t) => {
      const [client] = await db
        .insert(userTable)
        .values({ id: crypto.randomUUID(), companyId: t.companyId, name: String(a.name), email: String(a.email), phone: a.phone ?? null, address: a.address ?? null, role: "customer", emailVerified: false, createdAt: new Date(), updatedAt: new Date() } as any)
        .returning();
      // Clients are scoped by membership now — without this row the client
      // would not appear on this company's client list.
      await attachMembership({ userId: client.id, companyId: t.companyId, role: "customer", status: "active" });
      await audit({ companyId: t.companyId, actorName: "API/MCP", action: "create", entityType: "client", entityId: client.id, summary: `Created client via MCP "${client.name}"` });
      return { client };
    },
  },
  {
    name: "update_client",
    description: "Update a client by id. Provide any subset of: name, email, phone, address.",
    scope: "clients:write",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, address: { type: "string" } },
      required: ["id"],
    },
    handler: async (a, t) => {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      for (const k of ["name", "email", "phone", "address"]) if (k in a) patch[k] = a[k];
      const [client] = await db
        .update(userTable)
        .set(patch)
        .where(and(eq(userTable.id, String(a.id)), eq(userTable.companyId, t.companyId)))
        .returning();
      if (!client) throw new Error("client not found");
      await audit({ companyId: t.companyId, actorName: "API/MCP", action: "update", entityType: "client", entityId: client.id, summary: `Updated client via MCP` });
      return { client };
    },
  },

  // -------------------- Catalog --------------------
  {
    name: "list_catalog",
    description: "List catalog & pricing items (services, products, assemblies). Optional: kind, category, search.",
    scope: "catalog:read",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string" }, category: { type: "string" }, search: { type: "string" } },
    },
    handler: async (a, t) => {
      const conds = [] as any[];
      if (a.kind) conds.push(eq(schema.catalogItems.kind, String(a.kind)));
      if (a.category) conds.push(eq(schema.catalogItems.category, String(a.category)));
      if (a.search) conds.push(like(schema.catalogItems.name, `%${a.search}%`));
      const rows = await t.select(schema.catalogItems, conds.length ? and(...conds) : undefined);
      return { count: rows.length, items: rows };
    },
  },

  // -------------------- Reports / analytics --------------------
  {
    name: "get_revenue_report",
    description: "Aggregate revenue & job metrics over a window. Optional: since/until ISO. Returns totals, completed count, avg ticket.",
    scope: "reports:read",
    inputSchema: {
      type: "object",
      properties: { since: { type: "string" }, until: { type: "string" } },
    },
    handler: async (a, t) => {
      const conds = [] as any[];
      if (a.since) conds.push(gte(schema.bookings.scheduledAt, new Date(a.since)));
      if (a.until) conds.push(lte(schema.bookings.scheduledAt, new Date(a.until)));
      const rows = await t.select(schema.bookings, conds.length ? and(...conds) : undefined);
      const completed = rows.filter((r) => r.status === "completed");
      const revenue = completed.reduce((s, r) => s + (r.total || r.price || 0), 0);
      const byStatus: Record<string, number> = {};
      for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      return {
        window: { since: a.since ?? null, until: a.until ?? null },
        totalJobs: rows.length,
        completedJobs: completed.length,
        revenue: Math.round(revenue * 100) / 100,
        avgTicket: completed.length ? Math.round((revenue / completed.length) * 100) / 100 : 0,
        byStatus,
      };
    },
  },
  {
    name: "get_tech_performance",
    description: "Per-technician performance: completed jobs, rating, revenue generated. Optional window since/until.",
    scope: "reports:read",
    inputSchema: {
      type: "object",
      properties: { since: { type: "string" }, until: { type: "string" } },
    },
    handler: async (a, t) => {
      const conds = [eq(schema.bookings.status, "completed")] as any[];
      if (a.since) conds.push(gte(schema.bookings.scheduledAt, new Date(a.since)));
      if (a.until) conds.push(lte(schema.bookings.scheduledAt, new Date(a.until)));
      const jobs = await t.select(schema.bookings, and(...conds));
      const techs = await db
        .select({ id: schema.riders.id, name: userTable.name, rating: schema.riders.rating })
        .from(schema.riders)
        .leftJoin(userTable, eq(schema.riders.userId, userTable.id))
        .where(t.scope(schema.riders));
      const stats = techs.map((t) => {
        const mine = jobs.filter((j) => j.riderId === t.id);
        return {
          riderId: t.id,
          name: t.name,
          rating: t.rating,
          completedJobs: mine.length,
          revenue: Math.round(mine.reduce((s, j) => s + (j.total || j.price || 0), 0) * 100) / 100,
        };
      });
      return { technicians: stats.sort((x, y) => y.revenue - x.revenue) };
    },
  },

  // -------------------- Reviews --------------------
  {
    name: "list_reviews",
    description: "List customer reviews. Optional: riderId, minRating, limit.",
    scope: "reviews:read",
    inputSchema: {
      type: "object",
      properties: { riderId: { type: "string" }, minRating: { type: "number" }, limit: { type: "number" } },
    },
    handler: async (a, t) => {
      const conds = [] as any[];
      if (a.riderId) conds.push(eq(schema.reviews.riderId, String(a.riderId)));
      if (a.minRating) conds.push(gte(schema.reviews.rating, Number(a.minRating)));
      const limit = Math.min(num(a.limit, 50)!, 200);
      const rows = (await t.select(schema.reviews, conds.length ? and(...conds) : undefined))
        .sort((x, y) => (y.createdAt?.getTime() ?? 0) - (x.createdAt?.getTime() ?? 0))
        .slice(0, limit);
      return { count: rows.length, reviews: rows };
    },
  },

  // -------------------- Service zones --------------------
  {
    name: "list_zones",
    description: "List service zones with surge multipliers and polygons.",
    scope: "zones:read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_a, t) => {
      const rows = await t.select(schema.serviceZones);
      return { count: rows.length, zones: rows.map((z) => ({ ...z, polygon: JSON.parse(z.polygon || "[]") })) };
    },
  },
  {
    name: "create_zone",
    description: "Create a service zone. Required: name. Optional: color, surgeMultiplier, polygon (array of [lat,lng]).",
    scope: "zones:write",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, color: { type: "string" }, surgeMultiplier: { type: "number" }, polygon: { type: "array" } },
      required: ["name"],
    },
    handler: async (a, t) => {
      const [zone] = await t.insert(schema.serviceZones, {
        name: String(a.name),
        color: a.color || "#06B6D4",
        polygon: JSON.stringify(a.polygon ?? []),
        surgeMultiplier: num(a.surgeMultiplier, 1)!,
        active: true,
      });
      await audit({ companyId: t.companyId, actorName: "API/MCP", action: "create", entityType: "service_zone", entityId: zone.id, summary: `Created zone via MCP "${zone.name}"` });
      return { zone: { ...zone, polygon: JSON.parse(zone.polygon) } };
    },
  },

  // -------------------- Photos / media --------------------
  {
    name: "list_job_photos",
    description: "List job photos. Optional: bookingId (work order). Returns urls + captions.",
    scope: "photos:read",
    inputSchema: { type: "object", properties: { bookingId: { type: "string" }, limit: { type: "number" } } },
    handler: async (a, t) => {
      const limit = Math.min(num(a.limit, 100)!, 500);
      const rows = (await t.select(schema.jobPhotos, a.bookingId ? eq(schema.jobPhotos.bookingId, String(a.bookingId)) : undefined))
        .sort((x, y) => (y.createdAt?.getTime() ?? 0) - (x.createdAt?.getTime() ?? 0))
        .slice(0, limit);
      return { count: rows.length, photos: rows };
    },
  },

  // -------------------- Logs --------------------
  {
    name: "list_audit_logs",
    description: "Read audit logs (all actions across the system). Optional: entityType, action, limit.",
    scope: "logs:read",
    inputSchema: {
      type: "object",
      properties: { entityType: { type: "string" }, action: { type: "string" }, limit: { type: "number" } },
    },
    handler: async (a, t) => {
      const conds = [] as any[];
      if (a.entityType) conds.push(eq(schema.auditLog.entityType, String(a.entityType)));
      if (a.action) conds.push(eq(schema.auditLog.action, String(a.action)));
      const limit = Math.min(num(a.limit, 100)!, 500);
      const rows = (await t.select(schema.auditLog, conds.length ? and(...conds) : undefined))
        .sort((x, y) => (y.createdAt?.getTime() ?? 0) - (x.createdAt?.getTime() ?? 0))
        .slice(0, limit);
      return { count: rows.length, logs: rows };
    },
  },

  // -------------------- Comms --------------------
  {
    name: "send_message",
    description:
      "Send a message into a work-order thread or directly to a technician. Provide bookingId OR riderId, plus body. Optional: senderName.",
    scope: "messages:write",
    inputSchema: {
      type: "object",
      properties: { bookingId: { type: "string" }, riderId: { type: "string" }, body: { type: "string" }, senderName: { type: "string" } },
      required: ["body"],
    },
    handler: async (a, t) => {
      if (!a.bookingId && !a.riderId) throw new Error("bookingId or riderId required");
      const [msg] = await t.insert(schema.messages, {
        bookingId: a.bookingId ?? null,
        riderId: a.riderId ?? null,
        senderRole: "dispatch",
        senderName: a.senderName || "API/MCP",
        body: String(a.body),
        channel: "app",
      });
      return { message: msg };
    },
  },

  // -------------------- Export --------------------
  {
    name: "export_data",
    description:
      "Export a full table for analysis. entity: work_orders | clients | technicians | reviews | catalog | invoices | audit_logs | job_photos. Optional limit (default 1000).",
    scope: "export:read",
    inputSchema: {
      type: "object",
      properties: { entity: { type: "string" }, limit: { type: "number" } },
      required: ["entity"],
    },
    handler: async (a, t) => {
      const limit = Math.min(num(a.limit, 1000)!, 5000);
      const map: Record<string, any> = {
        work_orders: schema.bookings,
        reviews: schema.reviews,
        catalog: schema.catalogItems,
        invoices: schema.invoices,
        audit_logs: schema.auditLog,
        job_photos: schema.jobPhotos,
      };
      if (a.entity === "clients") {
        const rows = await db
          .select()
          .from(userTable)
          .where(and(eq(userTable.role, "customer"), eq(userTable.companyId, t.companyId)))
          .limit(limit);
        return { entity: "clients", count: rows.length, rows };
      }
      if (a.entity === "technicians") {
        const rows = await db
          .select()
          .from(schema.riders)
          .leftJoin(userTable, eq(schema.riders.userId, userTable.id))
          .where(t.scope(schema.riders))
          .limit(limit);
        return { entity: "technicians", count: rows.length, rows };
      }
      const table = map[String(a.entity)];
      if (!table) throw new Error(`unknown entity "${a.entity}"`);
      const rows = (await t.select(table)).slice(0, limit);
      return { entity: a.entity, count: rows.length, rows };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

function rpcResult(id: any, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: any, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

async function handleRpc(req: RpcReq, key: ApiKeyContext) {
  const { id, method, params } = req;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
      });
    case "notifications/initialized":
    case "initialized":
      return null; // notification — no response
    case "ping":
      return rpcResult(id, {});
    case "tools/list": {
      const tools = TOOLS.filter((t) => scopeAllows(key.scopes, t.scope)).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return rpcResult(id, { tools });
    }
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
      if (!scopeAllows(key.scopes, tool.scope))
        return rpcResult(id, {
          isError: true,
          content: [{ type: "text", text: `Permission denied: this API key lacks the "${tool.scope}" scope.` }],
        });
      try {
        const out = await tool.handler(args, tdb(key.companyId));
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        });
      } catch (e: any) {
        return rpcResult(id, {
          isError: true,
          content: [{ type: "text", text: `Error: ${e?.message || String(e)}` }],
        });
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP route (streamable). POST = JSON-RPC. GET = info/SSE noop.
// ---------------------------------------------------------------------------

export const mcpRoutes = new Hono()
  .get("/", (c) =>
    c.json({
      server: SERVER_INFO,
      protocol: "mcp",
      transport: "streamable-http",
      description: "NVC360 remote MCP server. POST JSON-RPC 2.0 with Authorization: Bearer <nvc_ key>.",
      tools: TOOLS.length,
    }),
  )
  .post("/", async (c) => {
    const key = await resolveApiKey(c);
    if (!key)
      return c.json(rpcError(null, -32001, "Unauthorized: provide a valid API key as 'Authorization: Bearer nvc_...'"), 401);

    let body: RpcReq | RpcReq[];
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }

    // batch support
    if (Array.isArray(body)) {
      const out = [];
      for (const r of body) {
        const res = await handleRpc(r, key);
        if (res) out.push(res);
      }
      return c.json(out);
    }

    const res = await handleRpc(body, key);
    if (res === null) return c.body(null, 202); // notification ack
    return c.json(res);
  });

export { TOOLS as MCP_TOOLS };
