/**
 * AI dispatch — Phase 5.
 *
 * Two jobs:
 *
 * 1. `rankCandidates()` — given a job and the tenant's technicians (already
 *    tenant-scoped and fetched by the caller, so isolation stays where it
 *    already lives), produce a RANKED list with a plain-English rationale per
 *    tech. A deterministic scorer always runs first and produces a complete,
 *    usable answer on its own; the model is then asked to re-rank and explain
 *    that same candidate set. If the gateway is unconfigured, slow, errors, or
 *    returns anything we can't reconcile against the real candidates, we return
 *    the deterministic result untouched. Dispatch must never hard-fail.
 *
 * 2. `predictDelays()` — looks at every in-flight job for a company and
 *    projects whether it will finish late, based on where the tech actually is
 *    now, how long this service type historically takes for this tenant, and
 *    how much of the visit is already done. Feeds the `sla_risk` automation
 *    trigger from Phase 2 (which previously only knew about *unassigned* jobs
 *    approaching their window — it could not see a job already running late).
 *
 * Design notes:
 * - The model NEVER invents a technician, a distance, or an ETA. It only
 *   reorders the candidate list we hand it and writes prose. Every number the
 *   UI shows still comes from our own computation.
 * - No new tables. Historical duration comes from completed `bookings`
 *   (`onSiteMinutes` / started→finished), falling back to `services.durationMins`.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { and, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import { db } from "../api/database";
import * as schema from "../api/database/schema";
import { gateway, MODELS } from "../api/agent/gateway";
import { log } from "../api/lib/logger";
import { fmtInZone } from "../shared/tz";

export const AVG_KMH = 32; // urban average
/** Beyond this we don't trust the location data enough to recommend on distance. */
export const MAX_SERVICE_RADIUS_KM = 150;

