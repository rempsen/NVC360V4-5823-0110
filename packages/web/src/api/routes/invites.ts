import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAdmin, tx } from "../middleware/auth";
import { auth } from "../auth";
import { sendEmail, loadEmailBrand, resolveLogo } from "../../services/email";
import { sendSms } from "../../services/sms";

import { z } from "zod";
import { parseBody, shortText, optText, email as emailField, phone as phoneField } from "../lib/validate";

type SessionUser = { id: string; name?: string };

/* -------------------------------------------------------------------------- */
/*  Request schemas                                                            */
/*                                                                             */
/*  POST / took `email` as any non-empty string, so an invite could be sent to  */
/*  "not an email" (a hard bounce against the tenant's own sending domain --    */
/*  bounces are what get a domain's reputation shredded), and name/phone/       */
/*  skillClass were unbounded strings interpolated into an outbound email.      */
/*                                                                             */
/*  POST /accept/:token is PUBLIC and unauthenticated: it accepted an arbitrary */
/*  length `name` and `phone` straight into a new login account, and enforced   */
/*  a 6-character minimum password while better-auth itself wants 8, so the     */
/*  hand-rolled check produced a confusing 400 from the auth layer instead.     */
/* -------------------------------------------------------------------------- */
const InviteCreate = z.object({
  email: emailField(),
  name: optText(120),
  phone: phoneField.optional(),
  skillClass: optText(60),
});

const InviteAccept = z.object({
  name: shortText("Name", 120).optional(),
  password: z
    .string({ message: "Password is required" })
    .min(8, "Password must be at least 8 characters")
    .max(200, "Password is too long"),
  phone: phoneField.optional(),
});

const SITE = (process.env.WEBSITE_URL || "http://localhost:4200").replace(/\/$/, "");

/** Company display name for a given company, used in invite emails/SMS. */
async function companyName(companyId: string): Promise<string> {
  const [co] = await db
    .select()
    .from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, companyId));
  return co?.name || "NVC360";
}

async function companyBrand(companyId: string): Promise<{ name: string; workerNoun: string }> {
  const [co] = await db
    .select()
    .from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, companyId));
  return { name: co?.name || "NVC360", workerNoun: co?.workerNoun || "Technician" };
}

