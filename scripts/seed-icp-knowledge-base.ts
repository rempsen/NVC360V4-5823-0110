// One-off seed/reconcile script for icp_knowledge_base against the real
// 17-ICP research program (see task.md + industry-presets.ts header).
// Run with: bun --env-file=../../.env scripts/seed-icp-knowledge-base.ts
// (run from packages/web, or adjust the relative --env-file path)
//
// Retires the old ad-hoc pilot rows (flooring pilot content replaced with
// nothing — flooring is a real ICP but not yet deep-researched by the real
// pipeline, so it gets no KB row until it is; home_health_aide has no
// counterpart in the approved 17 and is deleted outright; hvac is deleted
// because it merged into hvac-plumbing in the real taxonomy — hvac-plumbing
// is Wave 2, not seeded yet either) and inserts the 4 Wave-1 rows sourced
// directly from the Google Drive research docs
// (Claude Projects/NVC360-Hub/ICPs/<slug>/03-Workflows-and-Best-Practices.md
// and 04-NVC360-App-Customization.md), approved by Dan 2026-07-27.

import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

const now = Date.now();

const STALE_IDS = ["flooring", "home_health_aide", "hvac"];

type Row = {
  industry: string;
  summary: string;
  bestPractices: string[];
  workflowNotes: string;
  terminologyNotes: string;
  toneRefinement: string;
  notificationRefinement: string;
  complianceNotes: string;
  sources: { title: string; url: string }[];
};

