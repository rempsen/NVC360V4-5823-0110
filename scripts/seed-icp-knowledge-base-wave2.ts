// Wave 2/3 seed for icp_knowledge_base — the remaining 13 of 17 ICPs (Wave 1's
// four — home-builder-developer, painting-decorating, design-build,
// renovation-contractor — were seeded in scripts/seed-icp-knowledge-base.ts).
// Sourced directly from Claude Projects/NVC360-Hub/ICPs/<slug>/
// 03-Workflows-and-Best-Practices.md + 04-NVC360-App-Customization.md,
// approved research pass 2026-07-27. Run with:
//   bun --env-file=../../.env scripts/seed-icp-knowledge-base-wave2.ts
// (from packages/web, or adjust the relative --env-file path)

import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

const now = Date.now();

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
    industry: "electrical",
    summary:
      "Dual-motion electrical contractors (residential/commercial service calls plus new-construction builder rough-ins), 5-25 field techs, $1M-$5M+ revenue, largest firm count of any trade researched. The wedge: builder options/upgrade selection management (pot lights, panel upsizing, EV rough-ins) is structurally identical to the Karma/Glendale options-pricing engine — new-construction electrical installs run 40-50% cheaper than retrofit, so missed rough-in selections cost buyers real money. Two regulatory authorities in Manitoba (City of Winnipeg Permits Online + Manitoba Hydro ePermits) with licence-linked permit conditions add a compliance layer no generic FSM tool models.",
    bestPractices: [
      "Segment lead intake by motion (service vs builder) and urgency — mixed residential/commercial books buffer seasonality",
      "Run a digital flat-rate price book for service work; blend with T&M deliberately for exploratory/commercial scopes",
      "Standardize builder option catalogues with per-item pricing (pot lights $65-175 installed, panel upsizing, EV rough-ins) — this is the Karma/Glendale motion applied to the sub",
      "Track permit number, authority, status, and deadline per job; treat quarterly logbook entries as a by-product of normal job documentation, not a separate task",
      "Run a pre-inspection walkthrough with the foreman before calling the inspector; reinspection fees run 50-100% of the original fee",
      "Use certification-aware dispatch — validate journeyperson/apprentice ratio composition before assigning a crew",
      "Write change orders with direct + indirect + productivity-impact costs before work proceeds; change-hours over 10% of base contract enter cumulative-impact territory that degrades productivity on ALL work",
      "Invoice from field-captured data same-day; tie holdback/retainage release to the final-inspection trigger, not a calendar date",
      "Run a $99-199/yr membership/service-agreement program — membership retention runs mid-90s% vs 65-70% for non-members",
      "Build an insurance-driven rewire pipeline: Winnipeg has ~30,000-35,000 homes with knob-and-tube wiring and insurers often give only 30 days to remove it once flagged",
    ],
    workflowNotes:
      "12 core workflows: (1) lead intake & triage (service vs builder), (2) service estimating & flat-rate quoting, (3) construction bidding & takeoff for builder rough-ins, (4) builder options & upgrade selection management (the wedge), (5) permit pull & tracking across two authorities, (6) inspection scheduling & pass management, (7) scheduling & dispatch (dual board — service urgencies vs multi-week builder phases), (8) crew licensing & compliance management, (9) on-site execution & job documentation, (10) change order management, (11) invoicing/progress billing/holdback, (12) service agreements & upgrade follow-up. Competitive bidding compresses construction-side margin to 25-35% vs 40-50%+ on service work, which drives dispatch prioritization toward service calls when both compete for capacity.",
    terminologyNotes:
      "Dual dispatch board: Service Board vs Builder Projects. Upgrade Catalogue (not 'options list') for the builder-sub selection tiers — pot lights, panel 100->200A, EV charger, surge protection, generator, solar rough-in. Crew & Licences (not 'staff') tracks licence class, Certificate of Qualification #, expiry, and apprentice ratios. Permits & Inspections spans both City of Winnipeg and Manitoba Hydro authorities.",
    toneRefinement:
      "Safety-first and precise. Electrical work makes people nervous about fire/shock risk — be explicit about what was fixed, that it's now safe, and current permit/inspection status. For builder-side communication, be precise about selection cutoffs since missed rough-in windows are expensive to fix later.",
    notificationRefinement:
      "Inspection result posted (pass/fail/partial) to owner + builder/GC contact + homeowner. Permit inactivity warning at 5 months after issue with no work-started record (Winnipeg charges fees past 6 months). Licence expiry reminders at 60/30/7 days before provincial or City licence expiry. Quote follow-up nudge at 48h with no response. Options cutoff countdown at 14/7/2 days before a builder rough-in selection deadline. Quarterly logbook due 2 weeks before quarter end on any annual permit. Holdback release trigger when final inspection passes on a progress-billed job.",
    complianceNotes:
      "Manitoba: refrigeration & electrical trades governed by provincial licensing (Certificate of Qualification / registered apprentice); City of Winnipeg contractor licence is voided if the underlying provincial licence expires. Two permit authorities: City of Winnipeg Permits Online (in-city) and Manitoba Hydro ePermits (outside city, requires valid journeyperson licence). Annual permits require quarterly logbooks submitted before inspections can be booked. Efficiency Manitoba rebate work requires registered-contractor status.",
    sources: [
      { title: "ServiceTitan — Electrical Contractor Price Book", url: "https://www.servicetitan.com/blog/electrical-contractor-price-book" },
      { title: "City of Winnipeg — Electrical Contractor Licensing", url: "https://www.winnipeg.ca/building-development/building-renovating/trade-information-contractor-licensing/contractor-licensing/electrical-contractor-information" },
      { title: "Manitoba Hydro — Contractor Permits", url: "https://www.hydro.mb.ca/service/permits/contractors/" },
      { title: "ELECTRI International — Cumulative Impact of Change Orders", url: "https://www.electri.org/product/quantifying-the-cumulative-impact-of-change-orders-for-electrical-contractors/" },
      { title: "HomeGuide — Recessed Lighting Installation Cost", url: "https://homeguide.com/costs/cost-to-install-recessed-lighting" },
      { title: "Expert Electric Winnipeg — Knob-and-Tube Insurance", url: "https://expertelectricwinnipeg.com/can-i-get-homeowners-insurance-with-my-knob-and-tube-wiring/" },
    ],
  },
  {
    industry: "exteriors",
    summary:
      "Multi-line residential exteriors firms (roof + siding + soffit/fascia + eavestrough + windows/doors as a trade line), 2-10 crews, $1M-$10M revenue. The wedge: material-tier options quoting (shingle grades, siding lines, colour/trim packages) maps 1:1 onto the Karma/Glendale upgrade-pricing engine — 62% of high-profitability roofing companies quote good/better/best, homeowners pick the middle tier ~60% of the time, and options-based proposals lift average job value 30-40%. Winnipeg sits in Canada's hail belt (MPI logged ~9,300 hail claims in 2024, 40,000+ since 2021) which drives a spiky insurance/storm demand engine alongside steady retail replacement work.",
    bestPractices: [
      "Respond to every lead within 5 minutes — 21x more likely to win the estimate; 40%+ of homeowners take the first responder",
      "Present same-day tiered proposals (good/better/best material tiers) with e-signature and an auto-generated deposit invoice (25-40%) on signing",
      "Standardize on per-job aerial measurement reports (EagleView/Hover/Roofr/GAF QuickMeasure) feeding material quantities directly into the estimate — integrate, don't build a measurement engine",
      "Take 25+ annotated, GPS/timestamped photos per job compiled into a shareable PDF report — before/after comparisons drive referrals",
      "Run a multi-day crew calendar with a weather-hold lane and weekly makeup buffer slots; push reassignment details to crews' phones in under 10 minutes",
      "Order material from the priced estimate and track delivery against the production date so crews never arrive before shingles do",
      "Bill on milestones (deposit -> tear-off/material delivery -> completion), invoice within 24h, offer one-click digital payment — automated invoicing collects 92% of payments within 15 days vs 68% for paper",
      "Run a post-job email sequence (warranty docs, review ask, referral offer) — lifts repeat business 25.5%",
      "Bundle roof + eavestrough/soffit/fascia (15-25% homeowner savings, higher average job value) — cross-sell is the reason the multi-line ICP exists",
      "Offer a documented free hail-assessment pack that works with all major Manitoba insurers as the local storm-response motion",
    ],
    workflowNotes:
      "12 workflows: (1) lead intake & speed-to-lead, (2) roof/exterior inspection & photo documentation, (3) aerial measurement & takeoff, (4) material-tier options quoting (the wedge), (5) proposal delivery/e-sign/deposit, (6) material ordering & supplier coordination, (7) production scheduling & weather-driven dispatch, (8) crew & subcontractor management, (9) insurance-claim support (Canadian retail-first, not US-style storm-chasing — claim fields only, no supplements engine), (10) progress billing/final invoice/collections, (11) warranty registration & post-job follow-up, (12) multi-trade cross-sell & off-season pipeline. Retail-weighted books command 5.5x-7.5x SDE at exit vs storm-dependent books — the platform should support the steadier retail motion as the default, insurance as a secondary lane.",
    terminologyNotes:
      "Trade Lines (Roofing / Siding / Soffit-Fascia / Eavestrough / Windows & Doors) as the primary job-type filter — multi-line firms are 'four businesses in one.' Material Tier Catalog for good/better/best shingle grades, siding lines, colour/trim packages. Production Board (not 'schedule') is the daily-driver screen with a weather-hold lane. Measurement Reports live on the job record, not in email.",
    toneRefinement:
      "Confident and weather-aware. Roofing/siding customers worry about leaks and cost surprises — present tiered material options clearly, communicate weather-hold delays proactively before the customer has to ask, and lead manufacturer certification/warranty tiers as a trust signal.",
    notificationRefinement:
      "New lead 5-minute SLA alert to owner/sales rep (push+SMS) when a lead sits unclaimed. Weather-hold reschedule notice to homeowner + crew lead on status change. Material delivery confirmation to production manager + crew lead. Payment milestone reminder to homeowner at signing/tear-off/completion, unpaid 3 days. Post-job warranty + review sequence at +3 days / +30 days. Hail-event response prompt to all open leads/customers in the affected area on a manual storm-event flag.",
    complianceNotes:
      "City of Winnipeg requires a building permit for roof replacement, filed via Permits Online; certain trades require city-licensed contractors. MHBA RenoMark criteria (written contracts, 2-year minimum workmanship warranty, permits pulled) apply to renovator members. Manufacturer certification tiers (GAF Master Elite ~2-3% of contractors, CertainTeed SELECT ShingleMaster ~1%) gate the best homeowner warranties and act as de facto quality regulation.",
    sources: [
      { title: "Fixr — US Roofing Industry Statistics", url: "https://www.fixr.com/articles/us-roofing-industry-statistics" },
      { title: "JobNimbus — Good/Better/Best Roofing Estimate Example", url: "https://www.jobnimbus.com/blog/good-better-best-roofing-estimate-example" },
      { title: "CBC — Manitoba hail claims 2024", url: "https://amp.cbc.ca/lite/story/1.7255600" },
      { title: "City of Winnipeg — Home Renovations Permits", url: "https://www.winnipeg.ca/building-development/building-renovating/home-improvement-projects/home-renovations" },
      { title: "Owl Roofing — Roofing Certifications Explained", url: "https://mplsroofing.com/blog/roofing-certifications-explained/" },
    ],
  },
  {
    industry: "hvac-plumbing",
    summary:
      "Combined mechanical shops (HVAC + plumbing under one roof), 5-25 field techs, $1M-$5M revenue — the highest proven willingness-to-pay of any trade researched. The wedge: install quoting with good/better/best equipment tiers (furnace/AC/HRV) is structurally identical to the Karma/Glendale buyer-facing upgrade tiers; contractors offering 4 quote options close at 52% vs 42% for 1-3 options, average tickets ~$8,100. Sits in the underserved middle: ServiceTitan starts ~$245/tech/month with $5K-50K implementation, Jobber works well only up to ~8-10 people — the $1-5M shop that outgrew Jobber but is priced out of ServiceTitan is NVC 360's target gap.",
    bestPractices: [
      "Send an on-the-way SMS with tech name, photo, and ETA on every dispatch — builds trust and reduces no-access visits",
      "Run a hybrid pricing model: flat-rate price book dominant for residential repair, T&M reserved for diagnostics and unpredictable scopes",
      "Present replacement/install quotes as good/better/best — 4-option quotes close at 52% vs 42% for fewer options; quotes delivered within 4 hours close at 48% vs 29% after 24 hours",
      "Run a membership/service-agreement program targeting 30-40% of total revenue — recurring agreements already capture more than half of service revenue industry-wide and price at $19-35/month",
      "Track maintenance visit due dates (spring AC / fall furnace) and chase them — unbooked PM is exactly what starves shoulder-season revenue",
      "Watch renewal dates and failed payments on memberships — silent lapses are the main leak against the 80%+ retention benchmark",
      "Prioritize dispatch toward install/replacement jobs, which generate 3-5x the revenue of a standard service call",
      "Pre-stage on-call roster and parts ahead of extreme-weather demand surges (cold-climate no-heat calls are existential, not discretionary)",
      "Track and chase Efficiency Manitoba rebate applications through submitted/approved/paid stages — customers chase $1,500-2,000 rebates and offices lose track",
    ],
    workflowNotes:
      "Four revenue engines: demand/emergency service, replacement/install sales (quoted in tiers, often financed), recurring service agreements/memberships, and new-construction subcontract rough-in/trim-out work for builders. Peaks in winter (heating) and summer (cooling) with 30-50% revenue drops in shoulder seasons — membership revenue is explicitly the shoulder-season insurance policy. Shops with strong membership/recurring revenue sell at ~6x EBITDA vs ~4x for new-construction-dependent shops.",
    terminologyNotes:
      "Price Book for the flat-rate service task catalogue. Memberships (not 'maintenance plans') with a season-flip PM generator (spring AC / fall furnace). GBB install quote template for good/better/best equipment tiers. Dispatch board priority separates emergency/demand calls from scheduled install work. Efficiency MB rebate fields track the rebate application lifecycle.",
    toneRefinement:
      "Direct, reassuring, and urgency-aware. HVAC/plumbing customers are often uncomfortable (too hot/cold) or dealing with active water damage. Lead with ETA and a clear fix, not jargon; on cold-climate no-heat calls, treat urgency as the default assumption, not an escalation.",
    notificationRefinement:
      "Tech-on-the-way SMS (name, photo, ETA) to customer on dispatch->en route. Maintenance visit due reminder to customer when a membership PM interval is reached. Membership renewal & failed-payment alert at renewal -30d or on payment failure, to customer + office. Unsold-estimate follow-up nudge at 48h/7d/30d without acceptance. Extreme-weather surge alert to dispatcher/owner when forecast crosses a cold/heat threshold. Rebate application status update to customer + office on stage change.",
    complianceNotes:
      "Manitoba: refrigeration & air-conditioning mechanic is a compulsory-certification trade (Man Reg 70/2012); gasfitters/plumbers train through Apprenticeship Manitoba with Red Seal pathways. Gas and plumbing permits attach to jobs. Efficiency Manitoba rebate work requires registered-contractor status and a CSA F280 load calculation submitted with the application. US shops add state licensing and EPA 608 refrigerant handling tracked via equipment records.",
    sources: [
      { title: "Grand View Research — North America HVAC Services Market", url: "https://www.grandviewresearch.com/industry-analysis/north-america-hvac-services-market-report" },
      { title: "Projul — ServiceTitan Pricing Analysis 2026", url: "https://projul.com/blog/servicetitan-pricing-analysis-2026/" },
      { title: "HVAC Proposal Kit — Good/Better/Best HVAC Proposal", url: "https://hvacproposalkit.com/blog/guides/good-better-best-hvac-proposal" },
      { title: "FieldEdge — HVAC Service Agreement Programs", url: "https://fieldedge.com/blog/hvac-service-agreement-programs/" },
      { title: "Efficiency Manitoba — Air Source Heat Pump Program", url: "https://efficiencymb.ca/ashp-home/" },
    ],
  },
  {
    industry: "landscaping-grounds-snow",
    summary:
      "Landscaping, lawn care & grounds maintenance firms that also run snow & ice management — in Winnipeg these are the same companies. Research calls this 'probably the single best local-density story NVC 360 has.' Storm-triggered 3am dispatch, per-push/seasonal/hybrid billing structures, and proof-of-service photo notifications map directly onto NVC 360's dispatch/notification strengths, and slip-and-fall liability defense (GPS-verified timestamped visit logs) is a genuine, underserved need — claimants have up to two years to file in much of Canada.",
    bestPractices: [
      "Capture every lead in one shared queue with automated acknowledgment — crews physically cannot answer calls while operating equipment",
      "Estimate from real, tracked production rates (area serviced per crew-hour), not gut feel; compare estimated vs actual on every job and feed variances back",
      "Run a deliberate portfolio mix across per-push, seasonal-flat, and hybrid snow contracts — price seasonal at per-push x average events + 20-25% margin + 10-15% weather buffer",
      "Write trigger depth, SLA response window, and storm-event definition explicitly into every snow contract — disputes happen when these are left implicit",
      "Capture GPS-verified arrival/departure, timestamped before/after photos, and de-icing material applied on every winter visit — this is the primary slip-and-fall liability defense, and premiums escalate ~4x after one open claim",
      "Route by density and priority tier; sequence spring/fall cleanups by neighbourhood — optimized routing lets operators handle up to 30% more jobs per shift",
      "Bill seasonal contracts as monthly installments (Nov-Apr) to stabilize cash flow, with per-event billing layered on top to capture upside in heavy winters",
      "Start snow-contract renewal outreach before the season ends — renewals are otherwise a manual fall scramble on top of cleanup season",
      "Send proactive pre-storm and completion notifications with timestamped photos — cuts storm-day inbound call volume and prevents billing disputes",
      "Offer fence/deck/hardscape as productized service-line templates with good/better/best option tiers rather than ad hoc quoting — direct reuse of the options-tier engine",
    ],
    workflowNotes:
      "12 workflows spanning both green-season and winter operations: lead intake, production-rate estimating, seasonal snow-contract structuring (per-push/seasonal/hybrid), storm monitoring & triggered dispatch, route planning, proof-of-service documentation (liability defense), spring/fall cleanup surge scheduling, irrigation startup/blowout scheduling, billing across mixed contract types, seasonal workforce/on-call staffing, customer communication, and service-line expansion (fence/deck/hardscape). The single biggest workforce pain point is quality seasonal labor (52% of operators cite it) given harsh, unpredictable winter conditions.",
    terminologyNotes:
      "Season toggle (Green/Winter) switches the tenant's operating mode. Winter Ops storm board is a distinct dispatch view from summer routes. Routes (not 'jobs list') for the day's sequenced stops. Winter site profile + visit log carries the liability documentation pack (trigger depth, GPS times, photos, material applied). Per-push / seasonal / hybrid are the three billing-rule types a contract can carry.",
    toneRefinement:
      "Reliable and proof-driven. Customers want to know the job got done (driveway cleared, lawn mowed) without watching it happen — lead notifications with timestamped photo proof rather than just a status update.",
    notificationRefinement:
      "Storm watch notice to customer when forecast crosses their site's contract trigger threshold. Crew storm callout to crew leads/drivers when the dispatcher declares a storm event — replaces the 3am phone tree. Service completed w/ photo proof to customer on job completion. Seasonal contract renewal reminder at 60/30 days before season start, to customer + owner. Irrigation blowout booking window on a date window or first-frost forecast trigger. Cleanup status/delay notice when queue position changes or a weather delay is logged.",
    complianceNotes:
      "Align winter operations with ANSI/ASCA A1000 snow and ice management standard. Slip-and-fall claim windows run up to two years in much of Canada, making durable, timestamped records essential — not optional. No trade-specific licensing beyond general business/contractor registration in Manitoba.",
    sources: [
      { title: "National Facility Contractors — Snow Trigger Guide", url: "https://nationalfacilitycontractors.com/snow-removal/snow-trigger-guide-for-facility-managers/" },
      { title: "Lessen — Slip-and-Fall Claim Prevention Tracking", url: "https://www.lessen.com/resources/3-things-you-should-track-to-help-fight-slip-and-fall-claims-this-winter" },
      { title: "Insurance Business Canada — Snow Removal Premium Escalation", url: "https://www.insurancebusinessmag.com/ca/news/commercial-liability/insurance-premiums-continue-to-snowball-for-alberta-snow-removal-crews-312994.aspx" },
      { title: "OptimoRoute — Snow Removal Routing", url: "https://optimoroute.com/snow-removal-routing/" },
      { title: "SIMA — Seasonal Staffing Plan", url: "https://resources.sima.org/snow-and-ice-resource-center/build-a-seasonal-staffing-plan" },
    ],
  },
  {
    industry: "commercial-building-maintenance",
    summary:
      "Multi-trade contractors on recurring commercial site contracts (offices, retail, industrial, institutional), 5-100 employees, $500K-$20M revenue — overwhelmingly micro/small (54.6% of the broader NAICS 5617 category are 1-4 employees). Recurring-revenue contracts + SLA-driven work orders + PM scheduling + mixed contract/T&M billing is exactly NVC 360's existing job-scheduling/dispatch/billing spine; the industry-customization layer (SLA fields, PM calendars, proof-of-service checklists) is menu/template work on top of proven architecture, not new engineering. Sits underserved between cleaning-only apps (Swept, Janitorial Manager) and enterprise CMMS (ServiceChannel, Corrigo).",
    bestPractices: [
      "Run a single intake funnel with a structured triage matrix (emergency/urgent/routine) — SLA clocks start before the contractor even reacts",
      "Track SLA response/resolution windows explicitly per contract and alert before breach, not after — missed SLAs feed 25-35% annual client churn",
      "Generate recurring PM work orders automatically from the schedule rather than tracking in spreadsheets — missed PM tasks routinely become emergency calls",
      "Require client approval workflows for NTE (not-to-exceed) threshold overages with a documented audit trail — verbal approvals evaporate at invoice time",
      "Track COI/WCB/trade-licence expiry for both the firm and its subcontractors — an expired COI ejects vendors from client-approved lists",
      "Start the contract-renewal playbook ~90 days before end date with a documented value history — this is the industry's proven churn-defense pattern",
      "Tighten the quote-to-invoice cycle — 76% of commercial contractors report better margins after doing so, the #1 named margin driver in the category",
      "Capture proof-of-service documentation on every visit — invisible work is a named #1 churn driver in this category",
    ],
    workflowNotes:
      "Recurring base load is aseasonal, but reactive volume spikes with weather (HVAC failures in heat waves/cold snaps) and PM work is strongly seasonal (spring cooling startup, fall heating changeover per ASHRAE-aligned checklists). Large customers increasingly force vendors into their own portals (ServiceChannel, JLL Corrigo) for work orders and invoicing — NVC 360 should treat this as an integration surface, not something to replace. 78% of commercial contractors are already using or testing AI tools, so this ICP is receptive to automation-forward positioning.",
    terminologyNotes:
      "Sites & Contracts (not 'customers') carries SLA fields per site. PM Calendar drives recurring preventive-maintenance generation. NTE guard + Approvals Queue gates client-facing cost overages. QBR client report (quarterly business review) is the retention/renewal artifact this ICP's buyers expect.",
    toneRefinement:
      "Professional and SLA-aware. Property managers care about response time against contract terms and proof the work happened — lead with SLA status and documented completion, not small talk.",
    notificationRefinement:
      "SLA breach warning to dispatcher + ops manager when a work order reaches 75% of its SLA window unactioned. Emergency dispatch alert to on-call tech + dispatcher on emergency-priority work orders. PM work orders generated to ops manager when the recurring schedule instantiates the next period. Client approval requested/received to account owner + dispatcher on NTE-exceedance submission/response. Compliance document expiring to admin + ops manager when a COI/WCB/trade licence is within 30 days of expiry. Contract renewal window opening to owner/GM at contract end date minus 90 days.",
    complianceNotes:
      "WCB/WSIB coverage and clearance letters, certificates of insurance (COIs) demanded by property managers, provincial trade licensing for HVAC/electrical/plumbing subs, refrigerant handling regulations, ASHRAE 180 standard for HVAC maintenance practice, and BOMA BEST building-certification criteria that impose documented maintenance/janitorial standards on serviced buildings.",
    sources: [
      { title: "JLL — Global State of Facilities Management Report 2025", url: "https://www.jll.com/en-us/newsroom/dollar3-trillion-fm-market-navigates-shifting-economic-and-tech-landscape" },
      { title: "StatCan — Canadian Business Counts Table 33-10-1095-01", url: "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=3310109501" },
      { title: "BuildOps — 2026 Commercial Contractor Benchmark Report", url: "https://buildops.com/lp/customer-benchmark-report-2026" },
      { title: "BOMA BEST Certification", url: "https://bomabest.org/" },
    ],
  },
  {
    industry: "flooring",
    summary:
      "Flooring dealer-installers selling material + install (not labor-only subs), 3-15 person shops, builder-facing and retail. Flooring is the #1 buyer-upgrade category in new homes — the same ecosystem as Karma/Glendale — and no incumbent does builder-linked options at this tier; vertical ERPs (QFloors, RFMS) are retail-focused and priced for larger dealers, leaving the installer/dealer-installer tier underserved. Builder options-program management (per-builder, per-plan price books with option levels) is a direct extension of the proven options engine, with flooring representing 8-25% of new-home upgrade revenue.",
    bestPractices: [
      "Track every inquiry in a shared queue — lead cost runs $100-250, making every dropped lead expensive; top performers already convert >30% of inquiries",
      "Feed digital site-measure takeoffs directly into the quote with standard waste factors by product — re-keying measurements into quotes duplicates work and introduces errors",
      "Quote in tiered product options (carpet vs LVP vs hardwood at good/better/best price points) and present financing on every quote — financing is offered by 80% of retailers but attached to under 5% of jobs today, an unpitched ticket-expansion opportunity",
      "Maintain structured, versioned option tiers per builder/community rather than free-form price sheets — version drift between the dealer's book and the builder's design-center sheets is a named failure mode",
      "Never schedule an install until material is received AND the site is confirmed ready — track PO -> received -> staged status with delay alerts",
      "Run a moisture-test gate (e.g. ASTM F2170 RH reading) before scheduling — test failures after material delivery cause unbudgeted remediation",
      "Watch single-builder revenue concentration — over 35% of revenue from one builder makes the dealer a captive sub with no pricing leverage",
    ],
    workflowNotes:
      "Core sequence: lead intake -> site measure & takeoff -> good/better/best quoting -> (builder track: options-program management with per-builder/per-plan price books) -> material ordering & lead-time coordination -> scheduled install (gated on material + site readiness) -> invoicing. Lead times are described as 'the single biggest variable in project scheduling' since flooring installs last in a build sequence and inherits every upstream trade's slippage.",
    terminologyNotes:
      "Ready-to-Schedule gate (material received + site ready + moisture pass) is the install-blocking checkpoint. Options Catalog for tiered flooring products. Builder Program Dashboard tracks concentration by builder account. Quote-to-PO is the estimate-to-purchase-order handoff.",
    toneRefinement:
      "Practical and material-literate. Customers are choosing between carpet/LVP/hardwood tiers — confirm measurements, material lead times, and site-readiness (moisture, subfloor) before locking a schedule date, and never overpromise an install date ahead of confirmed material arrival.",
    notificationRefinement:
      "Material Received - Ready to Schedule to scheduler + customer/builder contact when a PO is marked received/staged. Install Reminder + Site-Readiness Checklist 24-48h before install date. Quote Follow-Up Nudge to salesperson/owner at 48h unanswered. Moisture Test Failed - Hold Scheduling to scheduler + estimator on a failed readiness check. Crew Day Sheet to installer crew lead on assignment/schedule change. Invoice Due/Aging Alert to owner/bookkeeper when a builder invoice hits its net-terms date +3 days.",
    complianceNotes:
      "No flooring-specific licensing beyond general contractor/business registration in most Canadian jurisdictions; installers working inside new-construction sites must follow the general contractor's site safety and scheduling requirements. Tariff-driven material price volatility (45% of NWFA members raised prices in 2025) makes price-list version control a practical compliance-adjacent concern.",
    sources: [
      { title: "PRWeb — 2026 State of the Retail Flooring Industry Report", url: "https://www.prweb.com/releases/2026-state-of-the-retail-flooring-industry-report-reveals-what-separates-top-performers-as-growth-normalizes-302685053.html" },
      { title: "MeasureSquare — Commercial Flooring Estimation & Takeoff", url: "https://measuresquare.com/trade/commercial-flooring-estimation-and-takeoff-software/" },
      { title: "Finch — New Construction Flooring Upgrades Guide", url: "https://withfin.ch/learn/new-construction-upgrades" },
      { title: "ConstructionCFO — Flooring Operating System", url: "https://constructioncfo.net/cfos-flooring-operating-system" },
    ],
  },
  {
    industry: "garage-door",
    summary:
      "Garage door dealer-installers running 24/7 emergency repair alongside new-door sales and new-construction builder installs. The wedge (the 'Glendale transfer'): door configuration and quoting — series/model, size, insulation tier (R-8 to R-18), windows, color, hardware, opener tier — is the options/upgrade engine transplanted almost verbatim from the proven Karma/Glendale motion. No incumbent vertical SaaS exists between generic FSM (Jobber) and 20+-tech ServiceTitan deployments, and the builder channel is a genuine two-sided wedge since builder accounts buy garage doors for every lot.",
    bestPractices: [
      "Track booking rate and revenue per call, not just call volume — top operators actively recover 'second-chance leads' from missed/unbooked after-hours calls",
      "Run dispatch software with a real-time tech board and automated 'tech on the way' texts — table stakes in this vertical, not a differentiator",
      "Present tiered repair-vs-replace options on every truck visit, not a single verbal quote — the replacement conversion story (up to 268% ROI per cost-vs-value data) is routinely never told to the customer",
      "Disclose after-hours emergency surcharges up front automatically, not after the job — techs cost 1.5-2x after hours and undisclosed surcharges damage trust",
      "Run an unsold-estimate nurture sequence at 48h/7d/21d — documented to recover real revenue at scale",
      "Notify customers automatically when a special-order door arrives at the warehouse — kills the silent multi-week wait that generates complaint calls",
      "Send an annual tune-up reminder ahead of the fall freeze — winter spring failures are preventable and Winnipeg-critical",
      "Confirm builder site-readiness 48h before a scheduled new-construction install to prevent wasted dry runs",
    ],
    workflowNotes:
      "Core workflows: 24/7 emergency call intake & triage, same-day repair dispatch, on-site diagnose with repair-vs-replace options, door configuration & quoting (the wedge), special-order tracking, builder new-construction install coordination, annual tune-up/service-agreement follow-up, and post-job review requests. First-time-fix rate above 80-90% is described as critical for profitability in this vertical.",
    terminologyNotes:
      "Door Configurator (R-value/window/opener tiers) is the primary sales surface — an options-engine reskin, not a new build. Emergency Board with an after-hours surcharge flag. Spring inventory matrix tracks parts stock for the most common repairs. Builder site-readiness confirm gates new-construction installs.",
    toneRefinement:
      "Fast and reassuring — a broken garage door is often a security or access emergency. Confirm ETA quickly and explain tiered door/opener options clearly on install quotes rather than a single take-it-or-leave-it number.",
    notificationRefinement:
      "Tech-on-the-way SMS with ETA + tech photo to customer on dispatch. After-hours emergency auto-acknowledgment + surcharge disclosure on out-of-hours bookings. Unsold-estimate nurture sequence at 48h/7d/21d. Special-order door arrived -> schedule install to customer + dispatcher on PO received. Annual tune-up reminder 11 months after install/last service (fall push before freeze-up). Builder site-readiness confirmation request 48h before a new-construction install. Post-job review request on invoice paid/job closed.",
    complianceNotes:
      "No garage-door-specific licensing beyond general contractor/business registration in most Canadian jurisdictions; electrical work on openers may fall under provincial electrical licensing thresholds depending on scope.",
    sources: [
      { title: "Garage Door Marketers — 2025 Market Report", url: "https://garagedoormarketers.com/2025-market-report" },
      { title: "ServiceTitan — Garage Door Software", url: "https://www.servicetitan.com/industries/garage-door-software" },
      { title: "DASMA — Cost vs Value Report 2025 (Winter)", url: "https://www.dasma.com/wp-content/uploads/2025/12/CostvsValueReport2025_Winter2025.pdf" },
      { title: "Case Studies — A1 Garage Door Service Second-Chance Leads", url: "https://www.casestudies.com/company/servicetitan/case-study/a1-garage-door-service-turns-missed-opportunities-into-revenue-with-second-chance-leads" },
    ],
  },
  {
    industry: "tree-care",
    summary:
      "ISA-certified multi-crew tree care and arborist firms — the sleeper pick per the research, with less incumbent saturation than any other green-industry vertical. Estimate-centric, per-tree line-item quoting (removal vs prune vs cable, good/better/best) is a direct reuse of the Karma/Glendale options-pricing engine. Winnipeg adds a regulatory demand engine no generic FSM is tuned for: Dutch Elm Disease management, the Apr 1-Jul 31 elm pruning ban, and Emerald Ash Borer regulated-area restrictions create recurring, compliance-windowed work.",
    bestPractices: [
      "Run automated lead intake with rapid response + follow-up sequences — this alone lifts close rates 25-40% within 90 days, and storm events multiply lead volume 5-10x overnight so triage discipline matters more here than most trades",
      "Keep a structured per-tree record (species, DBH, height, condition, access, hazards) rather than scribbled notes — quotes are inconsistent between estimators without it",
      "Quote tiers instead of a single number per tree: prune-only vs prune+cable/brace vs removal+stump grind, with PHC add-ons — this is the Karma/Glendale options engine applied directly",
      "Track the Manitoba elm pruning ban (illegal Apr 1-Jul 31) and EAB/CFIA regulated-area wood-movement restrictions as hard scheduling constraints, not tribal knowledge",
      "Track Plant Health Care treatment intervals (e.g. TreeAzin 2-year cycle) explicitly — missed retreatment windows kill trees and torch renewal revenue",
      "Confirm crane-day access 48 hours ahead — crane time is the costliest idle asset in this trade if access falls through",
      "Track arborist and pesticide-applicator licence/CEU expiry with 60/30-day warnings — lapsed credentials make work performed illegal, not just non-compliant",
    ],
    workflowNotes:
      "Core workflows: lead intake & triage, site visit & per-tree estimating, good/better/best option quoting, compliance-windowed scheduling (the Winnipeg regulatory engine), crane/equipment scheduling, PHC program management, storm-surge mode, and licence/CEU tracking. Removal pricing ranges $200-2,000/tree, averaging ~$850 — wide enough that structured per-tree line items materially improve quote consistency and margin capture.",
    terminologyNotes:
      "Compliance Calendar tracks DED/EAB windows and the elm-ban guard blocks illegal scheduling automatically. Tree Inventory + reactivation tracks known trees on a property across visits. PHC Programs is the recurring treatment product line. Crane/equipment scheduler is a distinct resource-booking surface from crew dispatch.",
    toneRefinement:
      "Knowledgeable and safety-conscious. Tree work is inherently risky-looking to homeowners — explain the removal/prune/cable options and any regulatory windows (elm ban, EAB) plainly and proactively.",
    notificationRefinement:
      "Elm pruning ban countdown to owner/dispatcher starting Mar 15 (ban opens Apr 1). Elm season reopens on Aug 1 to owner/sales. PHC treatment due to office manager/PHC tech when a treatment interval is reached. Crane day confirmation to customer/crew lead 48h ahead. Storm surge mode activated to all staff on manual toggle. Quote follow-up nudge to estimator at 48h/7d. Licence/CEU expiry warning to owner/credential holder at 60/30 days.",
    complianceNotes:
      "Manitoba: no elm pruning Apr 1-Jul 31 (city + provincial law); elm wood storage is illegal; Emerald Ash Borer ash-wood movement has been CFIA-regulated since 2017-11-30. City of Winnipeg runs its own DED removal program Jan-Apr and Sep-Dec. Arborist licensing and pesticide-applicator certification carry their own renewal/CEU requirements.",
    sources: [
      { title: "City of Winnipeg — Dutch Elm Disease", url: "https://www.winnipeg.ca/services-programs/trees-environment/trees/tree-protection/dutch-elm-disease" },
      { title: "Manitoba Government — DED FAQ", url: "https://www.gov.mb.ca/stopthespread/fis/ded/faq.html" },
      { title: "Jobber Academy — Tree Removal Pricing", url: "https://www.getjobber.com/academy/" },
      { title: "TreeBuzz — Arborist Proposal Differentiation", url: "https://www.treebuzz.com/blog" },
    ],
  },
  {
    industry: "concrete-foundation-repair",
    summary:
      "Concrete flatwork and foundation-repair contractors (piering/underpinning, waterproofing, driveways) — re-scored to core status (7.3/10, up from a provisional 6.3) after a dedicated market scan confirmed structural fit. High-ticket, estimate-centric work with natural good/better/best tiers (pier count/type/depth, waterproofing scope, finish options) that maps directly onto the Karma/Glendale options engine. Winnipeg's expansive clay soil makes this one of the densest local residential trades.",
    bestPractices: [
      "Track cost-per-booked-job, not cost-per-lead — shared marketplace leads for foundation work close at only ~7%, making true acquisition cost far higher than the sticker lead price",
      "Use structured digital inspection forms with timestamped photos and elevation/crack measurements — this record both defends the quote and can be handed to an independent engineer",
      "Send automated inspection-appointment reminders — no-shows waste the pivotal sales slot in a long, panic-to-decision sales cycle",
      "Build line-itemized, per-pier quotes from a maintained price library with good/better/best tiers (pier type x count x depth) — this is the Karma/Glendale options-tier pattern applied directly to piers",
      "Run an automated quote follow-up sequence across the 2-6 week sales cycle — $20K-100K quotes get second-guessed and die without persistent follow-up",
      "Collect a deposit immediately on quote acceptance — deposit delays are a named driver of start-date slippage on large jobs",
      "Gate job completion/invoicing on a received engineer sign-off document when the scope requires one",
      "Track telepost/sump/maintenance anniversaries at 12 months post-completion — this recurring revenue leaks without an explicit reminder",
    ],
    workflowNotes:
      "Core workflows: lead intake & triage, inspection scheduling & structural assessment, piering/underpinning tiered quoting, waterproofing scope options quoting, multi-day crew scheduling, weather/frost-gated exterior work, equipment rental coordination, engineer sign-off gating, deposit collection, and quote follow-up across a 2-6 week cycle. Typical full underpinning jobs run $24K-60K; push piers ~$1,500-3,500 installed, helical ~$1,200-3,000 — homeowners routinely can't compare options without a structured tiered breakdown.",
    terminologyNotes:
      "Pier/waterproofing tiered quote builder is the primary sales surface. Structural inspection form captures elevations, crack widths, and photos. Engineer sign-off gate blocks job completion until the document is attached. Pier logs and telepost anniversary outreach are the recurring-revenue follow-up surfaces.",
    toneRefinement:
      "Technical but plain-English. Foundation issues scare homeowners — explain the inspection finding, the tiered fix options, and the engineer sign-off step clearly before pricing, since these are high-anxiety, high-ticket decisions.",
    notificationRefinement:
      "Inspection appointment reminder to customer at 24h + 2h before scheduled inspection. Multi-day job crew briefing to crew members the evening before each day of a multi-day job. Weather/frost delay alert to dispatcher + customer when forecast drops below a cold-weather threshold on a scheduled exterior job. Equipment rental window alert to dispatcher/owner 48h before excavator/rental delivery. Engineer sign-off pending to office manager when job execution is complete but sign-off is missing. Deposit request on acceptance to customer. Quote follow-up sequence at 3/10/21 days to customer. Telepost/maintenance anniversary at 12 months post-completion.",
    complianceNotes:
      "ACI 306 cold-weather concreting guidance governs frozen-ground/cold-weather work windows. Engineer sign-off is often required for permitted structural repair work. No trade-specific provincial licensing beyond general contractor registration in most cases, though excavation work may trigger utility-locate and municipal permit requirements.",
    sources: [
      { title: "MyQuoteIQ — Foundation Repair Scheduling Software", url: "https://myquoteiq.com/top-10-best-scheduling-software-for-foundation-repair-companies-in-2026/" },
      { title: "Titan Products — Estimating Push Pier & Helical Costs", url: "https://www.titanproductsinc.com/blog/estimating-costs-for-foundation-repair-push-piers-helicals" },
      { title: "Dalinghaus Construction — Underpinning Cost Guide", url: "https://www.dalinghausconstruction.com/blog/underpinning-cost-push-piers/" },
      { title: "Construction Lead Pro — Cost of Construction Leads", url: "https://constructionleadpro.com/how-much-do-construction-leads-cost/" },
    ],
  },
  {
    industry: "equipment-rental",
    summary:
      "Independent equipment & tool rental operators (1-3 locations, general/construction/party rental) — the highest-scoring outlier ICP, but explicitly gated: NVC 360 should not sell into this vertical until a serialized asset-availability/utilization engine ships, since availability conflicts are the core operational risk this ICP needs solved. The mid-market gap between Booqable ($29-87/mo, e-commerce-light) and Point of Rental/Texada (enterprise, thousands/month) is real and documented, and the buyer ecosystem is warm — Karma, SMLXL, and the Winnipeg trades lead list all rent from these companies.",
    bestPractices: [
      "Maintain one single source of truth for equipment availability across every booking channel (counter, phone, web) — a booking confirmed anywhere must block the unit everywhere instantly, including maintenance downtime",
      "Build buffer/turnaround time between rentals into the availability calendar, not just the rental window itself",
      "Pre-build kits/packages of commonly bundled items (machine + attachments + trailer + consumables) with package pricing instead of pricing every job line-by-line by hand",
      "Enforce availability at booking confirmation time, not just at counter check-out — manual systems allow two staff to book the same unit simultaneously",
      "Sell a standardized damage waiver as a contractual product (typically 5-13% of order value) rather than offering it ad hoc",
      "Send proactive delivery ETA and delay alerts — customers should not learn about a delay only when the driver is already late",
      "Send a written off-rent confirmation the moment a customer calls a unit off-rent — disputes over 'I called it off Tuesday' are a named, recurring problem without a timestamped record",
      "Run automated cycle billing (28-day or monthly) with a card on file to cut days-sales-outstanding",
    ],
    workflowNotes:
      "Core workflows: inquiry & availability check, quoting & package building, reservation/contract/deposit, delivery dispatch, off-rent call-off & pickup, cycle billing, and overdue-return follow-up. This ICP is explicitly build-before-sell: NVC 360 does not yet have the serialized asset-availability/utilization engine (per-unit calendar, maintenance-block awareness, utilization reporting) this vertical structurally requires — treat as a future ICP, not a current beta target.",
    terminologyNotes:
      "Availability Calendar (per-serialized-unit, not per-category) is the core object this ICP needs that doesn't exist in the platform yet. Off-rent queue tracks called-off-but-not-yet-picked-up units. Check-out/check-in inspection form documents condition at both ends of a rental. Fleet & Utilization reporting is explicitly blocked pending the availability engine.",
    toneRefinement:
      "Efficient and availability-focused. Customers need to know exactly what's available, when, and what it costs including add-ons — confirm delivery/pickup windows clearly and proactively.",
    notificationRefinement:
      "Reservation confirmed to customer on status change. Delivery ETA & delay alerts to customer on dispatch run scheduling/ETA change. Off-rent confirmation to customer + dispatcher when a contract line moves to off-rent. Cycle-bill invoice issued to customer (owner card on file) on the 28-day/monthly cycle anniversary. Overdue return/extension offer to customer + counter when the expected return date passes with no off-rent call.",
    complianceNotes:
      "No rental-specific licensing beyond general business registration in most cases; damage-waiver terms and deposit practices should be clearly disclosed in rental contracts to avoid consumer-protection disputes.",
    sources: [
      { title: "HQ Rentals — Preventing Double Bookings", url: "https://hqrent.com/resources/managing-a-rental-business/how-to-handle-a-double-booking-before-it-becomes-a-customer-problem" },
      { title: "Goodshuffle Pro — Non-Refundable Damage Waiver Guide", url: "https://pro.goodshuffle.com/blog/non-refundable-damage-waiver-event-rental/" },
      { title: "ServiceCore — 28-Day vs Monthly Billing Best Practices", url: "https://servicecore.com/blog/best-billing-practices-28-day-billing-vs-monthly-billing/" },
      { title: "HAPN — Fleet Utilization Benchmarks 2026", url: "https://gethapn.com/blog/fleet-utilization-benchmarks-2026-is-your-equipment-actually-making-money/" },
    ],
  },
  {
    industry: "property-management-maintenance",
    summary:
      "Property managers' maintenance-operations layer — outlier ICP by design: NVC 360 is positioned beside the PMS (Yardi/AppFolio/Buildium), never as a replacement, validated by the MRH Properties engagement (a Yardi shop paying for automation around Yardi, not instead of it). Financial records stay in the PMS; NVC 360 owns work-order intake, triage, scheduling, and tenant communication only. Only ~6.67% of work orders are true emergencies, but missed emergencies escalate fast ($200 leak becomes a $2,000 claim) and 31% of leaving tenants cite maintenance as a reason.",
    bestPractices: [
      "Run a single intake funnel with a structured triage matrix (emergency/urgent/routine) and acknowledge every request inside 4 hours — this is the named industry trust benchmark",
      "Codify an explicit after-hours escalation protocol (active leak / no heat in winter / safety = immediate on-call dispatch; everything else queued to morning) with every call logged before it ends",
      "Track owner-approval response time as a named KPI for any request exceeding the NTE (not-to-exceed) threshold — approval latency is a top driver of slow repairs",
      "Photo-document every estimate that requires owner approval — scattered email threads leave no audit trail when owners dispute invoices later",
      "Send a 1-question satisfaction survey on every work-order close — this is the primary retention lever available to a maintenance-ops layer",
      "Track vendor COI/GL/WC expiry automatically — lapsed insurance is uninsured-loss exposure the PM firm carries if unnoticed",
    ],
    workflowNotes:
      "Lifecycle framing is intentionally reinterpreted for this ICP: 'lead intake' = work-order intake, 'estimating' = diagnosis + owner approval, 'billing' = invoice capture + owner billback (the PMS stays the system of record for money throughout). Core workflows: work-order intake & triage, after-hours/emergency call handling, diagnosis/estimate/owner approval (NTE), scheduling & technician dispatch, vendor COI compliance, and tenant satisfaction follow-up. PMs handle roughly 16,000 calls/year with an expected ~30-minute emergency response time; small PM firms lose an estimated ~$21K/year to missed calls.",
    terminologyNotes:
      "Work Orders landing page (not 'Jobs') is this ICP's home screen. Unit Turns board tracks vacancy-to-ready cycles as a distinct workflow from routine maintenance. Owner Approvals (NTE routing) gates spend above the management-agreement threshold. Vendors & Compliance (COI gate) tracks insurance currency. PMS cost-record sync pushes cost data to Yardi/AppFolio/Buildium — never becomes the accounting system of record itself.",
    toneRefinement:
      "Calm and process-driven. Tenants are often frustrated when they submit a maintenance request — acknowledge fast, set a realistic timeline, and confirm completion clearly; owners want approval requests that are fast to act on, not another email thread to track.",
    notificationRefinement:
      "Work order received to tenant on creation via any channel. Technician scheduled + ETA window to tenant. Tech/vendor en route to tenant on dispatch start. Work order completed + 1-question survey to tenant on close. Emergency escalation page to on-call tech/manager when a work order is triaged emergency outside office hours. Owner approval request to owner when an estimate exceeds the NTE threshold. Vendor COI expiring to coordinator + vendor at 30 days out.",
    complianceNotes:
      "NVC 360 must never become the system of record for rent, leases, or trust accounting for this ICP — that boundary is what keeps it a maintenance-ops layer beside the PMS rather than a displacement play (a much larger, differently-regulated undertaking). Vendor insurance (COI/GL/WC) tracking is a practical risk-management requirement property managers already impose on their vendor networks.",
    sources: [
      { title: "NAA/AppWork — Maintenance Work Order Statistics", url: "https://naahq.org/news/10-things-about-common-maintenance-work-orders" },
      { title: "Buildium — Property Management Maintenance Metrics", url: "https://www.buildium.com/blog/top-property-management-maintenance-metrics/" },
      { title: "Property Meld — Maintenance Benchmarks", url: "https://propertymeld.com/blog/property-maintenance-benchmarks-to-monitor-efficiency/" },
      { title: "Nextiva — Property Management Answering Service Guide", url: "https://www.nextiva.com/blog/property-management-answering-service.html" },
    ],
  },
  {
    industry: "restoration",
    summary:
      "Fire & flood damage restoration contractors — outlier ICP scoped deliberately narrow: NVC 360 serves the self-pay/non-TPA independent and the rebuild phase only. The insurance-estimating workflow (Xactimate, TPA program compliance) is documented for context but explicitly marked 'integrate/adjacent, do not compete' — Xactimate scopes attach as documents, no native estimating or TPA portal integration. Highest willingness-to-pay of any candidate vertical, but the largest revenue stream is carrier-captured, so this is a late-priority, opportunistic ICP, not a lead vertical.",
    bestPractices: [
      "Capture every emergency call with structured intake regardless of insured-vs-self-pay status — that status changes the entire downstream workflow and must be captured up front, not discovered later",
      "Run a dedicated 24/7 dispatch workflow with a tracked response-time SLA — top performers maintain 30-minute response, urban market expectation is on-site within ~4 hours for water emergencies",
      "Log daily time-stamped moisture/drying readings at fixed monitoring points — gaps in daily logs are among the most common triggers for adjuster disputes and claim reductions; reconstructed logs risk full claim rejection",
      "Pull equipment promptly once final moisture targets are recorded — equipment left on site erodes margin invisibly",
      "Always generate a rebuild quote before demobilizing from mitigation — the rebuild phase can be worth 150-300% of the mitigation revenue and leaks away without a pre-demob quote prompt",
      "Chase subcontractor confirmation 48h ahead of scheduled rebuild slots — sub no-shows stall remodel-like rebuild sequencing",
      "Collect the deductible or deposit at the earliest workflow point (job creation for insured work, quote acceptance for self-pay) — 'getting paid' is named the industry's #1 issue",
    ],
    workflowNotes:
      "Core workflows: emergency lead intake & loss triage, emergency dispatch & 24/7 crew scheduling, moisture documentation & daily drying logs, insurance estimating & TPA compliance (boundary — context only, not built), mitigation-to-rebuild handoff, subcontractor coordination for rebuild, and deductible/AR collection. The rebuild phase is essentially residential remodeling and should reuse renovation-contractor-style workflows (allowances, change orders, draw billing) once mitigation closes out.",
    terminologyNotes:
      "Emergency Board is the 24/7 dispatch view. Payer-type field (insured/self-pay/hybrid) drives which downstream workflow a job follows. Xactimate scope attachment is explicitly 'attach, never compete' — scope PDFs live on the job record as documents, not native line items. Mitigation -> rebuild handoff is a formal stage transition, not an implicit one. Drying-log form captures IICRC S500-aligned daily readings.",
    toneRefinement:
      "Empathetic and process-driven. Customers are usually mid-disaster (fire/flood/mold) and stressed about insurance — explain next steps and documentation requirements clearly, and never let the mitigation-to-rebuild handoff feel like starting over with a new company.",
    notificationRefinement:
      "Emergency call-back SLA timer to on-call tech + owner on new emergency lead. On-site arrival confirmation to customer on dispatch accepted/tech en route. Daily drying-log reminder to assigned tech if no log entry exists by 3pm on an active mitigation job. Drying complete - pull equipment to PM + tech when final moisture targets are recorded. Rebuild quote nudge to estimator/owner when mitigation is marked complete without a rebuild quote. Sub confirmation chaser to recon PM when a sub is unconfirmed 48h before a scheduled rebuild slot. Deductible/deposit due to customer + office on job creation (insured) or quote acceptance (self-pay).",
    complianceNotes:
      "IICRC S500 water-damage restoration standard governs documentation and drying practice. Carriers/TPAs mandate Xactimate on an estimated ~80% of property claims in both the US and Canada, structurally locking native estimating out of that revenue stream — this is a permanent boundary, not a current-version limitation.",
    sources: [
      { title: "National Restoration Authority — Response Time Standards", url: "https://nationalrestorationauthority.com/restoration-services-response-time-standards/" },
      { title: "Water Mitigation Authority — Documentation Requirements", url: "https://watermitigationauthority.com/water-mitigation-documentation-requirements" },
      { title: "PushLeads — Restoration TPA Marketing Guide", url: "https://pushleads.com/restoration-company-seo/lead-generation/tpa-marketing/" },
      { title: "Encircle — Water Mitigation Documentation Solutions", url: "https://www.getencircle.com/solutions/water-mitigation/" },
    ],
  },
  {
    industry: "sports-organization",
    summary:
      "Sports clubs and academies (youth leagues, club sports, training academies) — the lowest-fit outlier ICP, held on roster-level signal only (One Team Sports) with an explicit hold on GTM investment until 3+ paying prospects appear. Configuration frame is 'scheduling-heavy, dispatch-light': spaces are resources, sessions are jobs, coaches are crew. Hard boundary: do NOT build consumer registration/payments, rosters, waivers, or standings/league management — that market belongs to TeamSnap, SportsEngine/PlayMetrics, and LeagueApps, and NVC 360 cannot access their payment-processing-fee monetization model.",
    bestPractices: [
      "Lock the seasonal program calendar well before registration opens — enrollment series sell roughly 38 days ahead, and late-locked calendars lose real enrollment lead time",
      "Move recurring programs into fixed prime slots so new demand spreads into shoulder hours — median prime-time facility occupancy sits at just 19% even though peak hours sell out",
      "Run real-time space/facility booking with automated conflict detection — manual spreadsheets fail at scale and double-bookings are the top-cited operational failure",
      "Hold prime rental inventory until 48-72 hours out, since most rentals book less than a day ahead",
      "Track coach/instructor certification and screening expiry explicitly — now legally required in Manitoba under the Protecting Youth in Sports Act (2026-04-01)",
      "Send SMS-first session reminders at 24h and 2h — no-shows run 18-25% unreminded and SMS reminders cut that 30-50%",
      "Notify all booked participants and the assigned coach immediately on any schedule change or cancellation — this is the #1 named communications failure in the category",
    ],
    workflowNotes:
      "Core workflows: seasonal program calendar build, facility/space booking & conflict management, coach/instructor assignment & availability, session scheduling, and re-enrollment. Explicitly excluded from scope: registration/payments checkout, roster management, waivers, and standings/league tables — the do-not-build list matters as much as the workflow list for this ICP.",
    terminologyNotes:
      "Spaces (not 'jobs' or 'zones') are the bookable resource type — courts, cages, fields, ice sheets. Program Calendar drives the seasonal session build. Coaches map to the crew/worker role. Conflict blocker is the real-time double-booking prevention feature. SMS-first session pack is the dominant notification channel for this ICP, unlike most trades where email/push lead.",
    toneRefinement:
      "Upbeat and schedule-focused. Parents/members care about session times, space assignments, and coach communication — keep it simple, fast, and mobile-first since most interactions happen from a phone between activities.",
    notificationRefinement:
      "Session reminder (24h + 2h, SMS-first) to parents/athletes and renters. Schedule change/cancellation alert to all booked participants + assigned coach immediately on edit or cancellation. Coach assignment notice to coach on add/remove/substitute. Booking confirmation with calendar file to renter/customer on booking or quote acceptance. Re-enrollment opening notice to prior-season customers when a program series opens for the next season. Coach certification expiry warning to admin + coach at 30 days out.",
    complianceNotes:
      "Manitoba's Protecting Youth in Sports Act (effective 2026-04-01) requires coach/staff screening and training currency — this is a real, dated legal requirement, not just best practice, and should drive a hard compliance gate on coach assignment once screening lapses.",
    sources: [
      { title: "Baseline Pro — Sports Facility Economics Report", url: "https://www.baselinepro.com/blog/sports-facility-economics-report" },
      { title: "RinkBook — How Ice Time Is Allocated in Minor Hockey", url: "https://www.rinkbook.ca/blog/how-ice-time-is-allocated-in-minor-hockey" },
      { title: "SportsKey — Comparing Sports Facility Management Software", url: "https://sportskey.com/post/how-to-compare-sports-facility-management-software/" },
      { title: "Manitoba Government — Protecting Youth in Sports Act", url: "https://web2.gov.mb.ca/bills/43-2/b021e.php" },
    ],
  },
];

async function main() {
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
  console.log("Total rows:", check.length, "(expect 17 = 4 Wave-1 + 13 Wave-2/3)");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