export const invitesRoutes = new Hono()
  // list invites (admin)
  .get("/", requireAdmin, async (c) => {
    const rows = await tx(c).select(schema.techInvites);
    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return c.json({ invites: rows }, 200);
  })
  // create + send an invite (admin)
  .post("/", requireAdmin, async (c) => {
    const u = c.get("user") as SessionUser;
    const b = await parseBody(c, InviteCreate);
    const [exists] = await db.select().from(schema.user).where(eq(schema.user.email, b.email));
    if (exists) return c.json({ message: "A user with that email already exists" }, 409);

    const [inv] = await tx(c).insert(schema.techInvites, {
      email: b.email,
      name: b.name || "",
      phone: b.phone || "",
      skillClass: b.skillClass || "General",
      invitedBy: u.id,
    });

    const link = `${SITE}/join/${inv.token}`;
    const company = await companyName(inv.companyId);
    const brand = await loadEmailBrand(inv.companyId);
    const accent = brand.brandColor || "#06B6D4";
    // Tenant logo always sits above the company name in the header.
    const logoSrc = resolveLogo(brand.logoUrl);
    const logoBlock = logoSrc
      ? `<img src="${logoSrc}" alt="${company}" style="height:40px;max-width:220px;display:block;margin:0 auto 8px"/>
         <div style="color:#fff;font-size:15px;font-weight:700;text-align:center">${company}</div>`
      : `<div style="color:#fff;font-size:18px;font-weight:800;text-align:center">${company}</div>`;

    // email the invite
    sendEmail({
      to: inv.email,
      subject: `You're invited to join ${company} as a technician`,
      html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <div style="background:linear-gradient(135deg,${accent},${accent}cc);border-radius:16px 16px 0 0;padding:22px 24px">
          ${logoBlock}
        </div>
        <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;padding:24px">
          <h2 style="margin:0 0 10px;color:#0f172a">Welcome aboard${inv.name ? ", " + inv.name : ""} 👋</h2>
          <p style="font-size:14px;color:#334155;line-height:1.6">You've been invited to join <b>${company}</b> as a technician. Set up your account to start receiving job assignments, navigate to clients, and update job status in real time.</p>
          <a href="${link}" style="display:inline-block;margin-top:16px;background:${accent};color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">Accept invite & set password</a>
          <p style="margin-top:18px;font-size:12px;color:#94a3b8">If the button doesn't work, paste this link: ${link}</p>
        </div>
      </div>`,
    }).catch((e) => console.error("invite email failed", e));

    if (inv.phone) {
      sendSms(inv.phone, `${company}: You're invited to join as a technician. Set up your account: ${link}`).catch(() => {});
    }

    return c.json({ invite: inv, link }, 201);
  })
  // resend
  .post("/:id/resend", requireAdmin, async (c) => {
    const inv = await tx(c).selectOne(schema.techInvites, eq(schema.techInvites.id, c.req.param("id")));
    if (!inv) return c.json({ message: "Not found" }, 404);
    const link = `${SITE}/join/${inv.token}`;
    const company = await companyName(inv.companyId);
    sendEmail({ to: inv.email, subject: `Reminder: join ${company} as a technician`, html: `<p>Your invite link: <a href="${link}">${link}</a></p>` }).catch(() => {});
    if (inv.phone) sendSms(inv.phone, `${company}: Reminder — set up your technician account: ${link}`).catch(() => {});
    return c.json({ ok: true, link }, 200);
  })
  // revoke
  .post("/:id/revoke", requireAdmin, async (c) => {
    const [inv] = await tx(c).update(schema.techInvites, { status: "revoked" }, eq(schema.techInvites.id, c.req.param("id")));
    return c.json({ invite: inv }, 200);
  })

  // ---- PUBLIC: look up an invite by token (for the join page) ----
  // No request user/tenant context — the invite token resolves its own company.
  .get("/lookup/:token", async (c) => {
    const [inv] = await db.select().from(schema.techInvites).where(eq(schema.techInvites.token, c.req.param("token")));
    if (!inv || inv.status !== "pending") return c.json({ message: "Invite not found or already used" }, 404);
    const brand = await companyBrand(inv.companyId);
    return c.json({ invite: { email: inv.email, name: inv.name, skillClass: inv.skillClass }, company: brand.name, workerNoun: brand.workerNoun }, 200);
  })
  // ---- PUBLIC: accept an invite -> create user(role=rider) + active rider profile ----
  .post("/accept/:token", async (c) => {
    const token = c.req.param("token");
    const { name, password, phone } = await parseBody(c, InviteAccept);
    const [inv] = await db.select().from(schema.techInvites).where(eq(schema.techInvites.token, token));
    if (!inv || inv.status !== "pending") return c.json({ message: "Invite not found or already used" }, 404);

    const [exists] = await db.select().from(schema.user).where(eq(schema.user.email, inv.email));
    if (exists) return c.json({ message: "Account already exists — please sign in" }, 409);

    try {
      await auth.api.signUpEmail({
        body: { name: name || inv.name || inv.email, email: inv.email, password, role: "rider", phone: phone || inv.phone || "" } as any,
      });
    } catch (e: any) {
      return c.json({ message: e?.message ?? "Sign-up failed" }, 400);
    }
    const [u] = await db.select().from(schema.user).where(eq(schema.user.email, inv.email));
    if (!u) return c.json({ message: "Failed to create account" }, 500);
    // The new tech belongs to the inviting company — stamp tenant onto the user row.
    await db.update(schema.user).set({ role: "rider", phone: phone || inv.phone || "", companyId: inv.companyId }).where(eq(schema.user.id, u.id));

    const palette = ["#06b6d4", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#3b82f6"];
    await db.insert(schema.riders).values({
      companyId: inv.companyId,
      userId: u.id,
      phone: phone || inv.phone || "",
      skillClass: inv.skillClass || "General",
      color: palette[Math.floor(Math.random() * palette.length)],
      status: "available",
      approval: "active",
    });
    await db.update(schema.techInvites).set({ status: "accepted", acceptedAt: new Date() }).where(eq(schema.techInvites.id, inv.id));
    return c.json({ ok: true, email: inv.email }, 200);
  });