const rows: Row[] = [
  {
    industry: "home-builder-developer",
    summary:
      "Small-to-mid volume home builders and residential developers (5-150 closings/year, CAD $5M-$100M revenue). NVC 360's proven reference profile: Karma Developments/Glendale Estates ($25K delivered) validated the buyer-facing options/upgrade-pricing engine in production. The wedge is the options/design-studio selections workflow — buyers on a visual digital design studio spend ~35% more on upgrades, and most small/mid builders still run selections on spreadsheets, email and paper. CoConstruct (a competitor tool small builders love) is being retired by Buildertrend (no new projects after 2027-03-31), creating a switcher-motion opportunity.",
    bestPractices: [
      "Respond to every lead in <5 minutes (auto-ack + human follow-up <2h) — up to 21x qualification lift vs 30-minute response",
      "Run a dedicated online sales counselor (OSC) program — top programs hit 40% lead-to-appointment, 21% appointment-to-sale",
      "Lock structural/design selections before construction starts with milestone-tied cutoffs per option category",
      "Present options visually/interactively — lifts upgrade spend ~35% (Zonda Envision data)",
      "Price options to the nearest $5/$10 and prune non-performing SKUs yearly",
      "Set allowances at realistic market prices; encourage early showroom visits",
      "Require a signed, priced change order before work proceeds — digital processing cuts turnaround from ~24 days to ~3.5 days",
      "Keep a cumulative change-order log tied to contract value",
      "Sync POs and change-order deltas to trades in real time so wrong material doesn't show up on site",
      "Track permit-to-completion cycle time against the 7.6-month built-for-sale benchmark",
      "Send scheduled milestone photo updates to buyers (foundation, framing, drywall, finals)",
      "Run a structured digital walkthrough producing a Possession Certificate + tracked deficiency list (Manitoba-compliant)",
      "Triage warranty requests by tier (1/2/10-year); track aging and time-to-resolution as KPIs",
      "Survey buyers at 20-30 days, 5-6 months, and 10-11 months post-move-in",
    ],
    workflowNotes:
      "12 core workflows researched: (1) lead intake & online sales, (2) model/plan/lot & structural-options sale at contract, (3) design-studio colour & finish selections, (4) allowance management (custom/semi-custom), (5) change order management, (6) estimating/quoting/takeoff, (7) PO & vendor/trade coordination, (8) construction scheduling & cycle-time management, (9) buyer communication during the build, (10) pre-possession walkthrough & possession-day handoff, (11) warranty & deficiency service (1/2/10), (12) draw/progress billing & job costing. Lifecycle: lead intake -> model/lot/plan sale with structural options -> design-studio selections (milestone-tied cutoffs) -> permits -> construction (PO-driven trade scheduling) -> pre-possession walkthrough -> possession-day handoff with deficiency list -> 1/2/10-year warranty service. Only ~5% of builders consistently hit target margin within 1% despite 91% tracking job costs in real time — margin-variance reporting is a real gap. Change orders average ~10% of contract value and touch 75%+ of projects.",
    terminologyNotes:
      "Buyer (not customer/client) for the homebuyer; Superintendent for site lead; lots & plans (not jobs) for inventory; possession day (not closing/handoff in the generic sense) is the Manitoba/Canada term; Selections Studio / design studio for the colour & finish selection process; structural options vs finish/colour selections are distinct categories with different cutoff timing (structural must lock before framing).",
    toneRefinement:
      "Confident and milestone-driven, never salesy. Buyers are making the largest purchase of their life and are anxious about cost creep — always show the running total (base price + options + change orders) and never let a cutoff deadline hide in fine print. Warranty communications should acknowledge the issue before explaining the fix.",
    notificationRefinement:
      "Speed-to-lead alert (instant push + SLA countdown) to sales/OSC. Selection deadline reminders at 14/7/2 days to buyer + selections coordinator. Change order awaiting approval to buyer (e-sign) + builder PM. PO/schedule update to trade on po_issued_changed or schedule_shifted. Build milestone photo update to buyer on foundation/framing/drywall/finals. Warranty request aging alert at 7/14 days to warranty coordinator. Possession-day package ready at possession_date_minus_7 to buyer + site super.",
    complianceNotes:
      "Manitoba New Home Warranty Act requires registered builders to provide warranty through an approved provider (MBNHWP); possession-day inspection produces a Possession Certificate + deficiency list that starts warranty coverage. Standard North American warranty structure: 1-year workmanship / 2-year systems / 10-year structural. Manitoba's 6-8 ft frost depth affects foundation timing though modern crews build year-round with cold-weather practices.",
    sources: [
      { title: "NAHB Cost of Constructing a Home in 2024", url: "https://www.nahb.org/news-and-economics/housing-economics-plus/special-studies/special-studies-pages/cost-of-constructing-a-home-in-2024" },
      { title: "City of Winnipeg — 2025 housing starts, second-highest on record", url: "https://www.winnipeg.ca/news/2026-01-18-winnipeg-records-second-highest-housing-starts-citys-history-2025" },
      { title: "Buildertrend/CoConstruct official migration notice", url: "https://www.coconstruct.com/migration" },
      { title: "Zonda Envision — visual design studio upgrade spend", url: "https://zondahome.com/digital-solutions/envision-for-builders/" },
      { title: "Manitoba New Home Warranty Program", url: "https://www.mbnhwp.com/buying.html" },
      { title: "HousingWire — speed-to-lead conversion data", url: "https://www.housingwire.com/articles/speed-to-lead-homebuilders/" },
      { title: "Buildertrend 2026 Residential Playbook", url: "https://buildertrend.com/press-releases/press-releases-buildertrend-construction-data-report-2026/" },
    ],
  },
  {
    industry: "painting-decorating",
    summary:
      "Owner-operator to ~3-crew painting contractors, extremely fragmented industry (US $28.2B, 2025). Two segments matter: residential repaint (~40-45% gross margin) and builder-facing finishing subs (~25.9% gross margin, net-30/60 terms). Valour Decorating is a live NVC 360 customer in this exact ICP. Incumbents (PaintScout, DripJobs, Bolster) win the quote but are weak on scheduling, crew dispatch, and multi-stage job tracking — the Karma/Glendale options/upgrade engine transfers almost verbatim to good/better/best paint quotes. Winnipeg's exterior season is roughly late May-September (>=10C), the most compressed scheduling problem in North America.",
    bestPractices: [
      "Estimate from documented production rates (interior walls ~120 sq ft/hr for 2 coats, range 85-350 by surface/prep), never gut feel",
      "Job-cost every job: log actual vs estimated hours/gallons and feed it back into the rate book",
      "Respond to leads in minutes and automate follow-up drips — exclusive leads with fast response close 35-45% vs 5-15% for slow-follow-up shared leads",
      "Present tiered, option-rich interactive quotes — contractors using client-facing upgrades win 15% bigger jobs, 20% more often",
      "Lock a written room-by-room colour & sheen schedule (brand, colour code, sheen) before job start, with approval signature",
      "Use PCA P1/P4 industry standards for finish acceptance and touch-up responsibility (viewed at >=39 inches under finished lighting, no magnification)",
      "Fill the winter trough with interior & cabinet work; bank 25-30% of peak-season revenue for the off-season",
      "Take 25-50% deposits (30% typical); use milestone billing (30/40/30) on multi-day jobs",
      "Offer a written 1-2 year workmanship warranty in every proposal",
      "Measure cost-per-closed-job by lead source, not cost-per-lead",
      "Sequence punch-list paint after all other trades to avoid repeat mobilizations on builder work",
      "Price net-30/60 financing cost into builder/GC work since subs effectively finance builders for 1-2 months",
      "Use GPS-verified crew time tracking — 15 min/day of padded time across 8 painters is ~$11K/yr in leakage",
    ],
    workflowNotes:
      "12 core workflows: (1) lead intake & speed-to-contact, (2) on-site walkthrough & production-rate estimating, (3) quote presentation with tiered options & upgrades, (4) colour consultation & selection lock-in, (5) job scheduling & seasonal capacity planning, (6) crew dispatch & daily work orders, (7) multi-coat job stage tracking (prep->prime->coats->touch-up), (8) builder/GC production painting & draw-schedule billing, (9) punch list & closeout, (10) job costing & the estimate feedback loop, (11) invoicing/deposits/payment collection, (12) warranty/follow-up/repaint farming. Estimate-to-job conversion without re-entry is a named incumbent gap (DripJobs' manual sales-to-production handoff). Interior repaint cycles run 5-7 years and 87% of home sellers repaint at least one room before listing — a farmable recurring-revenue loop.",
    terminologyNotes:
      "Colour Schedule (not 'spec sheet') is the room-by-room colour/sheen/product register — a first-class object, not a note field. Production Jobs / Builder Accounts for the B2B builder-facing segment (lots, draws, punch lists). Stages: Protect/Prep -> Prime -> First Coat -> Second Coat -> Touch-up/Punch -> Complete. PDCA/PCA are the industry standards bodies referenced in contracts.",
    toneRefinement:
      "Warm and detail-confident. Customers are picking colours they will live with for years — reassure on the plan (surfaces, coats, colour codes) and be upfront and proactive about weather-driven exterior rescheduling rather than apologetic after the fact.",
    notificationRefinement:
      "Estimate follow-up nudge at 48h then repeat 5/10 days to owner/estimator + automated customer drip. Colour selection deadline reminder at job start minus 7 days if unapproved. Weather reschedule alert when forecast <10C or rain on a scheduled exterior day, to dispatcher + crew + customer. Crew day-sheet push the evening before a scheduled job day. Stage-complete customer update as the job advances through prep/prime/coat/touch-up. Warranty anniversary check-in at completion + 11 months. Repaint cycle reminder at completion + 5 years. Builder draw milestone alert when a linked builder job reaches Interior Finishing/Final Draw.",
    complianceNotes:
      "US: EPA RRP lead-safe rules for pre-1978 homes; some states cap deposits (e.g., 10%). PCA/PDCA Industry Standards (P1 'properly painted surface', P4 inspection & acceptance, P9 scope definitions) are the de facto quality reference cited in contracts. Canada: union side governed by IUPAT district councils; coatings regulation via CPCA/Health Canada VOC rules.",
    sources: [
      { title: "IBISWorld — US house painting & decorating contractors market size", url: "https://www.ibisworld.com/united-states/market-size/house-painting-decorating-contractors/5738/" },
      { title: "Bolster — painting contractor upgrade-tier win rates", url: "https://www.bolsterbuilt.com/painting" },
      { title: "PCA Industry Standards (P1/P4)", url: "https://www.pcapainted.org/industry-standards/" },
      { title: "PaintScout Capterra review — no scheduling/crew tracking", url: "https://www.capterra.com/p/201082/PaintScout/" },
      { title: "Winnipeg exterior painting season (>=10C window)", url: "https://paintwithpinnacle.com/blog/the-best-time-for-exterior-painting-in-winnipeg/" },
      { title: "Workyard — painting facts & statistics (repaint cycles, seller repaint rate)", url: "https://www.workyard.com/construction-management/painting-facts-statistics" },
    ],
  },
  {
    industry: "design-build",
    summary:
      "Owner-led design-build firms (5-25 employees, $1M-$10M revenue, 10-40 signed projects/year, avg job $75K-$500K+) selling design and construction under a single contract for renovations, additions, and whole-home remodels. SMLXL Projects (onboarding now) is a live customer in this exact ICP. Runs the full lifecycle NVC 360 covers (lead -> estimate -> schedule -> dispatch -> bill -> follow-up) plus a design phase with selections/allowances — a near-perfect superset of the options/upgrade pricing engine proven with Karma/Glendale. Explicitly excludes spec/production home builders (home-builder-developer) and build-only GCs (renovation-contractor) — the differentiator is design-led, single-contract responsibility.",
    bestPractices: [
      "Qualify leads with a multi-step form (project type, budget band, timeline, address) before booking a consult",
      "Sell the design phase as its own paid product (~2% of estimated project cost or flat fee) with defined deliverables before any drawings",
      "Treat design like production: run a milestone schedule spanning pre-construction AND construction with owner approvals defined up front",
      "Tie selections deadlines to the construction schedule; require e-sign-off with price delta at decision time to pre-empt change-order disputes",
      "Use fixed-price contracts only on fully-designed scope; use cost-plus (20-30% fee) when design runs concurrent with construction",
      "Run a formal design-to-production handoff checklist (drawings, selections % complete, permit status, budget assumptions) plus a pre-construction site walk",
      "Publish a baseline schedule visible to the client with slack built around inspection/permit gates",
      "Send a scheduled weekly client update (even when progress is slow) with 8-10 photos in a daily log",
      "Document change orders at identification, price before work proceeds, and get the client's e-signature on the number",
      "Tie every draw payment to a specific, verifiable milestone in writing before contract signing",
      "Run a 90-minute structured closeout walkthrough with a printed punch list, then survey at 1 week and again at 6-12 months",
      "Review job costs weekly during production (not post-mortem), tracked estimated-vs-actual by cost code",
    ],
    workflowNotes:
      "12 core workflows: (1) lead intake & prequalification, (2) paid design agreement sale (consultation -> retainer), (3) design-phase milestone management (feasibility -> schematic -> DD -> CDs), (4) selections & allowances management, (5) estimating & contract structuring (fixed-price vs cost-plus), (6) design-to-production handoff, (7) project scheduling & trade coordination, (8) client communication during construction (portal, daily logs), (9) change order management, (10) draw/progress billing & cash-flow management, (11) punch list/closeout/warranty follow-up, (12) job costing & slippage review. Slippage (gap between estimated and produced gross profit) is the industry's defining leak — 2024 US remodeler average is 29.9% gross / 6.3% net, well below the 8-10% net goal; over 10% of contractors name client selections their single biggest project-management challenge.",
    terminologyNotes:
      "Design Studio (phase-gated: feasibility -> schematic -> design development -> construction documents) is the differentiator vs plain GCs — first-class, not a job sub-tab. Selections Board (room-by-room selections with allowance/price-delta/deadline/approval) generalizes the Karma/Glendale options-tier engine. Draw Schedule (milestone-mapped payment schedule) is structurally different from service-ticket invoicing used by trades ICPs. Design agreement/retainer (not 'quote') for the paid pre-construction design phase.",
    toneRefinement:
      "Design-forward and consultative. Clients are making dozens of decisions across a design phase before a hammer swings — narrate progress through phase gates, not just task lists, and treat the design retainer as a real deliverable-bearing product, not a formality before the 'real' contract.",
    notificationRefinement:
      "Selection deadline approaching at 14/7/2 days before its schedule-linked deadline, to client + designer. Selection approved with price delta, to PM + estimator + bookkeeper. Change order awaiting signature if unsigned 48h, to owner + client. Draw milestone reached, to bookkeeper + client with auto-invoice prompt. Design phase gate approval when a schematic/DD/CD package is marked ready for client approval. Weekly client update digest compiled Fridays from the week's daily logs, photos, and next-week look-ahead. Warranty check-in at 6 and 12 months after closeout (RenoMark 2-year warranty compliance in Canada).",
    complianceNotes:
      "US: EPA RRP lead-safe rules for pre-1978 homes; state contractor licensing. Canada: provincial licensing, GST/PST; Winnipeg requires permits for most structural/addition work. CHBA RenoMark certification requires written contracts, minimum two-year warranty, licensing & insurance, and a code of ethics — a credibility layer worth surfacing to Canadian tenants. Residential construction is ~32.7% of Canada's underground economy — professional/licensed positioning is a real differentiator against cash-economy competitors.",
    sources: [
      { title: "NAHB Eye On Housing — US remodeling firm count growth", url: "https://eyeonhousing.org/2026/05/nahb-debuts-new-resource-that-estimates-quarterly-remodeling-spending-by-state/" },
      { title: "Zonda 2025 Cost vs. Value Report", url: "https://zondahome.com/2025-cost-vs-value-report/" },
      { title: "Altus Group — Canada renovation vs new-construction investment", url: "https://www.altusgroup.com/insights/canadas-shifting-fundamentals-are-reshaping-housing-and-construction/" },
      { title: "NAHB — 2024 remodeler gross/net margin data", url: "https://www.nahb.org/blog/2026/04/home-remodeling-profit-margin" },
      { title: "CHBA RenoMark", url: "https://renomark.ca/" },
      { title: "BuilderPad / Buildertrend — client selections as #1 PM challenge", url: "https://builderpad.com/selections" },
    ],
  },
  {
    industry: "renovation-contractor",
    summary:
      "Build-only renovation general contractors, $500K-$5M revenue, 2-10 field employees plus 8-20 trade subs, running 2-8 concurrent multi-week projects (kitchens 8-16 wks, baths 3-6 wks, whole-home 3-12 months). This is the named volume ICP for NVC 360's purchased Winnipeg lead list with live outbound motion — distinct from visit-based field service trades. Fixed-price quotes with allowances, progress billing, change orders, and sub coordination map directly onto the Karma/Glendale-proven options/estimating engine. Excludes design-led single-contract firms (design-build) and pure T&M service/repair work.",
    bestPractices: [
      "Respond fast with structured budget/scope/timeline qualification before booking a site visit — phone leads convert best (~46%) but only ~7.8% of raw leads become customers industry-wide",
      "Build markup from your own overhead + profit target, not competitor pricing; set allowances from what similar clients actually spent, not round guesses",
      "Put a selection schedule with deadlines in the contract; finalize selections before construction starts; keep a running allowance ledger showing budget vs actual",
      "Tie every draw to an objectively verifiable milestone in writing before contract signing; specify the change-order procedure and cost calculation upfront",
      "Use phase/dependency-based (Gantt/critical-path) scheduling with look-ahead windows, since one delayed trade cascades for weeks on a multi-week project",
      "Map trade sequences and send task-ready notifications so subs arrive when the site is actually ready — avoids trade stacking and idle subs",
      "Require a written, itemized, client-signed change order BEFORE work proceeds — never verbal field agreements priced later",
      "Send scheduled weekly updates with photos and a two-week look-ahead; flag delays proactively rather than letting clients discover them",
      "Job-cost continuously against estimate lines during production, not at month-end; track slippage per job against a <=2-point goal (industry average is ~7 points)",
      "Invoice automatically at milestone completion with photo documentation attached",
      "Sell winter interior slots in fall and book the exterior season from show-season leads to balance backlog across seasons",
      "Tie punch-list completion objectively to final payment; run a systematic review/referral ask at handover",
    ],
    workflowNotes:
      "12 core workflows: (1) lead intake & qualification, (2) estimating & fixed-price quoting with allowances, (3) selections & allowance management, (4) contract & payment schedule setup, (5) multi-week project scheduling, (6) subcontractor coordination & dispatch, (7) change order management, (8) client communication & progress updates, (9) job costing & margin tracking, (10) progress billing & collections, (11) seasonal pipeline & capacity planning, (12) closeout/punch list/warranty follow-up. 78% of homeowner renovation projects end over budget and 58% run longer than expected; industry slippage (estimated vs produced margin) averages ~7 points against a <=2-point best-practice goal — this is the single most software-addressable economic lever for this ICP. Winnipeg lead-list qualification: prioritize $750K-$5M revenue, 3+ week projects, fixed-price+allowances billing, 5+ selection categories, 5+ trades coordinated, deposit+draw billing; disqualify sub-$500K hobbyist/handyman and pure T&M service shops.",
    terminologyNotes:
      "Projects (phase timeline, Gantt-style board with dependencies) replaces the visit-based 'Jobs/Dispatch' default menu for this ICP — renovation GCs think in projects and phases, not visits. Selections & Allowances is the core differentiating workflow (allowance ledger + client selection portal). Site Lead (not 'technician') for the field role. Manitoba tenants get a 7.5% Builders' Liens Act holdback line on draw schedules by default.",
    toneRefinement:
      "Plain-spoken and reassuring under pressure. Most renovation clients have never managed a multi-week project before — be explicit about what's happening this week and what's coming next, and flag allowance overages before they become invoice surprises, not after.",
    notificationRefinement:
      "Change order awaiting signature when a CO is drafted and sent, to client. Selection deadline reminder at T-14/T-7/T-2, to client + PM. Draw invoice issued / payment reminder when a milestone is marked complete and the invoice is unpaid at T+3/T+7, to client. Site ready for your trade when a predecessor task completes, to the subcontractor. Allowance overage alert when a selection prices above allowance, to PM + client. Margin slippage alert when committed job costs cross a threshold vs estimate, to owner. Schedule ripple alert when a task delay pushes dependent tasks, to PM + affected subs.",
    complianceNotes:
      "Manitoba: Builders' Liens Act applies to residential contracts over $300 and entitles owners to hold back 7.5% of the total; direct sellers of home improvements need a licence. City of Winnipeg requires licensed trade contractors for mechanical/electrical permit work. RenoMark membership (where applicable) requires full licensing, written contracts on every job, $2M+ liability insurance, and a minimum 2-year warranty.",
    sources: [
      { title: "Harvard JCHS LIRA — US homeowner improvement spending projection", url: "https://www.jchs.harvard.edu/press-releases/continued-gains-projected-remodeling-amid-economic-uncertainty" },
      { title: "CHBA Renovation Market Index release", url: "https://www.chba.ca/2026/03/11/renovators-expect-challenging-market-conditions-ahead-insight-from-canadas-first-renovation-market-index-release/" },
      { title: "Clever survey — renovation budget/timeline overrun rates", url: "https://listwithclever.com/research/home-renovation-trends/" },
      { title: "Qualified Remodeler — margin/markup benchmarking (slippage)", url: "https://www.qualifiedremodeler.com/business-benchmarking-margin-markup/" },
      { title: "Manitoba Consumer Protection Office — Builders' Liens Act holdback", url: "https://www.gov.mb.ca/cp/cpo/info/home_improvements.html" },
      { title: "Winnipeg Renovation Show — local lead-gen anchor event", url: "https://www.winnipegrenovationshow.com/" },
    ],
  },
];

