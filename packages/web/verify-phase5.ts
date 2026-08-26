/**
 * Phase 5 verification — real AI dispatch + delay prediction.
 *
 * Exercises the real running server on :4200 (tsc is not trustworthy in this
 * repo). Creates throwaway bookings and deletes every row it makes. Nothing
 * here assigns a tech to a real customer job, so no SMS is ever sent.
 *
 * Run from packages/web:
 *   bun --env-file=../../.env verify-phase5.ts
 */
import { Pool } from "pg";
import {
  scoreCandidates,
  heuristicReasoning,
  rankCandidates,
  typicalDurationMins,
  techWorkload,
  predictDelays,
  distKm,
  minsForKm,
} from "./src/services/ai-dispatch";

const BASE = "http://localhost:4200";
const EMAIL = "dan@nvc360.com";
const PASSWORD = "NVC423!!";
const COMPANY = "default";
const CUSTOMER = "6G8OQVJnUNnG388iGQs6Lw5sO5Q8nEQT";
const SERVICE = "52f2fc46-310a-45a5-9c0b-91c2941437cf";

const db = new Pool({ connectionString: process.env.DATABASE_URL! });

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${name}`,
      detail === undefined ? "" : JSON.stringify(detail).slice(0, 400),
    );
  }
}

const rid = () => crypto.randomUUID();
const tok = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

async function makeBooking(opts: {
  title: string;
  status?: string;
  riderId?: string | null;
  scheduledAt?: number;
  startedAt?: number | null;
  lat?: number;
  lng?: number;
  companyId?: string;
}) {
  const id = rid();
  const token = tok();
  await db.query(
    `insert into bookings
      (id, customer_id, service_id, rider_id, status, address, title, public_token,
       company_id, created_at, scheduled_at, started_at, lat, lng, priority)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'normal')`,
    [
      id,
      CUSTOMER,
      SERVICE,
      opts.riderId ?? null,
      opts.status ?? "pending",
      "1 Verify St",
      opts.title,
      token,
      opts.companyId ?? COMPANY,
      Date.now(),
      opts.scheduledAt ?? Date.now(),
      opts.startedAt ?? null,
      opts.lat ?? 43.6532,
      opts.lng ?? -79.3832,
    ],
  );
  return { id, token };
}

async function cleanup(ids: string[]) {
  for (const b of ids) {
    await db.query("delete from messages where booking_id = $1", [b]);
    await db.query("delete from notifications where booking_id = $1", [b]);
    await db.query("delete from job_events where booking_id = $1", [b]);
    await db.query("delete from bookings where id = $1", [b]);
  }
}

const created: string[] = [];

try {
  // ── auth ────────────────────────────────────────────────────────────────
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const cookie = (signIn.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  check("sign-in returns 200 + session cookie", signIn.status === 200 && !!cookie, {
    status: signIn.status,
  });
  if (!cookie) throw new Error("no session cookie — aborting");
  const auth = { cookie } as Record<string, string>;

  // =====================================================================
  // A. deterministic scorer (the fallback that must ALWAYS work)
  // =====================================================================
  console.log("\nA. deterministic scorer");

  const baseTech = {
    skills: "hvac,repair",
    skillClass: "HVAC",
    status: "available",
    color: "#0ea5e9",
    rating: 4.9,
    completedJobs: 10,
    openJobs: 0,
    freeInMins: 0,
  };
  const job = {
    id: "j1",
    title: "Furnace not firing",
    address: "1 Verify St",
    lat: 43.6532,
    lng: -79.3832,
    priority: "normal",
    scheduledAt: Date.now(),
  };
  const service = { name: "Furnace Repair", category: "HVAC", durationMins: 90 };

  const near = { ...baseTech, id: "near", name: "Near Nick", lat: 43.66, lng: -79.39 };
  const far = { ...baseTech, id: "far", name: "Far Fred", lat: 43.9, lng: -79.9 };
  const offline = { ...baseTech, id: "off", name: "Off Olive", lat: 43.654, lng: -79.384, status: "offline" };
  const noloc = { ...baseTech, id: "nol", name: "Nowhere Nora", lat: null, lng: null };
  const noskill = { ...baseTech, id: "nsk", name: "Skilless Sam", lat: 43.655, lng: -79.385, skills: "landscaping" };

  let s = scoreCandidates({ job, service, techs: [far, near], typicalMins: 90 });
  check("closer tech ranks first", s[0].techId === "near", s.map((x) => x.techId));
  check("distanceKm + etaMins computed", s[0].distanceKm != null && s[0].etaMins != null, s[0]);

  s = scoreCandidates({ job, service, techs: [offline, far], typicalMins: null });
  check("offline tech ranks below a far online tech", s[0].techId === "far", s.map((x) => x.techId));

  s = scoreCandidates({ job, service, techs: [noloc] });
  check("unknown location → distanceKm null (not a bogus number)", s[0].distanceKm === null, s[0]);
  check("unknown location → locationKnown false", s[0].locationKnown === false, s[0]);

  s = scoreCandidates({ job, service, techs: [noskill, far] });
  check("skillMatch detected correctly", s.find((x) => x.techId === "nsk")!.skillMatch === false && s.find((x) => x.techId === "far")!.skillMatch === true, s);

  // implausible distance is discarded rather than surfaced
  const antipode = { ...baseTech, id: "ap", name: "Antipode Al", lat: -33.86, lng: 151.2 };
  s = scoreCandidates({ job, service, techs: [antipode] });
  check("distance beyond service radius → null, not a bogus 16000km", s[0].distanceKm === null, s[0]);

  // NEW in phase 5: workload matters
  const busyNear = { ...near, id: "busy", name: "Busy Ben", openJobs: 3, freeInMins: 180 };
  s = scoreCandidates({ job, service, techs: [busyNear, far] });
  check(
    "a loaded nearby tech can lose to a free further tech (workload counts)",
    s[0].techId === "far",
    s.map((x) => ({ id: x.techId, score: x.score })),
  );
  check("openJobs + freeInMins surfaced on candidates", s.some((x) => x.openJobs === 3 && x.freeInMins === 180), s);

  const urgentJob = { ...job, priority: "urgent" };
  const su = scoreCandidates({ job: urgentJob, service, techs: [busyNear, far] });
  check("urgent job penalises a tech who isn't free soon", su[0].techId === "far", su.map((x) => x.techId));

  check("empty candidate list → empty ranking (no crash)", scoreCandidates({ job, service, techs: [] }).length === 0);

  // ── reasoning text ──
  const r1 = heuristicReasoning(scoreCandidates({ job, service, techs: [near] })[0]);
  check("fallback reasoning names the tech and the distance", !!r1 && r1.includes("Near Nick") && r1.includes("km away"), r1);
  const r2 = heuristicReasoning(scoreCandidates({ job, service, techs: [noloc] })[0]);
  check("fallback reasoning admits unknown location instead of asserting distance", !!r2 && r2.includes("Location data is unavailable"), r2);
  check("reasoning of null candidate is null", heuristicReasoning(null) === null);

  check("distKm(x,x) === 0", Math.round(distKm(43.6, -79.4, 43.6, -79.4)) === 0);
  check("minsForKm scales with distance", minsForKm(32) === 60, minsForKm(32));

  // =====================================================================
  // B. graceful fallback when the gateway is unavailable
  // =====================================================================
  console.log("\nB. fallback behaviour");

  const savedKey = process.env.AI_GATEWAY_API_KEY;
  check("AI_GATEWAY_API_KEY is set in this environment", !!savedKey);

  delete process.env.AI_GATEWAY_API_KEY;
  const noKey = await rankCandidates({ job, service, techs: [near, far], typicalMins: 90 });
  check('gateway unset → source "rules"', noKey.source === "rules", noKey.source);
  check("gateway unset → fallbackReason explains why", noKey.fallbackReason === "AI gateway not configured", noKey.fallbackReason);
  check("gateway unset → still returns a full ranking", noKey.ranked.length === 2 && !!noKey.best, noKey.ranked.length);
  check("gateway unset → still returns reasoning prose", !!noKey.reasoning, noKey.reasoning);
  if (savedKey) process.env.AI_GATEWAY_API_KEY = savedKey;

  const one = await rankCandidates({ job, service, techs: [near], typicalMins: null });
  check("single candidate skips the model call (no spend)", one.source === "rules" && one.fallbackReason === "only one candidate", one.fallbackReason);

  const allOffline = await rankCandidates({ job, service, techs: [offline], typicalMins: null });
  check("all-offline field skips the model call", allOffline.source === "rules", allOffline.fallbackReason);

  const timedOut = await rankCandidates({ job, service, techs: [near, far], typicalMins: 90 }, { timeoutMs: 1 });
  check("model timeout falls back cleanly instead of throwing", timedOut.source === "rules" && !!timedOut.best, timedOut.fallbackReason);

  // =====================================================================
  // C. the model path
  // =====================================================================
  console.log("\nC. model ranking");

  const ai = await rankCandidates(
    { job, service, techs: [far, near, noskill, noloc], typicalMins: 95 },
    { workerNoun: "technician" },
  );
  console.log(`     source=${ai.source}${ai.fallbackReason ? ` (${ai.fallbackReason})` : ""}`);
  check('model ranking returns source "ai"', ai.source === "ai", { source: ai.source, why: ai.fallbackReason });
  check("model ranking covers every online candidate exactly once", new Set(ai.ranked.filter((c) => c.status !== "offline").map((c) => c.techId)).size === 4, ai.ranked.map((c) => c.techId));
  check("every ranked candidate id is real (nothing hallucinated)", ai.ranked.every((c) => ["far", "near", "nsk", "nol"].includes(c.techId)), ai.ranked.map((c) => c.techId));
  check("each candidate carries a plain-English rationale", ai.ranked.every((c) => !!c.rationale && c.rationale.length > 10), ai.ranked.map((c) => c.rationale));
  check("summary reasoning present", !!ai.reasoning && ai.reasoning.length > 15, ai.reasoning);
  check("measured numbers are unchanged by the model", ai.ranked.find((c) => c.techId === "nol")!.distanceKm === null && ai.ranked.find((c) => c.techId === "near")!.distanceKm === scoreCandidates({ job, service, techs: [near] })[0].distanceKm, ai.ranked.map((c) => [c.techId, c.distanceKm]));
  if (ai.source === "ai") {
    console.log(`     top pick: ${ai.best?.name} — ${ai.best?.rationale}`);
    console.log(`     summary : ${ai.reasoning}`);
  }

  // =====================================================================
  // D. history + workload helpers
  // =====================================================================
  console.log("\nD. history + workload");

  const typ = await typicalDurationMins(COMPANY, SERVICE);
  check("typicalDurationMins returns a number or null (never throws)", typ === null || (typeof typ === "number" && typ > 0), typ);
  check("typicalDurationMins with no serviceId → null", (await typicalDurationMins(COMPANY, null)) === null);

  const someTech = await db.query(
    "select id from riders where company_id = $1 limit 1",
    [COMPANY],
  );
  const techId = (someTech.rows[0]?.id as string) ?? null;
  check("tenant has at least one technician to test workload with", !!techId);

  if (techId) {
    const b1 = await makeBooking({ title: "Phase5 Load A", status: "assigned", riderId: techId, scheduledAt: Date.now() });
    created.push(b1.id);
    const load = await techWorkload(COMPANY, new Map([[SERVICE, 60]]));
    check("techWorkload counts the tech's open stop", (load.get(techId)?.openJobs ?? 0) >= 1, load.get(techId));
    check("techWorkload projects freeInMins > 0 for a loaded tech", (load.get(techId)?.freeInMins ?? 0) > 0, load.get(techId));
  }

  // =====================================================================
  // E. delay prediction
  // =====================================================================
  console.log("\nE. delay prediction");

  const baseline = await predictDelays(COMPANY);
  check("predictDelays returns an array", Array.isArray(baseline), typeof baseline);

  if (techId) {
    // a job that started 6 hours ago and is still in_progress is definitively late
    const late = await makeBooking({
      title: "Phase5 Late Job",
      status: "in_progress",
      riderId: techId,
      scheduledAt: Date.now() - 6 * 3600_000,
      startedAt: Date.now() - 6 * 3600_000,
    });
    created.push(late.id);
    const risks = await predictDelays(COMPANY);
    const mine = risks.find((r) => r.bookingId === late.id);
    check("a 6-hour-overrun job is flagged as at risk", !!mine, risks.map((r) => r.title));
    check("minutesLate is a positive number", (mine?.minutesLate ?? 0) > 0, mine?.minutesLate);
    check("risk carries a human-readable reason", !!mine?.reason && mine.reason.length > 5, mine?.reason);
    check("risk carries the tech name", typeof mine?.techName === "string", mine?.techName);
    check("risks are sorted worst-first", risks.every((r, i) => i === 0 || risks[i - 1].minutesLate >= r.minutesLate), risks.map((r) => r.minutesLate));

    // a job just scheduled to start now is NOT late
    const fine = await makeBooking({
      title: "Phase5 On Time Job",
      status: "assigned",
      riderId: techId,
      scheduledAt: Date.now() + 4 * 3600_000,
    });
    created.push(fine.id);
    const risks2 = await predictDelays(COMPANY);
    check("a job scheduled well in the future is NOT flagged", !risks2.some((r) => r.bookingId === fine.id), risks2.map((r) => r.title));

    // grace window is respected
    const wide = await predictDelays(COMPANY, { graceMins: 100_000 });
    check("a huge grace window suppresses all risk", wide.length === 0, wide.length);

    // tenant isolation
    const otherCo = await predictDelays("__nonexistent_company__");
    check("predictDelays is tenant-scoped (unknown company → none)", otherCo.length === 0, otherCo.length);
  }

  // =====================================================================
  // F. HTTP endpoints
  // =====================================================================
  console.log("\nF. endpoints");

  const bk = await makeBooking({ title: "Phase5 Suggest Job" });
  created.push(bk.id);

  const anonSuggest = await fetch(`${BASE}/api/ai/suggest-tech/${bk.id}`, { method: "POST" });
  check("POST /api/ai/suggest-tech unauthenticated → 401", anonSuggest.status === 401, { status: anonSuggest.status });

  const t0 = Date.now();
  const sg = await fetch(`${BASE}/api/ai/suggest-tech/${bk.id}`, { method: "POST", headers: auth });
  const sj: any = await sg.json();
  const ms = Date.now() - t0;
  check("POST /api/ai/suggest-tech → 200", sg.status === 200, { status: sg.status, body: sj });
  console.log(`     responded in ${ms}ms, source=${sj.source}`);
  check("response keeps the legacy shape (best, ranked, confident, reasoning)", "best" in sj && Array.isArray(sj.ranked) && typeof sj.confident === "boolean" && "reasoning" in sj, Object.keys(sj));
  check('response adds source ("ai" | "rules")', sj.source === "ai" || sj.source === "rules", sj.source);
  check("response adds typicalMins", "typicalMins" in sj, Object.keys(sj));
  check("ranked candidates carry names + measured distance fields", sj.ranked.every((r: any) => "name" in r && "distanceKm" in r && "etaMins" in r && "openJobs" in r), sj.ranked?.[0]);
  check("ranked is capped at 5", sj.ranked.length <= 5, sj.ranked.length);
  if (sj.best) {
    check("best.techId is present in ranked", sj.ranked.some((r: any) => r.techId === sj.best.techId), sj.best.techId);
    check("reasoning is non-empty prose", typeof sj.reasoning === "string" && sj.reasoning.length > 10, sj.reasoning);
  }

  const missing = await fetch(`${BASE}/api/ai/suggest-tech/${rid()}`, { method: "POST", headers: auth });
  check("suggest-tech for unknown booking → 404", missing.status === 404, { status: missing.status });

  const anonRisk = await fetch(`${BASE}/api/ai/delay-risk`);
  check("GET /api/ai/delay-risk unauthenticated → 401", anonRisk.status === 401, { status: anonRisk.status });

  const rr = await fetch(`${BASE}/api/ai/delay-risk`, { headers: auth });
  const rj: any = await rr.json();
  check("GET /api/ai/delay-risk → 200", rr.status === 200, { status: rr.status });
  check("delay-risk returns { risks[], count }", Array.isArray(rj.risks) && rj.count === rj.risks.length, rj);

  const rrg = await fetch(`${BASE}/api/ai/delay-risk?graceMins=100000`, { headers: auth });
  const rjg: any = await rrg.json();
  check("delay-risk honours ?graceMins", rjg.count === 0, rjg.count);

  // existing route still intact
  const ridersRes = await fetch(`${BASE}/api/riders`, { headers: auth });
  const ridersJson: any = await ridersRes.json();
  const anyTech = ridersJson.riders?.[0]?.id;
  if (anyTech) {
    const opt = await fetch(`${BASE}/api/ai/optimize-route/${anyTech}`, { headers: auth });
    const oj: any = await opt.json();
    check("GET /api/ai/optimize-route still works (not broken by the rewrite)", opt.status === 200 && Array.isArray(oj.stops), { status: opt.status });
  }

  // scheduler page still serves
  const page = await fetch(`${BASE}/admin/scheduler`, { headers: auth });
  check("/admin/scheduler serves the SPA shell (200)", page.status === 200, { status: page.status });
} finally {
  await cleanup(created);
  console.log(`\ncleaned up ${created.length} throwaway booking(s)`);
  console.log(`\nPhase 5: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
