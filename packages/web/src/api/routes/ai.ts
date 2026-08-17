import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth, requireAdmin, tx } from "../middleware/auth";
import {
  AVG_KMH,
  distKm,
  predictDelays,
  rankCandidates,
  techWorkload,
  typicalDurationMins,
} from "../../services/ai-dispatch";
import { companyTimeZone } from "../../services/company-tz";
import type { AppEnv } from "../env";

export const aiRoutes = new Hono<AppEnv>()
  // suggest the best technician for a work order (nearest + skill match + availability)
  // suggest the best technician for a work order.
  // Model-ranked with plain-English rationale (services/ai-dispatch.ts), with
  // the deterministic scorer as an always-available fallback.
  .post("/suggest-tech/:bookingId", requireAuth, async (c) => {
    const t = tx(c);
    const companyId = c.get("companyId") ?? "default";
    const b = await t.selectOne(
      schema.bookings,
      eq(schema.bookings.id, c.req.param("bookingId")),
    );
    if (!b) return c.json({ message: "Not found" }, 404);
    const svc = await t.selectOne(schema.services, eq(schema.services.id, b.serviceId));
    const techs = await t.select(schema.riders);

    // names come from the linked user rows
    const userRows = techs.length
      ? await db
          .select({ id: schema.user.id, name: schema.user.name })
          .from(schema.user)
          .where(inArray(schema.user.id, techs.map((r) => r.userId)))
      : [];
    const names = new Map(userRows.map((u) => [u.id, u.name]));

    // service durations (for workload projection) + this tenant's own history
    const svcRows = await t.select(schema.services);
    const durations = new Map(svcRows.map((s) => [s.id, s.durationMins]));
    const [load, typicalMins] = await Promise.all([
      techWorkload(companyId, durations),
      typicalDurationMins(companyId, b.serviceId),
    ]);

    const result = await rankCandidates({
      tz: await companyTimeZone(t.companyId),
      job: {
        id: b.id,
        title: b.title,
        address: b.address,
        lat: b.lat,
        lng: b.lng,
        priority: b.priority,
        scheduledAt: b.scheduledAt ? Number(b.scheduledAt) : null,
      },
      service: svc
        ? { name: svc.name, category: svc.category, durationMins: svc.durationMins }
        : null,
      techs: techs.map((r) => ({
        id: r.id,
        name: names.get(r.userId) ?? "",
        skills: r.skills,
        skillClass: r.skillClass,
        status: r.status,
        color: r.color,
        lat: r.lat,
        lng: r.lng,
        rating: r.rating,
        completedJobs: r.completedJobs,
        openJobs: load.get(r.id)?.openJobs ?? 0,
        freeInMins: Math.round(load.get(r.id)?.freeInMins ?? 0),
      })),
      typicalMins,
    });

    const best = result.best;
    return c.json(
      {
        best,
        ranked: result.ranked.slice(0, 5),
        // signals the UI can use to soften/withhold the recommendation
        confident: !!best && best.available && best.skillMatch,
        locationAvailable:
          b.lat != null && b.lng != null && result.ranked.some((s) => s.locationKnown),
        reasoning: result.reasoning,
        // "ai" = model-ranked, "rules" = deterministic fallback
        source: result.source,
        fallbackReason: result.fallbackReason,
        typicalMins,
      },
      200,
    );
  })
  // optimize the route/sequence for a technician's assigned stops (nearest-neighbour)
  .get("/optimize-route/:techId", requireAuth, async (c) => {
    const techId = c.req.param("techId");
    const tdb = tx(c);
    const t = await tdb.selectOne(schema.riders, eq(schema.riders.id, techId));
    if (!t) return c.json({ message: "Not found" }, 404);
    const stops = await tdb.select(
      schema.bookings,
      and(
        eq(schema.bookings.riderId, techId),
        inArray(schema.bookings.status, ["assigned", "enroute"]),
      ),
    );

    // nearest-neighbour ordering from tech's current position
    let curLat = t.lat ?? 43.6532;
    let curLng = t.lng ?? -79.3832;
    const remaining = [...stops];
    const ordered: any[] = [];
    let totalKm = 0;
    while (remaining.length) {
      let bestI = 0;
      let bestD = Infinity;
      remaining.forEach((s, i) => {
        const d = distKm(curLat, curLng, s.lat, s.lng);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      });
      const next = remaining.splice(bestI, 1)[0];
      totalKm += bestD;
      ordered.push({
        id: next.id,
        title: next.title,
        address: next.address,
        legKm: +bestD.toFixed(1),
        legMins: Math.round((bestD / AVG_KMH) * 60),
      });
      curLat = next.lat;
      curLng = next.lng;
    }
    // naive original distance (in given order)
    let origKm = 0;
    let pLat = t.lat ?? 43.6532;
    let pLng = t.lng ?? -79.3832;
    for (const s of stops) {
      origKm += distKm(pLat, pLng, s.lat, s.lng);
      pLat = s.lat;
      pLng = s.lng;
    }
    const savedKm = +(origKm - totalKm).toFixed(1);
    return c.json(
      {
        stops: ordered,
        totalKm: +totalKm.toFixed(1),
        totalMins: Math.round((totalKm / AVG_KMH) * 60),
        savedKm: Math.max(0, savedKm),
        savedMins: Math.max(0, Math.round((savedKm / AVG_KMH) * 60)),
      },
      200,
    );
  })
  // jobs projected to run late, based on live tech position + this tenant's own
  // historical durations. Same computation that feeds the sla_risk automation.
  .get("/delay-risk", requireAdmin, async (c) => {
    const companyId = c.get("companyId") ?? "default";
    const grace = Number(c.req.query("graceMins") ?? 15);
    const risks = await predictDelays(companyId, {
      graceMins: Number.isFinite(grace) ? grace : 15,
    });
    return c.json({ risks, count: risks.length }, 200);
  });
