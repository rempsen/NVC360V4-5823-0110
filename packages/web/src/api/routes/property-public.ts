/**
 * PUBLIC property hub — the "CarFax for buildings" surface.
 *
 * Accessed at /p/:token with no login, exactly like the per-job /t/:token
 * tracking link, but persistent: it survives across jobs so a homeowner keeps
 * one durable link to everything ever done at their address.
 *
 * Deliberately conservative about what it exposes. It is a permanent,
 * shareable, unauthenticated URL, so it shows only completed work: what was
 * done, when, by whom, photos and materials. It never exposes pricing, staff
 * notes, technician phone numbers, or any live technician location.
 */
import { Hono } from "hono";
import { db } from "../database";
import { tdb } from "../database/tenant";
import * as schema from "../database/schema";
import { eq, and } from "drizzle-orm";
import { trackLimiter } from "../lib/rate-limit";
import { trackingUrl } from "../../services/sms";
import type { AppEnv } from "../env";

async function resolvePropertyByToken(token: string) {
  const [p] = await db
    .select()
    .from(schema.properties)
    .where(eq(schema.properties.publicToken, token));
  return p ?? null;
}

export const propertyPublicRoutes = new Hono<AppEnv>()
  /**
   * GET /api/property/:token
   * Full service history for one property.
   */
  .get("/:token", trackLimiter, async (c) => {
    const token = c.req.param("token");
    const prop = await resolvePropertyByToken(token);
    if (!prop) return c.json({ message: "Not found" }, 404);

    const t = tdb(prop.companyId);

    const [co] = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, prop.companyId));
    const cs = await t.selectOne(schema.companySettings);
    const workerNoun = cs?.workerNoun || "Technician";
    const jobNoun = cs?.jobNoun || "Job";

    // Only completed, non-archived work belongs in a permanent public record.
    // In-flight jobs live on their own /t/ link where the customer can still
    // see live status; surfacing them here would leak scheduling detail on a
    // long-lived URL.
    const allJobs = await t.select(
      schema.bookings,
      eq(schema.bookings.propertyId, prop.id),
    );
    const jobs = allJobs
      .filter((b) => b.status === "completed" && !b.deletedAt)
      .sort((a, z) => Number(z.finishedAt ?? z.createdAt) - Number(a.finishedAt ?? a.createdAt));

    const history = await Promise.all(
      jobs.map(async (b) => {
        const svc = await t.selectOne(
          schema.services,
          eq(schema.services.id, b.serviceId),
        );

        let techName = "";
        if (b.riderId) {
          const r = await t.selectOne(schema.riders, eq(schema.riders.id, b.riderId));
          if (r) {
            const [ru] = await db
              .select()
              .from(schema.user)
              .where(eq(schema.user.id, r.userId));
            techName = ru?.name || "";
          }
        }

        const photoRows = await t.select(
          schema.jobPhotos,
          eq(schema.jobPhotos.bookingId, b.id),
        );
        photoRows.sort((a, z) => Number(a.createdAt) - Number(z.createdAt));

        // What was used — never what it cost.
        let materials: { name: string; qty: number; unit: string }[] = [];
        try {
          const li = JSON.parse(b.lineItems || "[]");
          if (Array.isArray(li)) {
            materials = li
              .filter((x: any) => x?.name)
              .map((x: any) => ({
                name: String(x.name),
                qty: Number(x.qty) || 1,
                unit: String(x.unit || ""),
              }));
          }
        } catch {
          /* ignore malformed */
        }

        return {
          id: b.id,
          title: b.title || svc?.name || "Service",
          service: svc?.name || "",
          completedAt: b.finishedAt,
          scheduledAt: b.scheduledAt,
          techName,
          onSiteMinutes: b.onSiteMinutes,
          materials,
          photos: photoRows
            .filter((p) => p.customerVisible !== false)
            .map((p) => ({
              id: p.id,
              url: p.url,
              caption: p.caption,
              phase: p.phase || "during",
              at: p.createdAt,
            })),
          // deep link back to the permanent record for that individual job
          recordUrl: trackingUrl(b.publicToken),
        };
      }),
    );

    return c.json(
      {
        property: {
          token: prop.publicToken,
          address: prop.addressDisplay,
        },
        company: co
          ? { name: co.name, email: co.contactEmail || "", phone: co.phone || "" }
          : null,
        workerNoun,
        jobNoun,
        stats: {
          totalJobs: history.length,
          firstServiceAt: history.length
            ? history[history.length - 1].completedAt
            : null,
          lastServiceAt: history.length ? history[0].completedAt : null,
        },
        history,
      },
      200,
    );
  })

  /**
   * GET /api/property/:token/intake
   * The tenant's public intake form (if any) so the hub's "Request service"
   * button can drop the customer straight into booking with the address known.
   */
  .get("/:token/intake", trackLimiter, async (c) => {
    const token = c.req.param("token");
    const prop = await resolvePropertyByToken(token);
    if (!prop) return c.json({ message: "Not found" }, 404);

    const [form] = await db
      .select()
      .from(schema.intakeForms)
      .where(
        and(
          eq(schema.intakeForms.companyId, prop.companyId),
          eq(schema.intakeForms.active, true),
          eq(schema.intakeForms.formType, "lead"),
        ),
      );

    return c.json(
      {
        companyId: prop.companyId,
        slug: form?.slug ?? null,
        address: prop.addressDisplay,
      },
      200,
    );
  });
