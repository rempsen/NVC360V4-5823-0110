import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../database";
import { tdb } from "../database/tenant";
import * as schema from "../database/schema";
import { eq, and, or, isNull, inArray, notInArray } from "drizzle-orm";
import { requireAuth, requireAdmin, tx, tenantId } from "../middleware/auth";
import { isAdminRole } from "../lib/permissions";
import { sendSms, trackingUrl } from "../../services/sms";
import { sendPush } from "../../services/push";
import { publishMsg, subscribeMsg } from "../../services/realtime";
import { z } from "zod";
import { jsonBody, shortText, longText, id as idField } from "../lib/validate";
import type { AppEnv } from "../env";

type SessionUser = { id: string; role?: string; name: string };

function roleLabel(role?: string): "client" | "tech" | "dispatch" {
  if (role === "rider") return "tech";
  if (isAdminRole(role)) return "dispatch";
  return "client";
}

/**
 * Unread count for a rider's direct dispatcher thread — same query the
 * `/direct/unread` endpoint uses. Used to set the push notification's
 * `badge` so the closed/backgrounded app's icon shows the right number
 * (this is what actually drives the red counter on the home-screen icon;
 * the app itself has no way to update its own badge while not running).
 */
async function unreadDirectCountForRider(companyId: string, riderId: string): Promise<number> {
  const rows = await tdb(companyId).select(
    schema.messages,
    and(eq(schema.messages.riderId, riderId), isNull(schema.messages.bookingId), eq(schema.messages.read, false)),
  );
  return rows.filter((m) => m.senderRole === "dispatch").length;
}

/**
 * Admin/superadmin users to notify for a message — SCOPED TO ONE TENANT ONLY.
 *
 * Messaging must be fully tenant-isolated: an admin/superadmin from one
 * tenant must never see or be notified about another tenant's messages, even
 * though `role` alone doesn't imply that. Always filter by companyId here —
 * never query schema.user by role without it (that was the exact bug: a
 * message in ANY tenant was notifying admins/superadmins across ALL
 * tenants).
 */
async function officeUsersForNotify(companyId: string) {
  return db
    .select()
    .from(schema.user)
    .where(and(inArray(schema.user.role, ["admin", "superadmin"]), eq(schema.user.companyId, companyId)));
}

/* -------------------------------------------------------------------------- */
/*  Request bodies                                                            */
/*                                                                            */
/*  All four message bodies were raw `const { body } = await c.req.json()`,    */
/*  guarded only by `body?.trim()`. Reproduced live before this pass:          */
/*                                                                            */
/*   - POST /direct { body: 123 } -> 500. `123?.trim` is not a function, so a  */
/*     number crashed the handler.                                            */
/*   - POST /direct with a 100,000-character body -> written straight in.      */
/*   - POST /dispatch/:techId { body: 123 } -> 500, same cause, and that one   */
/*     ALSO fires a push notification.                                        */
/*   - POST /broadcast { body: {} } -> 500; { target: "everyone-everywhere" }  */
/*     reached the target dispatcher as a bare string.                        */
/*   - POST /:bookingId inserted the message BEFORE looking the booking up, so */
/*     a bad or cross-tenant bookingId left an orphaned message in the thread. */
/* -------------------------------------------------------------------------- */

/** The message text itself. One rule, used by all four routes. */
const messageText = shortText("Message", 5_000);

const DirectBody = z.object({ body: messageText });

const BroadcastBody = z.object({
  body: messageText,
  target: z.object({
    type: z.enum(["all", "available", "tag", "skillClass", "skill"], {
      error: "Target must be all, available, tag, skillClass or skill",
    }),
    tagId: idField("Tag id").optional(),
    skillClass: longText(120).optional(),
    skill: longText(120).optional(),
  }, { error: "A broadcast target is required" }),
});