async function main() {
  console.log(`Deleting stale rows: ${STALE_IDS.join(", ")}`);
  for (const id of STALE_IDS) {
    await client.execute({
      sql: "DELETE FROM icp_knowledge_base WHERE industry = ?",
      args: [id],
    });
  }

  for (const r of rows) {
    console.log(`Upserting icp_knowledge_base row: ${r.industry}`);
    await client.execute({
      sql: `INSERT INTO icp_knowledge_base
              (industry, summary, best_practices, workflow_notes, terminology_notes,
               tone_refinement, notification_refinement, compliance_notes, sources,
               researched_by, researched_at, updated_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(industry) DO UPDATE SET
              summary = excluded.summary,
              best_practices = excluded.best_practices,
              workflow_notes = excluded.workflow_notes,
              terminology_notes = excluded.terminology_notes,
              tone_refinement = excluded.tone_refinement,
              notification_refinement = excluded.notification_refinement,
              compliance_notes = excluded.compliance_notes,
              sources = excluded.sources,
              researched_by = excluded.researched_by,
              researched_at = excluded.researched_at,
              updated_at = excluded.updated_at`,
      args: [
        r.industry,
        r.summary,
        JSON.stringify(r.bestPractices),
        r.workflowNotes,
        r.terminologyNotes,
        r.toneRefinement,
        r.notificationRefinement,
        r.complianceNotes,
        JSON.stringify(r.sources),
        "dan-icp-research-program",
        now,
        now,
        now,
      ],
    });
  }

  const { rows: check } = await client.execute("SELECT industry FROM icp_knowledge_base ORDER BY industry");
  console.log("icp_knowledge_base now contains:", check.map((row) => row.industry));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
