import type { AppEnv } from "../env";
/**
 * Office queue for customer-initiated appointment changes.
 *
 * A cancellation only becomes real here, by an admin decision — see
 * services/change-requests.ts for why (nothing leaves the dispatch board on its
 * own) and shared/change-policy.ts for what a customer is allowed to ask for.
 */
import { Hono } from "hono";
import { requireAdmin, tenantId } from "../middleware/auth";
import { jsonBody, longText } from "../lib/validate";
import { audit } from "../lib/audit";
import { z } from "zod";
import {
  listRequests,
  pendingRequestCount,
  approveRequest,
  declineRequest,
} from "../../services/change-requests";

type SessionUser = { id: string; name?: string };

const DecisionBody = z.object({ note: longText(2_000).optional().default("") });
const STATUSES = ["pending", "approved", "declined", "applied", "withdrawn"] as const;

export const changeRequestsRoutes = new Hono<AppEnv>()
  .get("/", requireAdmin, async (c) => {
    const raw = (c.req.query("status") || "").trim();
    // An unknown status silently returning everything looks like a broken filter;
    // reject it instead.
    if (raw && !STATUSES.includes(raw as (typeof STATUSES)[number]))
      return c.json({ message: `Unknown status "${raw}"` }, 422);
    const co = tenantId(c);
    const [requests, pending] = await Promise.all([
      listRequests(co, raw || undefined),
      pendingRequestCount(co),
    ]);
    return c.json({ requests, pendingCount: pending }, 200);
  })
  .get("/count", requireAdmin, async (c) => {
    return c.json({ pendingCount: await pendingRequestCount(tenantId(c)) }, 200);
  })
  .post("/:id/approve", requireAdmin, jsonBody(DecisionBody), async (c) => {
    const co = tenantId(c);
    const u = c.get("user") as SessionUser;
    const { note } = c.req.valid("json");
    const r = await approveRequest({
      companyId: co,
      requestId: c.req.param("id"),
      note: note ?? "",
      actorId: u.id,
      actorName: u.name ?? "",
    });
    if (!r.ok)
      return c.json(
        { message: r.message },
        r.code === "not_found" ? 404 : r.code === "invalid" ? 422 : 409,
      );
    await audit({
      actorId: u.id,
      actorName: u.name,
      companyId: co,
      action: "update",
      entityType: "change_request",
      entityId: r.request.id,
      summary: `Approved ${r.request.kind} request on work order ${r.request.bookingId.slice(0, 6).toUpperCase()}`,
      meta: { kind: r.request.kind, bookingId: r.request.bookingId },
    });
    return c.json({ request: r.request }, 200);
  })
  .post("/:id/decline", requireAdmin, jsonBody(DecisionBody), async (c) => {
    const co = tenantId(c);
    const u = c.get("user") as SessionUser;
    const { note } = c.req.valid("json");
    const r = await declineRequest({
      companyId: co,
      requestId: c.req.param("id"),
      note: note ?? "",
      actorId: u.id,
      actorName: u.name ?? "",
    });
    if (!r.ok) return c.json({ message: r.message }, r.code === "not_found" ? 404 : 409);
    await audit({
      actorId: u.id,
      actorName: u.name,
      companyId: co,
      action: "update",
      entityType: "change_request",
      entityId: r.request.id,
      summary: `Declined ${r.request.kind} request on work order ${r.request.bookingId.slice(0, 6).toUpperCase()}`,
      meta: { kind: r.request.kind, bookingId: r.request.bookingId },
    });
    return c.json({ request: r.request }, 200);
  });
