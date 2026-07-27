import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin, tx, tenantId } from "../middleware/auth";
import { auth } from "../auth";
import { reconcileRiderStatus } from "../../services/presence";
import { putObject, deleteObject } from "../lib/storage";

type SessionUser = { id: string; role?: string };

export const ridersRoutes = new Hono()
  // ── Self-service routes (rider acting on own profile) ────────────────────
  // IMPORTANT: these MUST be registered BEFORE /:id routes so Hono matches
  // /me literally and doesn't capture it as /:id → requireAdmin → 403.

  // current rider's own profile (creates one if missing)
  .get("/me", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    const t = tx(c);
    let r = await t.selectOne(schema.riders, eq(schema.riders.userId, u.id));
    if (!r) {
      [r] = await t.insert(schema.riders, { userId: u.id, status: "available" });
    }
    // Self-heal: derive the true status from active jobs so a stale "busy"
    // (left behind by a cancel/reassign) clears itself when the app loads.
    await reconcileRiderStatus(tenantId(c), r.id);
    r = await t.selectOne(schema.riders, eq(schema.riders.id, r.id));
    return c.json({ rider: r }, 200);
  })
  // update rider status / location
  .patch("/me", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    const body = await c.req.json();
    const t = tx(c);
    let r = await t.selectOne(schema.riders, eq(schema.riders.userId, u.id));
    if (!r) return c.json({ message: "Not found" }, 404);

    const set: Record<string, unknown> = {};
    if (body.vehicle) set.vehicle = body.vehicle;
    if (body.lat != null) { set.lat = body.lat; set.lng = body.lng; set.locationUpdatedAt = new Date(); }

    // Liveness heartbeat from the mobile app's background/foreground GPS
    // watcher: bumps locationUpdatedAt so presence doesn't flap to "offline"
    // during a GPS warm-up window. Must NEVER touch status/manualOffline —
    // this used to be sent as {status:"available"}, which silently reversed
    // an explicit "go Offline" toggle every 90s / every foreground event,
    // making the off-shift switch effectively not stick.
    if (body.heartbeat === true && body.status == null) {
      set.locationUpdatedAt = new Date();
    }

    let toggled = false;
    if (body.status === "offline") {
      set.manualOffline = true;
      set.status = "offline";
      toggled = true;
    } else if (body.status === "available") {
      set.manualOffline = false;
      set.status = "available";
      set.locationUpdatedAt = new Date();
      toggled = true;
    } else if (body.status) {
      set.status = body.status;
    }

    const riderId = r.id;
    if (Object.keys(set).length) {
      [r] = await t.update(schema.riders, set, eq(schema.riders.id, riderId));
    }
    if (toggled) {
      await reconcileRiderStatus(tenantId(c), riderId);
      r = await t.selectOne(schema.riders, eq(schema.riders.id, riderId));
    }
    return c.json({ rider: r ?? null }, 200);
  })
  // tech uploads their own headshot (self-serve, mobile). multipart field: file
  .post("/me/photo", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    const t = tx(c);
    let existing = await t.selectOne(schema.riders, eq(schema.riders.userId, u.id));
    if (!existing) {
      [existing] = await t.insert(schema.riders, { userId: u.id, status: "available" });
    }
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ message: "No file" }, 400);
    if (file.size > 8 * 1024 * 1024) return c.json({ message: "Image too large (max 8MB)" }, 400);
    const ALLOWED = ["image/jpeg", "image/png", "image/webp"];
    if (file.type && !ALLOWED.includes(file.type))
      return c.json({ message: `Unsupported type ${file.type}` }, 400);

    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().slice(0, 8);
    const key = `riders/${existing.id}/${Date.now()}.${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    const stored = await putObject(key, buf, file.type || "image/jpeg");
    if (existing.photoKey) await deleteObject(existing.photoKey).catch(() => {});
    const [r] = await t.update(
      schema.riders,
      { photoUrl: stored.url, photoKey: stored.key },
      eq(schema.riders.id, existing.id),
    );
    return c.json({ rider: r, photoUrl: stored.url }, 201);
  })

  // ── Admin / list routes ──────────────────────────────────────────────────
  // list all riders (admin assign UI)
  .get("/", requireAuth, async (c) => {
    const rows = await tx(c).select(schema.riders);
    const enriched = await Promise.all(
      rows.map(async (r) => {
        const [ru] = await db
          .select()
          .from(schema.user)
          .where(eq(schema.user.id, r.userId));
        return { ...r, name: ru?.name, email: ru?.email, phone: ru?.phone };
      }),
    );
    return c.json({ riders: enriched }, 200);
  })
  // create a technician (admin): user(role=rider) + rider profile
  .post("/", requireAdmin, async (c) => {
    const body = await c.req.json();
    const { name, email, password, phone, skillClass, vehicle, color, licensePlate, licenseNumber, address, notes, skills, payRatePerHour, tags } = body;
    if (!name || !email || !password)
      return c.json({ message: "Name, email and password are required" }, 400);

    const [exists] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, email));
    if (exists) return c.json({ message: "Email already in use" }, 409);

    try {
      await auth.api.signUpEmail({
        body: { name, email, password, role: "rider", phone: phone ?? "" } as any,
      });
    } catch (e: any) {
      return c.json({ message: e?.message ?? "Sign-up failed" }, 400);
    }
    const [u] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, email));
    if (!u) return c.json({ message: "Failed to create user" }, 500);
    // ensure role/phone persisted
    await db
      .update(schema.user)
      .set({ role: "rider", phone: phone ?? "" })
      .where(eq(schema.user.id, u.id));

    const t = tx(c);
    const palette = ["#06b6d4", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#3b82f6"];
    const [r] = await t.insert(schema.riders, {
      userId: u.id,
      phone: phone ?? "",
      skillClass: skillClass || "General",
      vehicle: vehicle || "Van",
      color: color || palette[Math.floor(Math.random() * palette.length)],
      licensePlate: licensePlate ?? "",
      licenseNumber: licenseNumber ?? "",
      address: address ?? "",
      notes: notes ?? "",
      skills: Array.isArray(skills) ? skills.join(",") : (skills ?? ""),
      payRatePerHour: typeof payRatePerHour === "number" ? payRatePerHour : Number(payRatePerHour) || 0,
      status: "available",
    });
    // assign tags (entityType "tech")
    if (Array.isArray(tags) && tags.length) {
      const rows = tags
        .map((t2: any) => (typeof t2 === "string" ? t2 : t2?.id))
        .filter(Boolean)
        .map((tagId: string) => ({ tagId, entityId: r.id, entityType: "tech" as const }));
      if (rows.length) await t.insert(schema.entityTags, rows);
    }
    return c.json({ rider: { ...r, name, email, phone } }, 201);
  })
  // update a technician's profile (admin)
  .patch("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const b = await c.req.json();
    const patch: Record<string, unknown> = {};
    for (const k of ["vehicle", "skillClass", "color", "photoUrl", "phone", "licensePlate", "licenseNumber", "address", "notes", "status", "skills", "payRatePerHour"]) {
      if (k in b) patch[k] = b[k];
    }
    if (Array.isArray(patch.skills)) patch.skills = (patch.skills as string[]).join(",");
    const [r] = await tx(c).update(
      schema.riders,
      patch as Partial<typeof schema.riders.$inferInsert>,
      eq(schema.riders.id, id),
    );
    // Keep the linked user record in sync. The GET endpoint reads name/email/phone
    // from the user table, so these MUST be written there too or edits appear to revert.
    if (r && (b.name || b.email || "phone" in b)) {
      await db.update(schema.user)
        .set({
          ...(b.name && { name: b.name }),
          ...(b.email && { email: b.email }),
          ...("phone" in b && { phone: b.phone ?? "" }),
        })
        .where(eq(schema.user.id, r.userId));
    }
    const [ru] = r
      ? await db.select().from(schema.user).where(eq(schema.user.id, r.userId))
      : [];
    return c.json(
      { rider: r ? { ...r, name: ru?.name, email: ru?.email, phone: ru?.phone } : r },
      200,
    );
  })
  // upload a technician headshot (admin). multipart field: file
  .post("/:id/photo", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const t = tx(c);
    const existing = await t.selectOne(schema.riders, eq(schema.riders.id, id));
    if (!existing) return c.json({ message: "Not found" }, 404);

    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ message: "No file" }, 400);
    if (file.size > 8 * 1024 * 1024) return c.json({ message: "Image too large (max 8MB)" }, 400);
    const ALLOWED = ["image/jpeg", "image/png", "image/webp"];
    if (file.type && !ALLOWED.includes(file.type))
      return c.json({ message: `Unsupported type ${file.type}` }, 400);

    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().slice(0, 8);
    const key = `riders/${id}/${Date.now()}.${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    const stored = await putObject(key, buf, file.type || "image/jpeg");

    if (existing.photoKey) await deleteObject(existing.photoKey).catch(() => {});

    const [r] = await t.update(
      schema.riders,
      { photoUrl: stored.url, photoKey: stored.key },
      eq(schema.riders.id, id),
    );
    return c.json({ rider: r, photoUrl: stored.url }, 201);
  })
  // remove a technician headshot (admin)
  .delete("/:id/photo", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const t = tx(c);
    const existing = await t.selectOne(schema.riders, eq(schema.riders.id, id));
    if (!existing) return c.json({ message: "Not found" }, 404);
    if (existing.photoKey) await deleteObject(existing.photoKey).catch(() => {});
    await t.update(schema.riders, { photoUrl: "", photoKey: "" }, eq(schema.riders.id, id));
    return c.json({ ok: true }, 200);
  })
  // delete a technician (admin): removes rider profile + user account
  .delete("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const t = tx(c);
    const r = await t.selectOne(schema.riders, eq(schema.riders.id, id));
    if (!r) return c.json({ message: "Not found" }, 404);
    // unassign any active bookings
    await t.update(
      schema.bookings,
      { riderId: null, status: "confirmed" },
      eq(schema.bookings.riderId, id),
    );
    await t.delete(schema.riders, eq(schema.riders.id, id));
    await db.delete(schema.user).where(eq(schema.user.id, r.userId));
    return c.json({ ok: true }, 200);
  })
;