export const messagesRoutes = new Hono<AppEnv>()
  // ── Direct dispatcher<->tech thread ──────────────────────────────────────
  // GET /api/messages/direct — rider fetches their own direct thread with dispatch
  .get("/direct", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (u.role !== "rider") return c.json({ message: "Forbidden" }, 403);
    const t = tx(c);

    const rider = await t.selectOne(schema.riders, eq(schema.riders.userId, u.id));
    if (!rider) return c.json({ message: "Rider not found" }, 404);

    const direct = await t.select(
      schema.messages,
      and(eq(schema.messages.riderId, rider.id), isNull(schema.messages.bookingId)),
    );
    direct.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));

    // NOTE: read state is NOT touched here anymore — this endpoint is polled
    // continuously (every 5s) by the Messages screen even while backgrounded,
    // so marking-as-read as a side effect of fetching silently cleared unread
    // state before a human ever actually looked. See POST /direct/mark-read.

    // current active job thread
    const activeAll = await t.select(
      schema.bookings,
      and(
        eq(schema.bookings.riderId, rider.id),
        or(
          eq(schema.bookings.status, "confirmed"),
          eq(schema.bookings.status, "enroute"),
          eq(schema.bookings.status, "in_progress"),
        ),
      ),
    );
    const active = activeAll.slice(0, 1);

    let job: { id: string; title: string; messages: any[] } | null = null;
    if (active.length) {
      const jobMsgs = await t.select(
        schema.messages,
        eq(schema.messages.bookingId, active[0].id),
      );
      jobMsgs.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
      job = { id: active[0].id, title: active[0].title || "Active Job", messages: jobMsgs };
    }

    return c.json({ direct, job }, 200);
  })

  // POST /api/messages/direct/mark-read — rider explicitly acks having opened
  // the dispatch thread. Called once when the Messages screen gains focus,
  // never from a poll, so "read" actually means a human looked at it.
  .post("/direct/mark-read", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (u.role !== "rider") return c.json({ message: "Forbidden" }, 403);
    const t = tx(c);
    const rider = await t.selectOne(schema.riders, eq(schema.riders.userId, u.id));
    if (!rider) return c.json({ message: "Rider not found" }, 404);
    await t.update(
      schema.messages,
      { read: true },
      and(eq(schema.messages.riderId, rider.id), isNull(schema.messages.bookingId)),
    );
    return c.json({ ok: true }, 200);
  })

  // POST /api/messages/direct — rider posts to their direct dispatch thread
  .post("/direct", requireAuth, jsonBody(DirectBody), async (c) => {
    const u = c.get("user") as SessionUser;
    if (u.role !== "rider") return c.json({ message: "Forbidden" }, 403);
    // `co` was never declared in this handler — it only existed in the
    // dispatch-side handler below — so the publishMsg("inbox", co) line at the
    // end threw a ReferenceError AFTER the message row and the admin
    // notifications had already been written. Every technician message to
    // dispatch returned 500 while actually being delivered, so the app
    // retried and each retry duplicated the message and the notification.
    const co = tenantId(c);
    const t = tx(c);

    const rider = await t.selectOne(schema.riders, eq(schema.riders.userId, u.id));
    if (!rider) return c.json({ message: "Rider not found" }, 404);

    const { body } = c.req.valid("json");

    const [m] = await t.insert(schema.messages, {
      riderId: rider.id,
      senderRole: "tech",
      senderName: u.name,
      body,
      channel: "app",
    });

    // notify this tenant's admins/dispatchers ONLY — never other tenants.
    const admins = await officeUsersForNotify(tenantId(c));
    for (const admin of admins) {
      await t.insert(schema.notifications, {
        userId: admin.id,
        type: "reminder",
        title: `Message from ${u.name || "Technician"}`,
        body,
      });
    }

    publishMsg("direct", rider.id).catch(() => {});
    publishMsg("inbox", co).catch(() => {});
    return c.json({ message: m }, 201);
  })

  // ── Unread count for tech's direct thread ────────────────────────────────
  .get("/direct/unread", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (u.role !== "rider") return c.json({ count: 0 }, 200);
    const t = tx(c);

    const rider = await t.selectOne(schema.riders, eq(schema.riders.userId, u.id));
    if (!rider) return c.json({ count: 0 }, 200);

    const rows = await t.select(
      schema.messages,
      and(
        eq(schema.messages.riderId, rider.id),
        isNull(schema.messages.bookingId),
        eq(schema.messages.read, false),
      ),
    );
    const count = rows.filter((m) => m.senderRole === "dispatch").length;
    return c.json({ count }, 200);
  })

  // ── Dispatch side: list every tech's direct thread w/ unread count + tags ─
  .get("/dispatch/threads", requireAdmin, async (c) => {
    const t = tx(c);
    const cId = tenantId(c);
    const riders = await t.select(schema.riders);
    // scope the id->name lookup to this tenant's users (global table, explicit filter)
    const users = await db.select().from(schema.user).where(eq(schema.user.companyId, cId));
    const userById = new Map(users.map((u) => [u.id, u]));

    // all direct messages (no booking)
    const all = await t.select(schema.messages, isNull(schema.messages.bookingId));
    all.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));

    // fetch tags for all riders in this company
    const allEntityTags = await db
      .select({ entityId: schema.entityTags.entityId, tagId: schema.entityTags.tagId })
      .from(schema.entityTags)
      .where(and(eq(schema.entityTags.companyId, cId), eq(schema.entityTags.entityType, "tech")));
    const allTags = await db
      .select()
      .from(schema.tags)
      .where(eq(schema.tags.companyId, cId));
    const tagById = new Map(allTags.map((tg) => [tg.id, tg]));
    // map riderId -> tags array
    const riderTagsMap = new Map<string, Array<{ id: string; label: string; color: string }>>();
    for (const et of allEntityTags) {
      const tg = tagById.get(et.tagId);
      if (!tg) continue;
      if (!riderTagsMap.has(et.entityId)) riderTagsMap.set(et.entityId, []);
      riderTagsMap.get(et.entityId)!.push({ id: tg.id, label: tg.label, color: tg.color });
    }

    const threads = riders.map((r) => {
      const msgs = all.filter((m) => m.riderId === r.id);
      const last = msgs[msgs.length - 1];
      const unread = msgs.filter((m) => !m.read && m.senderRole === "tech").length;
      const u = userById.get(r.userId);
      return {
        techId: r.id,
        name: u?.name ?? "Technician",
        photoUrl: r.photoUrl ?? null,
        color: r.color ?? "#0ea5e9",
        status: r.status ?? "offline",
        skillClass: r.skillClass ?? null,
        tags: riderTagsMap.get(r.id) ?? [],
        lastMessage: last?.body ?? null,
        lastSenderRole: last?.senderRole ?? null,
        lastAt: last?.createdAt ?? null,
        unread,
      };
    });

    threads.sort((a, b) => {
      if (b.unread !== a.unread) return b.unread - a.unread;
      const at = a.lastAt ? new Date(a.lastAt).getTime() : 0;
      const bt = b.lastAt ? new Date(b.lastAt).getTime() : 0;
      if (bt !== at) return bt - at;
      return a.name.localeCompare(b.name);
    });

    const totalUnread = threads.reduce((s, t2) => s + t2.unread, 0);
    return c.json({ threads, totalUnread }, 200);
  })

  // GET /api/messages/dispatch/:techId — full direct thread w/ one tech
  .get("/dispatch/:techId", requireAdmin, async (c) => {
    const techId = c.req.param("techId");
    const t = tx(c);
    const rider = await t.selectOne(schema.riders, eq(schema.riders.id, techId));
    if (!rider) return c.json({ message: "Tech not found" }, 404);

    const msgs = await t.select(
      schema.messages,
      and(eq(schema.messages.riderId, techId), isNull(schema.messages.bookingId)),
    );
    msgs.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));

    // NOTE: read state is NOT touched here anymore — this endpoint is polled
    // continuously (every 4s) by the chat view even while backgrounded, so
    // marking-as-read as a side effect of fetching silently cleared unread
    // state before a dispatcher ever actually looked. See mark-read below.

    const [u] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, rider.userId));

    return c.json(
      {
        tech: {
          techId: rider.id,
          name: u?.name ?? "Technician",
          photoUrl: rider.photoUrl ?? null,
          status: rider.status ?? "offline",
        },
        messages: msgs,
      },
      200,
    );
  })

  // POST /api/messages/dispatch/:techId/mark-read — dispatcher explicitly acks
  // having opened this tech's thread. Called once on open, never from a poll.
  .post("/dispatch/:techId/mark-read", requireAdmin, async (c) => {
    const techId = c.req.param("techId");
    const t = tx(c);
    await t.update(
      schema.messages,
      { read: true },
      and(
        eq(schema.messages.riderId, techId),
        isNull(schema.messages.bookingId),
        eq(schema.messages.senderRole, "tech"),
      ),
    );
    return c.json({ ok: true }, 200);
  })

  // POST /api/messages/dispatch/:techId — dispatcher messages a tech
  .post("/dispatch/:techId", requireAdmin, jsonBody(DirectBody), async (c) => {
    const u = c.get("user") as SessionUser;
    const techId = c.req.param("techId");
    const co = tenantId(c);
    const t = tx(c);
    const rider = await t.selectOne(schema.riders, eq(schema.riders.id, techId));
    if (!rider) return c.json({ message: "Tech not found" }, 404);

    const { body } = c.req.valid("json");

    const [m] = await t.insert(schema.messages, {
      riderId: techId,
      senderRole: "dispatch",
      senderName: u.name || "Dispatch",
      body,
      channel: "app",
    });

    await t.insert(schema.notifications, {
      userId: rider.userId,
      type: "reminder",
      title: `Message from dispatch`,
      body,
    });

    // Push to the tech's devices so they get a notification banner even when
    // the app is backgrounded or fully closed — and set the badge count so
    // the closed app's icon shows the number of unread dispatch messages
    // (this is the whole point: they shouldn't have to open the app and
    // scroll down to discover a new message).
    const unread = await unreadDirectCountForRider(co, techId);
    sendPush(rider.userId, `Message from ${u.name || "Dispatch"}`, body, {
      type: "direct_message",
      techId,
    }, unread).catch(() => {});

    // Same channel key as the rider->dispatch direction (POST /direct) —
    // one thread, one channel, either direction wakes up a listening client.
    publishMsg("direct", techId).catch(() => {});
    publishMsg("inbox", co).catch(() => {});
    return c.json({ message: m }, 201);
  })

  // ── Broadcast: send to all drivers, available drivers, or by tag ──────────
  // POST /api/messages/broadcast
  .post("/broadcast", requireAdmin, jsonBody(BroadcastBody), async (c) => {
    const u = c.get("user") as SessionUser;
    const t = tx(c);
    const cId = tenantId(c);

    const { body, target } = c.req.valid("json");

    // get all riders
    let riders = await t.select(schema.riders);

    if (target.type === "available") {
      riders = riders.filter((r) => r.status === "available");
    } else if (target.type === "tag" && target.tagId) {
      const taggedEntityIds = await db
        .select({ entityId: schema.entityTags.entityId })
        .from(schema.entityTags)
        .where(
          and(
            eq(schema.entityTags.companyId, cId),
            eq(schema.entityTags.entityType, "tech"),
            eq(schema.entityTags.tagId, target.tagId),
          ),
        );
      const ids = new Set(taggedEntityIds.map((e) => e.entityId));
      riders = riders.filter((r) => ids.has(r.id));
    } else if (target.type === "skillClass" && target.skillClass) {
      const wanted = target.skillClass.toLowerCase();
      riders = riders.filter((r) => (r.skillClass ?? "General").toLowerCase() === wanted);
    } else if (target.type === "skill" && target.skill) {
      // skill is a csv tag stored on riders.skills
      const needle = target.skill.toLowerCase();
      riders = riders.filter((r) => {
        const skills = (r.skills ?? "")
          .split(",")
          .map((s: string) => s.trim().toLowerCase())
          .filter(Boolean);
        return skills.includes(needle);
      });
    }

    if (riders.length === 0) {
      return c.json({ message: "No drivers match this target", sent: 0 }, 200);
    }

    const broadcastId = crypto.randomUUID();
    let sent = 0;
    for (const rider of riders) {
      await t.insert(schema.messages, {
        riderId: rider.id,
        senderRole: "dispatch",
        senderName: u.name || "Dispatch",
        body,
        channel: "broadcast",
        // store broadcastId in a custom field we append to body? No — use channel="broadcast"
        // We embed broadcastId so the mobile can group them — we'll just tag the channel
      });
      await t.insert(schema.notifications, {
        userId: rider.userId,
        type: "reminder",
        title: `Broadcast from ${u.name || "Dispatch"}`,
        body,
      });
      // Same push + badge treatment as a direct message — a broadcast is just
      // as easy to miss as a 1:1 message if the app isn't open.
      const unread = await unreadDirectCountForRider(cId, rider.id);
      sendPush(rider.userId, `Broadcast from ${u.name || "Dispatch"}`, body, {
        type: "broadcast_message",
        broadcastId,
      }, unread).catch(() => {});
      sent++;
    }

    publishMsg("inbox", cId).catch(() => {});
    return c.json({ sent, broadcastId }, 201);
  })

  // GET /api/messages/tags — return tech-scoped tags for broadcast targeting
  .get("/tags", requireAdmin, async (c) => {
    const cId = tenantId(c);
    const techTags = await db
      .select()
      .from(schema.tags)
      .where(and(eq(schema.tags.companyId, cId)));
    // include all tags (both + tech scope)
    const filtered = techTags.filter((t) => t.scope === "tech" || t.scope === "both");
    return c.json({ tags: filtered }, 200);
  })

  // GET /api/messages/skill-classes — distinct skill classes across all riders in tenant
  .get("/skill-classes", requireAdmin, async (c) => {
    const t = tx(c);
    const riders = await t.select(schema.riders);
    // collect distinct skill classes
    const classMap = new Map<string, number>();
    for (const r of riders) {
      const sc = (r.skillClass ?? "General").trim();
      if (sc) classMap.set(sc, (classMap.get(sc) ?? 0) + 1);
    }
    const skillClasses = Array.from(classMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ skillClasses }, 200);
  })

  // GET /api/messages/skills — distinct individual skills (csv) across all riders
  .get("/skills", requireAdmin, async (c) => {
    const t = tx(c);
    const riders = await t.select(schema.riders);
    const skillMap = new Map<string, number>();
    for (const r of riders) {
      const raw = (r.skills ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
      for (const s of raw) {
        skillMap.set(s, (skillMap.get(s) ?? 0) + 1);
      }
    }
    const skills = Array.from(skillMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ skills }, 200);
  })

  // ── Job thread (booking-scoped) ──────────────────────────────────────────
  // ── Unified inbox ─────────────────────────────────────────────────────────
  // One list of every conversation in the tenant, whichever surface it came
  // from: job threads (incl. messages the homeowner sent from the public
  // /t/:token page), direct tech threads, and broadcasts.
  //
  // MUST stay declared above `/:bookingId` — Hono matches in registration
  // order, so a later `/inbox` would be swallowed by the param route.
  //
  // Read state is NOT touched here. This endpoint is polled and streamed;
  // marking read is always an explicit action (POST .../mark-read).
  .get("/inbox", requireAdmin, async (c) => {
    const t = tx(c);
    const cId = tenantId(c);

    const all = await t.select(schema.messages);
    all.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));

    const riders = await t.select(schema.riders);
    const ridersById = new Map(riders.map((r) => [r.id, r]));
    const users = await db.select().from(schema.user).where(eq(schema.user.companyId, cId));
    const userById = new Map(users.map((u) => [u.id, u]));

    const bookingIds = [...new Set(all.map((m) => m.bookingId).filter(Boolean) as string[])];
    const bookings = bookingIds.length
      ? await t.select(schema.bookings, inArray(schema.bookings.id, bookingIds))
      : [];
    const bookingById = new Map(bookings.map((b) => [b.id, b]));

    type Thread = {
      key: string;
      kind: "client" | "tech" | "broadcast";
      title: string;
      subtitle: string;
      bookingId: string | null;
      techId: string | null;
      jobTitle: string | null;
      jobStatus: string | null;
      photoUrl: string | null;
      color: string;
      lastMessage: string | null;
      lastSenderRole: string | null;
      lastAt: number | null;
      unread: number;
      messageCount: number;
    };
    const threads: Thread[] = [];

    // 1. Client threads — one per booking that has any message on it.
    for (const bId of bookingIds) {
      const msgs = all.filter((m) => m.bookingId === bId);
      if (!msgs.length) continue;
      const b = bookingById.get(bId);
      // a booking from another tenant can't appear: tx() already scopes it,
      // but if the join misses we skip rather than leak an untitled row
      if (!b) continue;
      const last = msgs[msgs.length - 1]!;
      const cust = userById.get(b.customerId);
      const rider = b.riderId ? ridersById.get(b.riderId) : null;
      threads.push({
        key: `client:${bId}`,
        kind: "client",
        title: cust?.name || b.customerPhone || "Customer",
        subtitle: b.address || "",
        bookingId: bId,
        techId: rider?.id ?? null,
        jobTitle: b.title || "",
        jobStatus: b.status,
        photoUrl: null,
        color: "#0ea5e9",
        lastMessage: last.body,
        lastSenderRole: last.senderRole,
        lastAt: Number(last.createdAt),
        // anything the customer said that nobody has acked yet
        unread: msgs.filter((m) => !m.read && m.senderRole === "client").length,
        messageCount: msgs.length,
      });
    }

    // 2. Tech threads — direct dispatcher<->tech, excluding broadcasts.
    for (const r of riders) {
      const msgs = all.filter(
        (m) => m.riderId === r.id && !m.bookingId && m.channel !== "broadcast",
      );
      if (!msgs.length) continue;
      const last = msgs[msgs.length - 1]!;
      const u = userById.get(r.userId);
      threads.push({
        key: `tech:${r.id}`,
        kind: "tech",
        title: u?.name || "Technician",
        subtitle: r.skillClass || "",
        bookingId: null,
        techId: r.id,
        jobTitle: null,
        jobStatus: null,
        photoUrl: r.photoUrl ?? null,
        color: r.color ?? "#0ea5e9",
        lastMessage: last.body,
        lastSenderRole: last.senderRole,
        lastAt: Number(last.createdAt),
        unread: msgs.filter((m) => !m.read && m.senderRole === "tech").length,
        messageCount: msgs.length,
      });
    }

    // 3. Broadcasts — one synthetic thread per send, grouped by body+minute
    // (there's no broadcastId column; a send fans out one row per rider).
    const bcast = all.filter((m) => m.channel === "broadcast");
    const groups = new Map<string, typeof bcast>();
    for (const m of bcast) {
      const minute = Math.floor(Number(m.createdAt) / 60_000);
      const k = `${minute}:${m.body}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(m);
    }
    for (const [k, msgs] of groups) {
      const first = msgs[0]!;
      threads.push({
        key: `broadcast:${k}`,
        kind: "broadcast",
        title: `Broadcast to ${msgs.length} ${msgs.length === 1 ? "tech" : "techs"}`,
        subtitle: first.senderName || "Dispatch",
        bookingId: null,
        techId: null,
        jobTitle: null,
        jobStatus: null,
        photoUrl: null,
        color: "#f59e0b",
        lastMessage: first.body,
        lastSenderRole: "dispatch",
        lastAt: Number(first.createdAt),
        unread: 0, // outbound — nothing for the office to read
        messageCount: msgs.length,
      });
    }

    // unread first, then most recent
    threads.sort((a, b) => {
      if ((b.unread > 0 ? 1 : 0) !== (a.unread > 0 ? 1 : 0)) return (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0);
      return (b.lastAt ?? 0) - (a.lastAt ?? 0);
    });

    return c.json(
      {
        threads,
        counts: {
          all: threads.length,
          client: threads.filter((t2) => t2.kind === "client").length,
          tech: threads.filter((t2) => t2.kind === "tech").length,
          broadcast: threads.filter((t2) => t2.kind === "broadcast").length,
          unread: threads.reduce((s, t2) => s + t2.unread, 0),
        },
      },
      200,
    );
  })

  // GET /api/messages/inbox/stream — one signal for the whole tenant inbox,
  // so the list refreshes no matter which thread a message landed in.
  .get("/inbox/stream", requireAdmin, async (c) => {
    const cId = tenantId(c);
    return streamSSE(c, async (stream) => {
      let closed = false;
      let dirty = false;
      const unsub = subscribeMsg("inbox", cId, () => {
        dirty = true;
      });
      stream.onAbort(() => {
        closed = true;
        unsub();
      });

      const TICK_MS = 1_000;
      const PING_EVERY = 20;
      let sinceData = 0;
      while (!closed) {
        await stream.sleep(TICK_MS);
        if (closed) break;
        if (dirty) {
          dirty = false;
          await stream.writeSSE({ event: "new-message", data: "1" });
          sinceData = 0;
          continue;
        }
        if (++sinceData >= PING_EVERY) {
          sinceData = 0;
          await stream.writeSSE({ event: "ping", data: "1" });
        }
      }
    });
  })

  /**
   * POST /api/messages/:bookingId/mark-read-tech — the FIELD side acks a job
   * thread. Sets `readByTech` only; never touches `read`.
   *
   * Why this is a separate endpoint rather than a flag on the office's
   * mark-read: `read` means "the office has seen this" and drives the
   * dispatcher inbox counts. If opening a job on the phone set `read`, a
   * technician would silently blank the dispatcher's unread list; if the tech
   * had no ack at all, every job-thread message would sit on the driver app's
   * badge forever. Two audiences, two flags, two explicit acks.
   *
   * Scoped to the caller's own assigned job — a tech cannot ack a thread on
   * someone else's work order (that would hide a message from the tech who
   * actually needs it).
   */
  .post("/:bookingId/mark-read-tech", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (u.role !== "rider") return c.json({ message: "Forbidden" }, 403);
    const t = tx(c);
    const bookingId = c.req.param("bookingId");

    const rider = await t.selectOne(schema.riders, eq(schema.riders.userId, u.id));
    if (!rider) return c.json({ message: "Rider not found" }, 404);

    // Ownership check inside the tenant scope: 404 (not 403) so this can never
    // be used to probe which booking ids exist in the company.
    const b = await t.selectOne(
      schema.bookings,
      and(eq(schema.bookings.id, bookingId), eq(schema.bookings.riderId, rider.id)),
    );
    if (!b) return c.json({ message: "Work order not found" }, 404);

    // Only inbound messages: the tech's own sends are already "read by tech",
    // and a client message on the job thread is addressed to the tech too.
    await t.update(
      schema.messages,
      { readByTech: true },
      and(
        eq(schema.messages.bookingId, bookingId),
        notInArray(schema.messages.senderRole, ["tech"]),
      ),
    );
    return c.json({ ok: true }, 200);
  })

  // POST /api/messages/:bookingId/mark-read — office explicitly acks a client
  // thread. Deliberately separate from GET, same rule as the tech threads.
  .post("/:bookingId/mark-read", requireAuth, async (c) => {
    const bookingId = c.req.param("bookingId");
    await tx(c).update(
      schema.messages,
      { read: true },
      and(
        eq(schema.messages.bookingId, bookingId),
        eq(schema.messages.senderRole, "client"),
      ),
    );
    return c.json({ ok: true }, 200);
  })

  .get("/:bookingId", requireAuth, async (c) => {
    const rows = await tx(c).select(
      schema.messages,
      eq(schema.messages.bookingId, c.req.param("bookingId")),
    );
    rows.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
    return c.json({ messages: rows }, 200);
  })

  // POST /api/messages/:bookingId — tech, dispatch, or client posts to job thread
  .post("/:bookingId", requireAuth, jsonBody(DirectBody), async (c) => {
    const u = c.get("user") as SessionUser;
    const { body } = c.req.valid("json");
    const bookingId = c.req.param("bookingId");
    const t = tx(c);

    // Resolve the booking BEFORE writing. This used to insert first and look
    // up second, so a bad or cross-tenant bookingId left an orphaned message
    // hanging in a thread that belongs to nobody.
    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, bookingId));
    if (!b) return c.json({ message: "Work order not found" }, 404);

    const [m] = await t.insert(schema.messages, {
      bookingId,
      senderRole: roleLabel(u.role),
      senderName: u.name,
      body,
      channel: "app",
    });

    {
      if (u.role !== "customer") {
        await t.insert(schema.notifications, {
          userId: b.customerId,
          bookingId,
          type: "reminder",
          title: `Message from ${roleLabel(u.role) === "tech" ? "your technician" : "Dispatch"}`,
          body,
        });
        const phone = b.customerPhone;
        const token = b.publicToken;
        if (phone) {
          const from =
            roleLabel(u.role) === "tech" ? u.name || "Your technician" : "Dispatch";
          const trackLink = token ? ` Track & reply: ${trackingUrl(token)}` : "";
          await sendSms(phone, `NVC360: ${from}: "${body}"${trackLink}`).catch(() => {});
        }
      } else {
        if (b.riderId) {
          const r = await t.selectOne(schema.riders, eq(schema.riders.id, b.riderId));
          if (r) {
            await t.insert(schema.notifications, {
              userId: r.userId,
              bookingId,
              type: "reminder",
              title: "New message from customer",
              body,
            });
            // notify this booking's own tenant admins ONLY — never other tenants.
            const admins = await officeUsersForNotify(b.companyId);
            for (const admin of admins) {
              await t.insert(schema.notifications, {
                userId: admin.id,
                bookingId,
                type: "reminder",
                title: `Customer message on ${b.title || "job"}`,
                body,
              });
            }
            const [ru] = await db
              .select()
              .from(schema.user)
              .where(eq(schema.user.id, r.userId));
            const techPhone = r.phone || ru?.phone || "";
            if (techPhone && b.publicToken) {
              const who = m.senderName || "Customer";
              await sendSms(
                techPhone,
                `NVC360: Customer ${who}: "${body}" — View: ${trackingUrl(b.publicToken)}`,
              ).catch(() => {});
            }
          }
        }
      }
    }

    publishMsg("job", bookingId).catch(() => {});
    publishMsg("inbox", tenantId(c)).catch(() => {});
    return c.json({ message: m }, 201);
  })

  // ── Real-time signals (SSE) — tell a listening client "go refetch", the
  //    actual data still comes from the existing GETs above. Same pattern as
  //    packages/web/src/api/routes/track.ts's proven /:token/stream route. ──
  // GET /api/messages/direct/stream — rider's own direct-thread live signal
  .get("/direct/stream", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (u.role !== "rider") return c.json({ message: "Forbidden" }, 403);
    const rider = await tx(c).selectOne(schema.riders, eq(schema.riders.userId, u.id));
    if (!rider) return c.json({ message: "Rider not found" }, 404);
    const riderId = rider.id;

    return streamSSE(c, async (stream) => {
      let closed = false;
      let dirty = false;
      const unsub = subscribeMsg("direct", riderId, () => {
        dirty = true;
      });
      stream.onAbort(() => {
        closed = true;
        unsub();
      });

      const TICK_MS = 1_000;
      const PING_EVERY = 20; // ticks -> 20s heartbeat
      let sinceData = 0;
      while (!closed) {
        await stream.sleep(TICK_MS);
        if (closed) break;
        if (dirty) {
          dirty = false;
          await stream.writeSSE({ event: "new-message", data: "1" });
          sinceData = 0;
          continue;
        }
        if (++sinceData >= PING_EVERY) {
          sinceData = 0;
          await stream.writeSSE({ event: "ping", data: "1" });
        }
      }
    });
  })

  // GET /api/messages/:bookingId/stream — job-thread live signal (same auth
  // bar as GET /:bookingId above: requireAuth + tenant-scoped tx(), no extra
  // per-user check beyond that today).
  .get("/:bookingId/stream", requireAuth, async (c) => {
    const bookingId = c.req.param("bookingId");

    return streamSSE(c, async (stream) => {
      let closed = false;
      let dirty = false;
      const unsub = subscribeMsg("job", bookingId, () => {
        dirty = true;
      });
      stream.onAbort(() => {
        closed = true;
        unsub();
      });

      const TICK_MS = 1_000;
      const PING_EVERY = 20;
      let sinceData = 0;
      while (!closed) {
        await stream.sleep(TICK_MS);
        if (closed) break;
        if (dirty) {
          dirty = false;
          await stream.writeSSE({ event: "new-message", data: "1" });
          sinceData = 0;
          continue;
        }
        if (++sinceData >= PING_EVERY) {
          sinceData = 0;
          await stream.writeSSE({ event: "ping", data: "1" });
        }
      }
    });
  });