export function distKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function minsForKm(km: number) {
  return Math.round((km / AVG_KMH) * 60);
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface Candidate {
  techId: string;
  name: string;
  skillClass: string;
  status: string;
  color: string;
  distanceKm: number | null;
  etaMins: number | null;
  locationKnown: boolean;
  skillMatch: boolean;
  available: boolean;
  /** assigned/enroute/arrived/in_progress jobs on this tech right now */
  openJobs: number;
  /** minutes until their current commitments are projected to clear (0 = free now) */
  freeInMins: number;
  rating: number;
  completedJobs: number;
  /** lower is better */
  score: number;
  /** one short sentence, model-written when available */
  rationale: string | null;
}

export interface RankInput {
  job: {
    id: string;
    title: string;
    address: string;
    lat: number | null;
    lng: number | null;
    priority: string;
    scheduledAt: number | null;
  };
  service: { name: string; category: string; durationMins: number } | null;
  /** tenant's technicians, already scoped */
  techs: Array<{
    id: string;
    name: string;
    skills: string;
    skillClass: string;
    status: string;
    color: string;
    lat: number | null;
    lng: number | null;
    rating: number;
    completedJobs: number;
    openJobs: number;
    freeInMins: number;
  }>;
  /** tenant's own historical average for this service type, minutes */
  typicalMins: number | null;
  /** Tenant's IANA zone. The model is told the appointment time in it —
   *  formatted on the server's UTC clock it was hours out, and the model
   *  reasons about "is this tech free by then". */
  tz?: string | null;
}

/**
 * Deterministic scorer. This is the fallback AND the input to the model —
 * it always runs, so a model outage changes only the wording, not the answer.
 */
export function scoreCandidates(input: RankInput): Candidate[] {
  const { job, service } = input;
  const jobHasLoc = job.lat != null && job.lng != null;
  const urgent = job.priority === "urgent" || job.priority === "high";

  const scored = input.techs.map((t): Candidate => {
    const techHasLoc = t.lat != null && t.lng != null;
    const hasLoc = techHasLoc && jobHasLoc;
    const rawKm = hasLoc ? distKm(t.lat!, t.lng!, job.lat!, job.lng!) : null;
    const km = rawKm != null && rawKm <= MAX_SERVICE_RADIUS_KM ? rawKm : null;
    const skillMatch = !!(
      service &&
      t.skills.toLowerCase().includes(service.category.toLowerCase().split(" ")[0])
    );
    const avail = t.status === "available";

    // lower score is better. unknown location is penalised, not faked as 999.
    let score = km ?? 80; // neutral mid penalty when distance is unknown
    if (!skillMatch) score += 30;
    if (!avail) score += 50;
    if (t.status === "offline") score += 200;
    // workload: each open stop is real friction, and a tech who won't be free
    // for an hour is worse than one who's free in ten minutes
    score += t.openJobs * 8;
    score += Math.min(t.freeInMins, 240) / 6;
    // for urgent work, lean harder on who can actually go now
    if (urgent) score += t.freeInMins > 30 ? 15 : 0;

    return {
      techId: t.id,
      name: t.name,
      skillClass: t.skillClass,
      status: t.status,
      color: t.color,
      distanceKm: km != null ? +km.toFixed(1) : null,
      etaMins: km != null ? minsForKm(km) : null,
      locationKnown: hasLoc,
      skillMatch,
      available: avail,
      openJobs: t.openJobs,
      freeInMins: Math.round(t.freeInMins),
      rating: t.rating,
      completedJobs: t.completedJobs,
      score: +score.toFixed(1),
      rationale: null,
    };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored;
}

/** Plain-English fallback sentence, used when the model isn't available. */
export function heuristicReasoning(
  best: Candidate | null,
  workerNoun = "technician",
): string | null {
  if (!best) return null;
  const parts: string[] = [];
  if (best.distanceKm != null) {
    parts.push(`${best.name} is ${best.distanceKm} km away (~${best.etaMins} min)`);
  } else {
    parts.push(`${best.name} is the strongest match`);
  }
  if (best.skillMatch) parts.push(`matches ${best.skillClass} skill`);
  parts.push(best.available ? "available now" : "currently busy");
  if (best.openJobs > 0) {
    parts.push(
      best.freeInMins > 0
        ? `${best.openJobs} stop${best.openJobs === 1 ? "" : "s"} left, free in ~${best.freeInMins} min`
        : `${best.openJobs} stop${best.openJobs === 1 ? "" : "s"} still open`,
    );
  }
  let out = parts.join(", ") + ".";
  if (best.distanceKm == null) {
    out += ` Location data is unavailable, so this is based on skill and availability only.`;
  }
  void workerNoun;
  return out;
}

const RankSchema = z.object({
  ranking: z
    .array(
      z.object({
        techId: z.string(),
        rationale: z.string(),
      }),
    )
    .min(1),
  summary: z.string(),
});

export interface RankResult {
  ranked: Candidate[];
  best: Candidate | null;
  reasoning: string | null;
  /** "ai" when the model re-ranked and explained, "rules" when we fell back */
  source: "ai" | "rules";
  /** why we fell back, for the UI/logs. null when source === "ai" */
  fallbackReason: string | null;
}

function gatewayConfigured() {
  return !!process.env.AI_GATEWAY_API_KEY;
}

/**
 * Rank candidates, preferring the model. Always resolves — never throws.
 */
export async function rankCandidates(
  input: RankInput,
  opts: { workerNoun?: string; timeoutMs?: number } = {},
): Promise<RankResult> {
  const heuristic = scoreCandidates(input);
  const fallback = (reason: string): RankResult => ({
    ranked: heuristic,
    best: heuristic[0] ?? null,
    reasoning: heuristicReasoning(heuristic[0] ?? null, opts.workerNoun),
    source: "rules",
    fallbackReason: reason,
  });

  if (!heuristic.length) return fallback("no candidates");
  if (!gatewayConfigured()) return fallback("AI gateway not configured");

  // only the plausible field is worth spending a model call on
  const shortlist = heuristic.filter((c) => c.status !== "offline").slice(0, 8);
  if (shortlist.length < 2) {
    return fallback(
      shortlist.length ? "only one candidate" : "no online candidates",
    );
  }

  const noun = opts.workerNoun ?? "technician";
  const job = input.job;
  const lines = shortlist
    .map((c) => {
      const bits = [
        `id=${c.techId}`,
        `name=${c.name}`,
        `skillClass=${c.skillClass}`,
        `skillMatchesThisJob=${c.skillMatch ? "yes" : "no"}`,
        `status=${c.status}`,
        c.distanceKm != null
          ? `distance=${c.distanceKm}km (~${c.etaMins}min drive)`
          : `distance=unknown (no recent GPS)`,
        `openStops=${c.openJobs}`,
        c.openJobs > 0 ? `projectedFreeIn=${c.freeInMins}min` : `freeNow=yes`,
        `rating=${c.rating}`,
        `jobsCompleted=${c.completedJobs}`,
      ];
      return `- ${bits.join(", ")}`;
    })
    .join("\n");

  const when = fmtInZone(
    job.scheduledAt,
    input.tz,
    { dateStyle: "medium", timeStyle: "short" },
    "en-CA",
    "unscheduled",
  );

  const prompt = `You are the dispatcher for a field-service company. Pick the best ${noun} for this job and rank the rest.

JOB
- ${job.title || "(untitled work order)"}
- service: ${input.service ? `${input.service.name} (${input.service.category})` : "unspecified"}
- typical on-site duration for this service at this company: ${
    input.typicalMins ? `${input.typicalMins} min (from their own completed jobs)` : "no history yet"
  }${input.service ? `, catalog estimate ${input.service.durationMins} min` : ""}
- priority: ${job.priority}
- scheduled: ${when}
- address: ${job.address || "(none)"}

CANDIDATE ${noun.toUpperCase()}S (every number below is measured, do not change or invent any)
${lines}

Rules:
- Return EVERY candidate id above, exactly once, best first.
- Use only the ids given. Never invent a ${noun}, a distance, or an ETA.
- Weigh: can they actually get there in time, do they have the right skill, and how loaded are they already. A slightly further ${noun} who is genuinely free usually beats a closer one mid-job.
- "distance=unknown" means we have no recent GPS — do not assert they are close or far; judge on skill and availability and say so.
- rationale: ONE short sentence for that specific ${noun}, in a dispatcher's voice, citing the real numbers. Example: "12 min out, has the HVAC cert, and clears his 2pm by about 3:15."
- summary: one sentence recommending your top pick to the dispatcher, citing real numbers.`;

  try {
    const { object } = await Promise.race([
      generateObject({ model: gateway(MODELS.text), schema: RankSchema, prompt }),
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error("timeout")),
          opts.timeoutMs ?? 12_000,
        ),
      ),
    ]);

    const byId = new Map(shortlist.map((c) => [c.techId, c]));
    const ordered: Candidate[] = [];
    for (const r of object.ranking) {
      const c = byId.get(r.techId);
      if (!c || ordered.some((o) => o.techId === c.techId)) continue; // hallucinated or dupe
      ordered.push({ ...c, rationale: (r.rationale || "").trim() || null });
    }
    // must have covered the shortlist to be trustworthy
    if (ordered.length !== shortlist.length) {
      return fallback("model ranking did not match candidate list");
    }

    // offline techs were never shown to the model — keep them last, as before
    const offline = heuristic.filter((c) => c.status === "offline");
    const ranked = [...ordered, ...offline];
    const summary = (object.summary || "").trim();

    return {
      ranked,
      best: ranked[0] ?? null,
      reasoning: summary || heuristicReasoning(ranked[0] ?? null, noun),
      source: "ai",
      fallbackReason: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn("ai-dispatch: model ranking failed; using deterministic scorer", {
      bookingId: job.id,
      error: msg,
    });
    return fallback(msg === "timeout" ? "model timed out" : "model call failed");
  }
}

// ---------------------------------------------------------------------------
// Historical duration + workload (used by the route and the delay predictor)
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = ["assigned", "enroute", "arrived", "in_progress"] as const;

/**
 * Tenant's own median-ish (trimmed mean) on-site duration for a service, in
 * minutes. Null when there isn't enough history to be meaningful.
 */
export async function typicalDurationMins(
  companyId: string,
  serviceId: string | null,
): Promise<number | null> {
  if (!serviceId) return null;
  try {
    const rows = await db
      .select({
        onSiteMinutes: schema.bookings.onSiteMinutes,
        startedAt: schema.bookings.startedAt,
        finishedAt: schema.bookings.finishedAt,
      })
      .from(schema.bookings)
      .where(
        and(
          eq(schema.bookings.companyId, companyId),
          eq(schema.bookings.serviceId, serviceId),
          eq(schema.bookings.status, "completed"),
          isNull(schema.bookings.deletedAt),
          isNotNull(schema.bookings.finishedAt),
        ),
      );
    const mins = rows
      .map((r) => {
        if (r.onSiteMinutes && r.onSiteMinutes > 0) return r.onSiteMinutes;
        if (r.startedAt && r.finishedAt)
          return (Number(r.finishedAt) - Number(r.startedAt)) / 60000;
        return 0;
      })
      .filter((m) => m > 2 && m < 16 * 60)
      .sort((a, b) => a - b);
    if (mins.length < 3) return null;
    // trim the extremes so one disaster job doesn't skew the estimate
    const cut = Math.floor(mins.length * 0.1);
    const core = mins.slice(cut, mins.length - cut || undefined);
    const avg = core.reduce((s, m) => s + m, 0) / core.length;
    return Math.round(avg);
  } catch (e) {
    log.warn("ai-dispatch: duration history lookup failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Per-tech workload: open stops and a projected "free in N minutes".
 * Best-effort — on any failure every tech simply reads as unloaded.
 */
export async function techWorkload(
  companyId: string,
  serviceDurations: Map<string, number>,
): Promise<Map<string, { openJobs: number; freeInMins: number }>> {
  const out = new Map<string, { openJobs: number; freeInMins: number }>();
  try {
    const active = await db
      .select({
        riderId: schema.bookings.riderId,
        serviceId: schema.bookings.serviceId,
        status: schema.bookings.status,
        startedAt: schema.bookings.startedAt,
        scheduledAt: schema.bookings.scheduledAt,
      })
      .from(schema.bookings)
      .where(
        and(
          eq(schema.bookings.companyId, companyId),
          inArray(schema.bookings.status, [...ACTIVE_STATUSES]),
          isNull(schema.bookings.deletedAt),
        ),
      );
    const now = Date.now();
    for (const b of active) {
      if (!b.riderId) continue;
      const dur = serviceDurations.get(b.serviceId) ?? 60;
      let remaining = dur;
      if (b.status === "in_progress" && b.startedAt) {
        const elapsed = (now - Number(b.startedAt)) / 60000;
        remaining = Math.max(5, dur - elapsed);
      } else if (b.status === "arrived") {
        remaining = dur;
      } else if (b.status === "enroute") {
        remaining = dur + 10;
      } else {
        // assigned but not started — only counts from its scheduled start
        const startsIn = Math.max(0, (Number(b.scheduledAt) - now) / 60000);
        remaining = startsIn + dur;
      }
      const cur = out.get(b.riderId) ?? { openJobs: 0, freeInMins: 0 };
      cur.openJobs += 1;
      cur.freeInMins += remaining;
      out.set(b.riderId, cur);
    }
  } catch (e) {
    log.warn("ai-dispatch: workload lookup failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delay prediction
// ---------------------------------------------------------------------------

export interface DelayRisk {
  bookingId: string;
  title: string;
  address: string;
  status: string;
  riderId: string | null;
  techName: string;
  /** minutes we project this job finishes past its window */
  minutesLate: number;
  /** projected finish, epoch ms */
  projectedFinishAt: number;
  scheduledAt: number;
  reason: string;
}

/**
 * Project which in-flight jobs will run late for a company.
 *
 * Not a model call — this is arithmetic on live GPS + this tenant's own
 * historical durations, so it can safely run every minute for every company.
 */
export async function predictDelays(
  companyId: string,
  opts: { graceMins?: number } = {},
): Promise<DelayRisk[]> {
  const grace = opts.graceMins ?? 15;
  const out: DelayRisk[] = [];
  try {
    const jobs = await db
      .select()
      .from(schema.bookings)
      .where(
        and(
          eq(schema.bookings.companyId, companyId),
          inArray(schema.bookings.status, [...ACTIVE_STATUSES]),
          isNull(schema.bookings.deletedAt),
        ),
      );
    if (!jobs.length) return out;

    const svcRows = await db
      .select()
      .from(schema.services)
      .where(eq(schema.services.companyId, companyId));
    const svc = new Map(svcRows.map((s) => [s.id, s]));

    const techRows = await db
      .select()
      .from(schema.riders)
      .where(eq(schema.riders.companyId, companyId));
    const techs = new Map(techRows.map((t) => [t.id, t]));
    const userRows = techRows.length
      ? await db
          .select({ id: schema.user.id, name: schema.user.name })
          .from(schema.user)
          .where(inArray(schema.user.id, techRows.map((t) => t.userId)))
      : [];
    const names = new Map(userRows.map((u) => [u.id, u.name]));

    // per-service typical duration, computed once
    const typical = new Map<string, number>();
    for (const id of new Set(jobs.map((j) => j.serviceId))) {
      const t = await typicalDurationMins(companyId, id);
      typical.set(id, t ?? svc.get(id)?.durationMins ?? 60);
    }

    const now = Date.now();
    for (const j of jobs) {
      const dur = typical.get(j.serviceId) ?? 60;
      const sched = Number(j.scheduledAt);
      const tech = j.riderId ? techs.get(j.riderId) : null;
      let travelMins = 0;
      let travelNote = "";

      if (
        (j.status === "assigned" || j.status === "enroute") &&
        tech?.lat != null &&
        tech?.lng != null
      ) {
        const km = distKm(tech.lat, tech.lng, j.lat, j.lng);
        if (km <= MAX_SERVICE_RADIUS_KM) {
          travelMins = minsForKm(km);
          travelNote = `${travelMins} min drive still ahead (${km.toFixed(1)} km out)`;
        }
      }

      let projectedFinish: number;
      let basis: string;
      if (j.status === "in_progress" && j.startedAt) {
        const elapsed = (now - Number(j.startedAt)) / 60000;
        projectedFinish = now + Math.max(0, dur - elapsed) * 60000;
        basis = `on site ${Math.round(elapsed)} of ~${dur} typical min`;
      } else if (j.status === "arrived") {
        projectedFinish = now + dur * 60000;
        basis = `just arrived, ~${dur} min of work typical`;
      } else {
        // assigned / enroute: can't start before max(now + travel, scheduled)
        const start = Math.max(now + travelMins * 60000, sched);
        projectedFinish = start + dur * 60000;
        basis = travelNote || `not started yet, ~${dur} min of work typical`;
      }

      // the window we're measuring against: scheduled start + typical duration
      const dueBy = sched + dur * 60000;
      const minutesLate = Math.round((projectedFinish - dueBy) / 60000);
      if (minutesLate <= grace) continue;

      out.push({
        bookingId: j.id,
        title: j.title,
        address: j.address,
        status: j.status,
        riderId: j.riderId,
        techName: tech ? (names.get(tech.userId) ?? "") : "",
        minutesLate,
        projectedFinishAt: projectedFinish,
        scheduledAt: sched,
        reason: basis,
      });
    }
    out.sort((a, b) => b.minutesLate - a.minutesLate);
  } catch (e) {
    log.warn("ai-dispatch: delay prediction failed", {
      companyId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return out;
}
