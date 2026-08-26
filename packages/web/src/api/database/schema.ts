import { pgTable, text, integer, boolean, timestamp, doublePrecision, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export * from "./auth-schema";

const now = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Per-role default permissions. perms = JSON array of permission keys. */
export const rolePermissions = pgTable("role_permissions", {
  role: text("role").primaryKey(), // admin | manager | dispatcher | project_manager | rider
  perms: text("perms").notNull().default("[]"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Service categories / offerings */
export const services = pgTable("services", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  name: text("name").notNull(),
  category: text("category").notNull(), // cleaning, plumbing, electrical, etc.
  description: text("description").notNull().default(""),
  icon: text("icon").notNull().default("wrench"), // lucide icon name
  image: text("image").notNull().default(""),
  basePrice: numeric("base_price", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
  durationMins: integer("duration_mins").notNull().default(60),
  // flexible pricing model (JSON RateModel). When set, overrides basePrice for client charge.
  rateModel: text("rate_model").notNull().default(""),
  rating: doublePrecision("rating").notNull().default(4.8),
  active: boolean("active").notNull().default(true),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("services_company_idx").on(t.companyId),
}));

/** Technician profile (1:1 with a user of role=rider) */
export const riders = pgTable("riders", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().default("default"),
  vehicle: text("vehicle").notNull().default("Van"),
  skills: text("skills").notNull().default(""), // csv of categories
  skillClass: text("skill_class").notNull().default("General"), // HVAC, Electrical, Plumbing, etc.
  color: text("color").notNull().default("#0ea5e9"), // map color-code
  photoUrl: text("photo_url").notNull().default(""), // headshot shown in place of initials
  photoKey: text("photo_key").notNull().default(""), // object-storage key for the headshot (S3)
  phone: text("phone").notNull().default(""),
  licensePlate: text("license_plate").notNull().default(""),
  licenseNumber: text("license_number").notNull().default(""),
  address: text("address").notNull().default(""),
  notes: text("notes").notNull().default(""),
  status: text("status").notNull().default("offline"), // offline | available | enroute | onsite | break | busy
  manualOffline: boolean("manual_offline").notNull().default(false), // tech toggled themselves offline
  payRatePerHour: numeric("pay_rate_per_hour", { precision: 12, scale: 2, mode: "number" }).notNull().default(0), // tech hourly pay for time on site
  rating: doublePrecision("rating").notNull().default(4.9),
  completedJobs: integer("completed_jobs").notNull().default(0),
  approval: text("approval").notNull().default("active"), // invited | pending | active | suspended
  invitedAt: timestamp("invited_at", { withTimezone: true }),
  // last known location
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  locationUpdatedAt: timestamp("location_updated_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("riders_company_idx").on(t.companyId),
}));

/** Custom work-order / task templates (the drag-and-drop builder output) */
export const taskTemplates = pgTable("task_templates", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  name: text("name").notNull(),
  category: text("category").notNull().default("General"),
  icon: text("icon").notNull().default("clipboard-list"),
  color: text("color").notNull().default("#0ea5e9"),
  description: text("description").notNull().default(""),
  // JSON array of field defs: [{id,label,type,required,options?}]
  fields: text("fields").notNull().default("[]"),
  // JSON array of checklist items: [{id,label}]
  checklist: text("checklist").notNull().default("[]"),
  estimatedMins: integer("estimated_mins").notNull().default(60),
  // flexible pricing model (JSON RateModel) applied to bookings created from this template
  rateModel: text("rate_model").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("tasktpl_company_idx").on(t.companyId),
}));

/** Shared, reusable skill library for technicians (dropdown + type-to-add). */
export const skillLibrary = pgTable("skill_library", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  name: text("name").notNull(),
  category: text("category").notNull().default("General"),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("skill_company_idx").on(t.companyId),
}));

/** Two-way messages (client <-> tech <-> dispatch) tied to a work order thread */
export const messages = pgTable("messages", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  bookingId: text("booking_id").references(() => bookings.id, {
    onDelete: "cascade",
  }),
  // direct dispatcher<->tech thread (no booking). Keyed by rider id.
  riderId: text("rider_id").references(() => riders.id, {
    onDelete: "cascade",
  }),
  senderRole: text("sender_role").notNull(), // client | tech | dispatch
  senderName: text("sender_name").notNull().default(""),
  body: text("body").notNull(),
  channel: text("channel").notNull().default("app"), // app | sms
  // ── read state is PER AUDIENCE, not per message ───────────────────────────
  // A job thread is read by three different parties (customer, office, field
  // tech) and one shared flag cannot represent that. `read` historically means
  // "the OFFICE has read this" — the dispatcher inbox counts depend on it, and
  // POST /:bookingId/mark-read sets it on the office's behalf.
  //
  // `readByTech` is the FIELD side's own acknowledgement. Without it, counting
  // job-thread messages toward the driver app's badge meant either a red number
  // the tech could never clear, or a tech silently blanking the dispatcher's
  // inbox just by opening a job.
  read: boolean("read").notNull().default(false),
  readByTech: boolean("read_by_tech").notNull().default(false),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("msg_company_idx").on(t.companyId),
  // The driver-app badge query filters unread-for-tech within one booking, and
  // runs for every company a technician works for on an 8s poll.
  techUnreadIdx: index("msg_tech_unread_idx").on(t.bookingId, t.readByTech),
}));

/** AI / automation rules engine */
export const automationRules = pgTable("automation_rules", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  trigger: text("trigger").notNull(), // wo_created | tech_enroute | wo_completed | tech_idle | sla_risk
  // JSON condition + action
  conditions: text("conditions").notNull().default("{}"),
  action: text("action").notNull(), // auto_assign | send_sms | notify_dispatch | reroute | escalate
  actionConfig: text("action_config").notNull().default("{}"),
  enabled: boolean("enabled").notNull().default(true),
  runsCount: integer("runs_count").notNull().default(0),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("autorule_company_idx").on(t.companyId),
}));

/** Third-party integrations */
export const integrations = pgTable("integrations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  provider: text("provider").notNull(), // quickbooks | gmail | google_calendar | office365 | outlook | xero | companycam | google_drive | dropbox | onedrive
  status: text("status").notNull().default("disconnected"), // connected | disconnected | error
  accountLabel: text("account_label").notNull().default(""),
  config: text("config").notNull().default("{}"),
  // --- OAuth2 token storage ---
  accessToken: text("access_token").notNull().default(""),
  refreshToken: text("refresh_token").notNull().default(""),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  scope: text("scope").notNull().default(""),
  externalAccountId: text("external_account_id").notNull().default(""),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("integ_company_idx").on(t.companyId),
}));

/** CompanyCam-style job photos */
export const jobPhotos = pgTable("job_photos", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  bookingId: text("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  caption: text("caption").notNull().default(""),
  source: text("source").notNull().default("companycam"), // companycam | upload
  // Liability documentation: which stage of the job this shot documents.
  // before | during | after | signature
  phase: text("phase").notNull().default("during"),
  // Whether the homeowner sees it on /t/:token and the permanent record.
  // Defaults on — techs can mark a shot internal (e.g. a damaged part close-up
  // the office wants but the customer shouldn't be alarmed by).
  customerVisible: boolean("customer_visible").notNull().default(true),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("jobphoto_company_idx").on(t.companyId),
  phaseIdx: index("jobphoto_phase_idx").on(t.bookingId, t.phase),
}));

/** A booking / appointment */
export const bookings = pgTable("bookings", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  customerId: text("customer_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  serviceId: text("service_id")
    .notNull()
    .references(() => services.id),
  riderId: text("rider_id").references(() => riders.id),
  templateId: text("template_id").references(() => taskTemplates.id),
  title: text("title").notNull().default(""),
  priority: text("priority").notNull().default("normal"), // low | normal | high | urgent
  status: text("status").notNull().default("pending"),
  // pending | confirmed | assigned | enroute | arrived | in_progress | completed | cancelled
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  address: text("address").notNull(),
  // resolved-or-created from `address` on save — links this job into the
  // property's permanent service history. Nullable: legacy rows + any job
  // whose address can't be normalised still work exactly as before.
  propertyId: text("property_id"),
  lat: doublePrecision("lat").notNull().default(43.6532),
  lng: doublePrecision("lng").notNull().default(-79.3832),
  notes: text("notes").notNull().default(""),
  staffNotes: text("staff_notes").notNull().default(""), // internal notes to driver/technician only (not shown to customer)
  driverNotes: text("driver_notes").notNull().default(""), // field notes written by driver/tech on site (visible to office)
  // --- sign-off (captured on site by the tech, on the customer's behalf) ---
  signatureUrl: text("signature_url").notNull().default(""), // stored SVG/PNG of the drawn signature
  signatureName: text("signature_name").notNull().default(""), // printed name of whoever signed
  signedAt: timestamp("signed_at", { withTimezone: true }),
  // JSON: filled template fields + checklist state
  fieldData: text("field_data").notNull().default("{}"),
  checklistState: text("checklist_state").notNull().default("[]"),
  price: numeric("price", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
  // --- pricing & tax ---
  rateModel: text("rate_model").notNull().default(""), // JSON RateModel snapshot for this job
  // catalog line items: JSON [{itemId,kind,name,sku,unit,qty,unitCost,unitPrice,taxable,cost,price,components?}]
  lineItems: text("line_items").notNull().default("[]"),
  lineItemsCost: numeric("line_items_cost", { precision: 12, scale: 2, mode: "number" }).notNull().default(0), // total cost (COGS) of line items
  lineItemsPrice: numeric("line_items_price", { precision: 12, scale: 2, mode: "number" }).notNull().default(0), // total customer price of line items (pre-tax)
  region: text("region").notNull().default(""), // CA province / US state code for tax (e.g. ON, MB, CA-US:NY)
  subtotal: numeric("subtotal", { precision: 12, scale: 2, mode: "number" }).notNull().default(0), // pre-tax client charge
  taxAmount: numeric("tax_amount", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
  taxRatePct: doublePrecision("tax_rate_pct").notNull().default(0),
  taxLabel: text("tax_label").notNull().default(""), // e.g. "HST 13%", "GST+PST"
  total: numeric("total", { precision: 12, scale: 2, mode: "number" }).notNull().default(0), // subtotal + tax
  priceBreakdown: text("price_breakdown").notNull().default(""), // JSON line items
  // --- time & mileage tracking ---
  enrouteAt: timestamp("enroute_at", { withTimezone: true }), // when tech tapped "on my way" — mileage accrues from here
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  onSiteMinutes: doublePrecision("on_site_minutes").notNull().default(0), // billed minutes actually worked
  // Elapsed drive time from "Start Driving" (enrouteAt) to first arrival on
  // site (auto-arrive via geofence or manual "I've Arrived"). Finalized once,
  // on arrival — mirrors how onSiteMinutes is finalized once, on completion.
  transitMinutes: doublePrecision("transit_minutes").notNull().default(0),
  // --- geofenced clock (pause/resume as tech enters/leaves job site) ---
  clockState: text("clock_state").notNull().default("idle"), // idle | running | paused
  accumulatedMs: integer("accumulated_ms").notNull().default(0), // total on-site ms banked across resume cycles
  lastResumeAt: timestamp("last_resume_at", { withTimezone: true }), // when clock last started running
  insideGeofence: boolean("inside_geofence").notNull().default(false), // current presence at job site
  mileageKm: doublePrecision("mileage_km").notNull().default(0), // round-trip km accumulated from GPS pings (enroute + on-site + return)
  techPay: numeric("tech_pay", { precision: 12, scale: 2, mode: "number" }).notNull().default(0), // computed driver pay for this job (hourly)
  techPayBreakdown: text("tech_pay_breakdown").notNull().default(""), // JSON
  paymentStatus: text("payment_status").notNull().default("unpaid"), // unpaid | paid | refunded
  /**
   * The payout that already paid the technician for this job.
   *
   * Payout runs used to be selected purely by `scheduledAt`, with nothing
   * recording that a job had been paid — so re-running a period, or running two
   * overlapping periods, produced a second payout for the same completed work.
   * This is the idempotency key for tech pay: a job with a payout is never
   * picked up again, and deleting a pending payout clears it so the work returns
   * to the next run.
   */
  payoutId: text("payout_id").notNull().default(""),
  // public tracking
  publicToken: text("public_token")
    .notNull()
    .$defaultFn(() => crypto.randomUUID().replace(/-/g, "").slice(0, 12)),
  customerPhone: text("customer_phone").notNull().default(""),
  smsSentAt: timestamp("sms_sent_at", { withTimezone: true }),
  // public tracking link expiry — link stops resolving after this time (PII safety)
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  etaMins: integer("eta_mins"),
  etaDistanceKm: doublePrecision("eta_distance_km"),
  // ── Running-late watch (shared/delay-policy.ts) ──────────────────────────
  // delayFlaggedAt is set by the sweep the moment the job slips past the
  // tenant's threshold; it's what puts the job on the dispatcher's board and
  // starts the grace clock before the notice sends itself. delayNotifiedMins
  // records the slip the customer was actually told about, so a second notice
  // only goes out if things genuinely got worse.
  delayFlaggedAt: timestamp("delay_flagged_at", { withTimezone: true }),
  delayFlaggedMins: integer("delay_flagged_mins"),
  delayNotifiedAt: timestamp("delay_notified_at", { withTimezone: true }),
  delayNotifiedMins: integer("delay_notified_mins"),
  // Dispatch handled it another way (already phoned the customer) — detection
  // keeps running, the automatic notice does not.
  delayMuted: boolean("delay_muted").notNull().default(false),
  // assignment lifecycle: none | offered | accepted | declined
  assignStatus: text("assign_status").notNull().default("none"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  declineReason: text("decline_reason").notNull().default(""),
  // required skill matching for dispatch
  requiredSkillClass: text("required_skill_class").notNull().default(""), // e.g. "HVAC" — filters techs on scheduler
  requiredSkills: text("required_skills").notNull().default(""),          // csv of individual skill tags required
  // soft-delete: when set, the job is archived (excluded from active lists) but never lost
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  // indexes for dispatcher search/filter at scale
  companyIdx: index("bk_company_idx").on(t.companyId),
  statusIdx: index("bk_status_idx").on(t.status),
  schedIdx: index("bk_sched_idx").on(t.scheduledAt),
  finishedIdx: index("bk_finished_idx").on(t.finishedAt),
  riderIdx: index("bk_rider_idx").on(t.riderId),
  customerIdx: index("bk_customer_idx").on(t.customerId),
  serviceIdx: index("bk_service_idx").on(t.serviceId),
  payStatusIdx: index("bk_paystatus_idx").on(t.paymentStatus),
  priorityIdx: index("bk_priority_idx").on(t.priority),
  regionIdx: index("bk_region_idx").on(t.region),
  deletedIdx: index("bk_deleted_idx").on(t.deletedAt),
  createdIdx: index("bk_created_idx").on(t.createdAt),
}));

/** Product & Service Catalog — reusable priced items the dispatcher drops into work orders.
 *  kind: service (labor) | product (material) | assembly (composite of other items). */
export const catalogItems = pgTable("catalog_items", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  kind: text("kind").notNull().default("product"), // service | product | assembly
  name: text("name").notNull(),
  sku: text("sku").notNull().default(""),
  category: text("category").notNull().default("General"),
  description: text("description").notNull().default(""),
  image: text("image").notNull().default(""),
  unit: text("unit").notNull().default("each"), // each | hour | sqft | ft | unit | job ...
  unitCost: numeric("unit_cost", { precision: 12, scale: 2, mode: "number" }).notNull().default(0), // your cost per unit
  markupPct: doublePrecision("markup_pct").notNull().default(0), // % markup over cost (auto mode)
  priceMode: text("price_mode").notNull().default("auto"), // auto (cost*(1+markup)) | manual
  unitPrice: numeric("unit_price", { precision: 12, scale: 2, mode: "number" }).notNull().default(0), // customer-facing price per unit (manual or cached auto)
  taxable: boolean("taxable").notNull().default(true),
  // assembly composition: JSON [{ itemId, qty }] — rolls up child cost/price
  components: text("components").notNull().default("[]"),
  // optional link to a legacy service template (migration provenance)
  serviceId: text("service_id"),
  active: boolean("active").notNull().default(true),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("catalog_company_idx").on(t.companyId),
}));

/**
 * GENERALIZED OPTIONS/TIER QUOTE ENGINE — Phase 3 cross-ICP synthesis #1 build
 * priority (13 of 17 researched ICPs independently converged on this pattern:
 * Selections Studio / Options Catalog / Upgrade Catalogue / Material Tier
 * Catalog / Door Configurator / Price Book are all the same underlying shape).
 *
 * A company defines reusable "option categories" (e.g. "Flooring", "Garage
 * Door", "Paint Grade") each with 2+ tiers (e.g. Good/Better/Best) carrying a
 * price delta. These are attached to a booking/quote via a customer-facing,
 * token-based selection page (no login required — reuses bookings.publicToken,
 * same trust model as the existing live-tracking link) where the customer
 * picks a tier per category and e-signs (typed name) to lock in the price.
 * Selections roll up into the booking's line items via the existing
 * buildUnitLineItem/recomputeBooking pipeline — no separate pricing engine.
 */
export const optionCategories = pgTable("option_categories", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  name: text("name").notNull(), // e.g. "Flooring", "Paint Grade", "Garage Door Model"
  description: text("description").notNull().default(""), // shown to the customer above the tier cards
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("optcat_company_idx").on(t.companyId),
}));

export const optionCategoryItems = pgTable("option_category_items", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  categoryId: text("category_id")
    .notNull()
    .references(() => optionCategories.id, { onDelete: "cascade" }),
  tierLabel: text("tier_label").notNull().default(""), // "Good" | "Better" | "Best" | custom
  name: text("name").notNull(), // e.g. "Luxury Vinyl Plank"
  description: text("description").notNull().default(""),
  image: text("image").notNull().default(""),
  priceDelta: numeric("price_delta", { precision: 12, scale: 2, mode: "number" }).notNull().default(0), // added to the base price when selected (can be 0 for the included/default tier)
  unitCost: numeric("unit_cost", { precision: 12, scale: 2, mode: "number" }).notNull().default(0), // optional COGS delta, for margin/attach-rate reporting only
  isDefault: boolean("is_default").notNull().default(false), // pre-selected tier when the customer opens the page
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: now(),
}, (t) => ({
  categoryIdx: index("optitem_category_idx").on(t.categoryId),
  companyIdx: index("optitem_company_idx").on(t.companyId),
}));

/** One row per (booking, category) — the customer's locked-in tier choice + e-sign. */
export const bookingOptionSelections = pgTable("booking_option_selections", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  bookingId: text("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  categoryId: text("category_id").notNull(),
  categoryName: text("category_name").notNull().default(""), // snapshot at selection time
  itemId: text("item_id").notNull(),
  itemName: text("item_name").notNull().default(""), // snapshot
  tierLabel: text("tier_label").notNull().default(""), // snapshot
  priceDelta: numeric("price_delta", { precision: 12, scale: 2, mode: "number" }).notNull().default(0), // snapshot
  selectedBy: text("selected_by").notNull().default("customer"), // customer | staff
  signatureName: text("signature_name").notNull().default(""), // typed e-sign name
  selectedAt: timestamp("selected_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  bookingIdx: index("optsel_booking_idx").on(t.bookingId),
  companyIdx: index("optsel_company_idx").on(t.companyId),
}));

/**
 * Customer-initiated change requests on a booked appointment.
 *
 * A cancellation is NEVER applied straight to the booking — it lands here as a
 * pending row the office approves or declines, so a job can't vanish off the
 * dispatch board on its own and every request keeps its reason, who decided,
 * and when. A reschedule outside the tenant's cutoff is applied immediately but
 * still recorded here (status "applied") as the audit trail of what moved and
 * from when. Policy lives in shared/change-policy.ts.
 */
export const bookingChangeRequests = pgTable("booking_change_requests", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  bookingId: text("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  // who asked. customer id for the portal; may be an admin acting on their behalf.
  requestedBy: text("requested_by").notNull().default(""),
  requestedByName: text("requested_by_name").notNull().default(""),
  kind: text("kind").notNull(), // cancel | reschedule
  status: text("status").notNull().default("pending"), // pending | approved | declined | applied | withdrawn
  reason: text("reason").notNull().default(""), // customer's words, shown to the office
  // reschedule only: the time the customer asked for, and the time it was on
  // before, so the office sees the move and an applied change is reversible.
  proposedAt: timestamp("proposed_at", { withTimezone: true }),
  previousAt: timestamp("previous_at", { withTimezone: true }),
  decidedBy: text("decided_by").notNull().default(""),
  decidedByName: text("decided_by_name").notNull().default(""),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note").notNull().default(""), // office reply back to the customer
  createdAt: now(),
}, (t) => ({
  companyIdx: index("chgreq_company_idx").on(t.companyId),
  bookingIdx: index("chgreq_booking_idx").on(t.bookingId),
  statusIdx: index("chgreq_status_idx").on(t.companyId, t.status),
}));

/** Live rider location pings during an active job (track history) */
export const trackingPings = pgTable("tracking_pings", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  bookingId: text("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  phase: text("phase").notNull().default("enroute"), // enroute | onsite | return — for mileage segmentation
  createdAt: now(),
}, (t) => ({
  // hot path: every ping reads "latest by booking" — composite makes it an index seek
  bookingCreatedIdx: index("tp_booking_created_idx").on(t.bookingId, t.createdAt),
  createdIdx: index("tp_created_idx").on(t.createdAt), // for retention purge sweeps
  companyIdx: index("tp_company_idx").on(t.companyId),
}));

/** Invoices / payments */
export const invoices = pgTable("invoices", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  bookingId: text("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  customerId: text("customer_id")
    .notNull()
    .references(() => user.id),
  number: text("number").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2, mode: "number" }).notNull(),
  tax: numeric("tax", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
  total: numeric("total", { precision: 12, scale: 2, mode: "number" }).notNull(),
  status: text("status").notNull().default("unpaid"), // unpaid | processing | paid | refunded | failed
  method: text("method").notNull().default("card"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  // ---- Stripe payment linkage ----
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeChargeId: text("stripe_charge_id"),
  amountRefunded: numeric("amount_refunded", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
  currency: text("currency").notNull().default("cad"),
  lastPaymentError: text("last_payment_error"),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("inv_company_idx").on(t.companyId),
  bookingIdx: index("inv_booking_idx").on(t.bookingId),
  piIdx: index("inv_pi_idx").on(t.stripePaymentIntentId),
}));

/** Idempotency keys — dedupe money-mutating requests + replay webhook events. */
export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(), // client key or stripe event id
  scope: text("scope").notNull().default("payment"),
  responseStatus: integer("response_status"),
  responseBody: text("response_body"),
  createdAt: now(),
});

/** Immutable payment ledger — append-only audit trail of every money movement. */
export const paymentLedger = pgTable("payment_ledger", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  invoiceId: text("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
  bookingId: text("booking_id"),
  // charge | refund | dispute | adjustment
  kind: text("kind").notNull(),
  // amount in major units (positive = money in, negative = money out)
  amount: numeric("amount", { precision: 12, scale: 2, mode: "number" }).notNull(),
  currency: text("currency").notNull().default("cad"),
  stripeObjectId: text("stripe_object_id"), // pi_… / ch_… / re_… / evt_…
  status: text("status").notNull(), // succeeded | pending | failed
  memo: text("memo"),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("ledger_company_idx").on(t.companyId),
  invIdx: index("ledger_invoice_idx").on(t.invoiceId),
  bookingIdx: index("ledger_booking_idx").on(t.bookingId),
}));

/** In-app notifications */
export const notifications = pgTable("notifications", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  bookingId: text("booking_id").references(() => bookings.id, {
    onDelete: "cascade",
  }),
  type: text("type").notNull(), // booking_confirmed, assigned, enroute, arrived, completed, reminder, receipt
  title: text("title").notNull(),
  body: text("body").notNull(),
  read: boolean("read").notNull().default(false),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("notif_company_idx").on(t.companyId),
}));

/**
 * Expo push tokens — one row per (user, device). A user can have several
 * (phone + tablet). We store the Expo token (ExponentPushToken[...]) and send
 * via the Expo Push API. Tokens are pruned when Expo reports them invalid.
 */
export const pushTokens = pgTable("push_tokens", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(), // ExponentPushToken[...]
  platform: text("platform").notNull().default("ios"), // ios | android
  deviceName: text("device_name").notNull().default(""),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  userIdx: index("push_tokens_user_idx").on(t.userId),
}));

/** Reviews */
export const reviews = pgTable("reviews", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  bookingId: text("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  customerId: text("customer_id")
    .notNull()
    .references(() => user.id),
  riderId: text("rider_id").references(() => riders.id),
  rating: integer("rating").notNull(),
  comment: text("comment").notNull().default(""),
  hidden: boolean("hidden").notNull().default(false),
  featured: boolean("featured").notNull().default(false),
  reply: text("reply").notNull().default(""),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("review_company_idx").on(t.companyId),
}));

/** Singleton company settings (row id = "default") */
export const companySettings = pgTable("company_settings", {
  id: text("id").primaryKey().default("default"),
  companyId: text("company_id").notNull().default("default"),
  name: text("name").notNull().default("NVC 360"),
  legalName: text("legal_name").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  address: text("address").notNull().default("423 Main Street, Winnipeg, Manitoba, Canada"),
  lat: doublePrecision("lat").notNull().default(49.8951),
  lng: doublePrecision("lng").notNull().default(-97.1384),
  timezone: text("timezone").notNull().default("America/Winnipeg"),
  currency: text("currency").notNull().default("CAD"),
  taxRate: doublePrecision("tax_rate").notNull().default(5), // % (GST 5% MB) — fallback when region unknown
  taxLabel: text("tax_label").notNull().default("GST"),
  defaultRegion: text("default_region").notNull().default("MB"), // default tax region code
  autoTaxByRegion: boolean("auto_tax_by_region").notNull().default(true),
  logo: text("logo").notNull().default(""),
  // Original location of the logo on the tenant's own website (from "Grab Brand
  // Assets"). We keep BOTH: `logo` is our hosted/durable copy used in emails &
  // UI; `logoSourceUrl` preserves the link to where it was found on their site.
  logoSourceUrl: text("logo_source_url").notNull().default(""),
  brandColor: text("brand_color").notNull().default("#06B6D4"),
  accentColor: text("accent_color").notNull().default(""),
  // Worker-facing noun for this tenant — relabels the whole app (Technician,
  // Driver, Plumber, Cleaner, Pro…). Singular + plural so copy reads naturally.
  workerNoun: text("worker_noun").notNull().default("Technician"),
  workerNounPlural: text("worker_noun_plural").notNull().default("Technicians"),
  // Same idea for the people this tenant serves (Customer, Client, Patient,
  // Passenger, Resident, Family…) and their unit of work (Job, Visit, Ride,
  // Delivery, Route, Appointment…). Seeded from the ICP preset at
  // provisioning, editable via the AI brand-scout review screen.
  customerNoun: text("customer_noun").notNull().default("Customer"),
  customerNounPlural: text("customer_noun_plural").notNull().default("Customers"),
  jobNoun: text("job_noun").notNull().default("Job"),
  jobNounPlural: text("job_noun_plural").notNull().default("Jobs"),
  // AI-onboarding enrichment (from "Grab Brand Assets").
  tagline: text("tagline").notNull().default(""),
  hours: text("hours").notNull().default(""), // JSON string: [{day,open,close}] or freeform
  services: text("services").notNull().default(""), // JSON string: string[]
  socials: text("socials").notNull().default(""), // JSON string: {facebook,instagram,...}
  geofenceRadiusM: integer("geofence_radius_m").notNull().default(150), // auto-arrive radius from job address (meters)
  // ── Review requests ────────────────────────────────────────────────────
  // A completed job schedules ONE review-request SMS this many minutes later
  // (services/reviews.ts). 0 or disabled = never ask.
  reviewRequestEnabled: boolean("review_request_enabled").notNull().default(true),
  reviewRequestDelayMins: integer("review_request_delay_mins").notNull().default(120),
  // Where 4-5 star reviewers get sent to leave a public review. Ratings of 3
  // or below are deliberately NOT routed here — they go to the office as
  // private feedback so the company can fix it before it becomes public.
  googleReviewUrl: text("google_review_url").notNull().default(""),
  website: text("website").notNull().default(""),
  // ── Customer-initiated appointment changes ─────────────────────────────
  // Who owns a change to a booked appointment is a per-company decision, so it
  // lives here rather than being hardcoded. Defaults match the shipped policy
  // in shared/change-policy.ts: the customer may move their own appointment
  // outside the cutoff, and may ASK to cancel, but a cancellation is always
  // approved by the office so nothing silently leaves the dispatch board.
  allowCustomerReschedule: boolean("allow_customer_reschedule").notNull().default(true),
  allowCustomerCancelRequest: boolean("allow_customer_cancel_request").notNull().default(true),
  // Hours before the appointment where self-serve stops and changes need an
  // office approval instead. 0 = no cutoff (always self-serve).
  customerChangeCutoffHours: integer("customer_change_cutoff_hours").notNull().default(12),
  // ── Running-late notices (shared/delay-policy.ts) ───────────────────────
  // Detection is automatic; the notice waits delayAutoSendAfterMins for a
  // human to send, adjust, or mute it, then goes out on its own. 0 = never
  // auto-send, dispatcher only.
  delayNoticeEnabled: boolean("delay_notice_enabled").notNull().default(true),
  delayNoticeThresholdMins: integer("delay_notice_threshold_mins").notNull().default(15),
  delayNoticeAutoSendAfterMins: integer("delay_notice_auto_send_after_mins").notNull().default(10),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("settings_company_idx").on(t.companyId),
}));

/** Reusable colored tags, scoped to clients/techs/both */
export const tags = pgTable("tags", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  label: text("label").notNull(),
  color: text("color").notNull().default("#06B6D4"),
  scope: text("scope").notNull().default("both"), // client | tech | both
  createdAt: now(),
}, (t) => ({
  companyIdx: index("tags_company_idx").on(t.companyId),
}));

/**
 * Shared work-order/form categories. One flat, ordered list per tenant, used
 * by BOTH the Form Builder (template "Category" dropdown) and the Product
 * Catalog (item "Category" field) so admins manage the list in exactly one
 * place and it stays in sync everywhere it's used. Seeded on first read from
 * the tenant's industry preset (see industry-presets.ts categories[]) so a
 * fresh tenant isn't empty, but is fully editable afterward.
 */
export const formCategories = pgTable("form_categories", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("form_categories_company_idx").on(t.companyId),
}));

/** Tag assignment join (entityType: client | tech) */
export const entityTags = pgTable("entity_tags", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  tagId: text("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(), // client | tech
  entityId: text("entity_id").notNull(),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("etags_company_idx").on(t.companyId),
}));

/** Admin-defined custom fields per entity type */
export const customFields = pgTable("custom_fields", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  entity: text("entity").notNull(), // client | tech | work_order
  label: text("label").notNull(),
  // text | textarea | number | date | select | checkbox | file | signature | payment | note
  type: text("type").notNull().default("text"),
  options: text("options").notNull().default("[]"), // JSON for select
  placeholder: text("placeholder").notNull().default(""),
  required: boolean("required").notNull().default(false),
  section: text("section").notNull().default("General"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("cf_company_idx").on(t.companyId),
}));

/** Stored values for custom fields */
export const customFieldValues = pgTable("custom_field_values", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  fieldId: text("field_id").notNull().references(() => customFields.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  value: text("value").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("cfv_company_idx").on(t.companyId),
}));

/** File attachments on any entity (client/tech/work_order) — local storage */
export const attachments = pgTable("attachments", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  entityType: text("entity_type").notNull(), // client | tech | work_order
  entityId: text("entity_id").notNull(),
  filename: text("filename").notNull(),
  url: text("url").notNull(),
  storageKey: text("storage_key").notNull().default(""), // object-store key for deletion
  mime: text("mime").notNull().default(""),
  size: integer("size").notNull().default(0),
  label: text("label").notNull().default(""), // e.g. "Driver License", "Safety Cert"
  uploadedBy: text("uploaded_by").notNull().default(""),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("attach_company_idx").on(t.companyId),
}));

/** Technician shifts & time-off */
export const techShifts = pgTable("tech_shifts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  riderId: text("rider_id").notNull().references(() => riders.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("shift"), // shift | timeoff
  date: timestamp("date", { withTimezone: true }).notNull(),
  startMin: integer("start_min").notNull().default(540), // minutes from midnight (9:00)
  endMin: integer("end_min").notNull().default(1020), // 17:00
  note: text("note").notNull().default(""),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("shift_company_idx").on(t.companyId),
}));

/** Service area zones (map polygons) */
export const serviceZones = pgTable("service_zones", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  name: text("name").notNull(),
  color: text("color").notNull().default("#06B6D4"),
  polygon: text("polygon").notNull().default("[]"), // JSON [[lat,lng],...]
  active: boolean("active").notNull().default(true),
  surgeMultiplier: doublePrecision("surge_multiplier").notNull().default(1),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("zone_company_idx").on(t.companyId),
}));

/** Technician payouts / earnings */
export const payouts = pgTable("payouts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  riderId: text("rider_id").notNull().references(() => riders.id, { onDelete: "cascade" }),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  jobsCount: integer("jobs_count").notNull().default(0),
  // gross == net == the sum of real per-job tech pay (hourly on-site time +
  // per-unit pay). feePct/fee are legacy columns from the old "percentage of the
  // customer's invoice" model and are written as 0 on every new payout. The
  // column default is left at 20 deliberately: changing it would make drizzle
  // rebuild the table (and every index) on remote Turso for no benefit.
  gross: numeric("gross", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
  feePct: doublePrecision("fee_pct").notNull().default(20),
  fee: numeric("fee", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
  net: numeric("net", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
  // Breakdown of how the total was reached, so the office can answer "why is my
  // cheque this number?" without re-opening every job.
  hourlyPay: numeric("hourly_pay", { precision: 12, scale: 2, mode: "number" }).notNull().default(0), // on-site hours x hourly rate
  unitPay: numeric("unit_pay", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),     // per-unit line pay
  onSiteMinutes: doublePrecision("on_site_minutes").notNull().default(0),
  // Jobs in this payout that produced $0 because no hourly rate was set and
  // there was no per-unit pay — the office needs to fix the rate.
  unratedJobs: integer("unrated_jobs").notNull().default(0),
  breakdown: text("breakdown").notNull().default(""), // JSON per-job detail
  status: text("status").notNull().default("pending"), // pending | paid
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("payout_company_idx").on(t.companyId),
}));

/** Audit log of admin actions */
export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  actorId: text("actor_id").notNull().default(""),
  actorName: text("actor_name").notNull().default(""),
  action: text("action").notNull(), // create | update | delete | assign | payout | ...
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull().default(""),
  summary: text("summary").notNull().default(""),
  meta: text("meta").notNull().default("{}"),
  createdAt: now(),
}, (t) => ({
  entityIdx: index("audit_entity_idx").on(t.entityType, t.entityId),
  actorIdx: index("audit_actor_idx").on(t.actorId),
  createdIdx: index("audit_created_idx").on(t.createdAt),
  companyIdx: index("audit_company_idx").on(t.companyId),
}));

/** Notification rule matrix: for each event, who gets notified and over which channels. */
export const notificationRules = pgTable("notification_rules", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  event: text("event").notNull(), // created | assigned | accepted | declined | enroute | arrived | started | completed | cancelled | receipt
  recipient: text("recipient").notNull(), // client | tech | office
  inApp: boolean("in_app").notNull().default(true),
  email: boolean("email").notNull().default(false),
  sms: boolean("sms").notNull().default(false),
  webhook: boolean("webhook").notNull().default(false),
  // optional custom override template; {{vars}} supported. empty = use default.
  template: text("template").notNull().default(""),
  // optional custom subject line for email ({{vars}} supported). empty = use default.
  emailSubject: text("email_subject").notNull().default(""),
  // rich HTML-email block design as JSON (array of blocks). empty = fall back to text template.
  emailDesign: text("email_design").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("notifrule_company_idx").on(t.companyId),
}));

/** Per-company per-channel delivery configuration (sender identity, quiet hours, master switch). */
export const notificationChannels = pgTable("notification_channels", {
  id: text("id").primaryKey().default("default"),
  companyId: text("company_id").notNull().default("default"),
  // master enable per channel
  inAppEnabled: boolean("in_app_enabled").notNull().default(true),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  smsEnabled: boolean("sms_enabled").notNull().default(true),
  webhookEnabled: boolean("webhook_enabled").notNull().default(true),
  // email sender identity
  emailFromName: text("email_from_name").notNull().default("NVC 360"),
  emailFromAddress: text("email_from_address").notNull().default(""),
  emailReplyTo: text("email_reply_to").notNull().default(""),
  emailFooter: text("email_footer").notNull().default(""),
  // default email body template (tokens: firstName, address, jobName, jobNumber...)
  emailBodyTemplate: text("email_body_template").notNull().default(""),
  // default sms body template
  smsBodyTemplate: text("sms_body_template").notNull().default(""),
  // sms sender
  smsFromNumber: text("sms_from_number").notNull().default(""),
  smsSenderId: text("sms_sender_id").notNull().default(""),
  // quiet hours (24h local), suppress sms/email outside window. blank = always on.
  quietHoursEnabled: boolean("quiet_hours_enabled").notNull().default(false),
  quietStart: text("quiet_start").notNull().default("21:00"),
  quietEnd: text("quiet_end").notNull().default("08:00"),
  quietChannels: text("quiet_channels").notNull().default("sms,email"), // csv of channels affected
  // ---- branded HTML email identity (applies to every email template) ----
  emailLogoUrl: text("email_logo_url").notNull().default(""), // header logo (uploaded file path or external URL)
  emailBrandColor: text("email_brand_color").notNull().default("#06B6D4"), // header gradient + button color
  emailHeaderStyle: text("email_header_style").notNull().default("gradient"), // gradient | solid | minimal
  emailBgColor: text("email_bg_color").notNull().default("#f1f5f9"), // outer page background
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("notifchan_company_idx").on(t.companyId),
}));

/** Reusable branded email templates (block-based designs) usable across any event. */
export const emailTemplates = pgTable("email_templates", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  name: text("name").notNull().default("Untitled template"),
  description: text("description").notNull().default(""),
  subject: text("subject").notNull().default(""),
  // JSON array of email blocks
  design: text("design").notNull().default("[]"),
  isBuiltin: boolean("is_builtin").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("emailtpl_company_idx").on(t.companyId),
}));

/** Webhook endpoints that receive event POSTs. */
export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  label: text("label").notNull().default(""),
  url: text("url").notNull(),
  secret: text("secret").notNull().default(""),
  // csv of events to receive, or "*" for all
  events: text("events").notNull().default("*"),
  active: boolean("active").notNull().default(true),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("webhook_company_idx").on(t.companyId),
}));

/** Delivery log for every notification fired (audit + debugging). */
export const notificationDeliveries = pgTable("notification_deliveries", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  event: text("event").notNull(),
  bookingId: text("booking_id"),
  recipient: text("recipient").notNull(), // client | tech | office
  channel: text("channel").notNull(), // in_app | email | sms | webhook
  target: text("target").notNull().default(""), // phone/email/url/userId
  status: text("status").notNull().default("sent"), // sent | failed | skipped
  detail: text("detail").notNull().default(""),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("notifdeliv_company_idx").on(t.companyId),
}));

/** Pending technician invites (invite-only onboarding). */
export const techInvites = pgTable("tech_invites", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  phone: text("phone").notNull().default(""),
  skillClass: text("skill_class").notNull().default("General"),
  token: text("token").notNull().$defaultFn(() => crypto.randomUUID().replace(/-/g, "")),
  status: text("status").notNull().default("pending"), // pending | accepted | revoked
  invitedBy: text("invited_by").notNull().default(""),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("techinvite_company_idx").on(t.companyId),
}));

/** API keys for external agents / integrations (Claude Code, MCP clients, scripts). */
export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  label: text("label").notNull().default(""),
  // sha-256 hash of the full secret; raw key shown only once at creation
  hashedKey: text("hashed_key").notNull(),
  // first chars of the key for display/identification e.g. "nvc_a1b2c3"
  prefix: text("prefix").notNull().default(""),
  // csv of scopes, e.g. "workorders:read,workorders:write,clients:read" or "*"
  scopes: text("scopes").notNull().default(""),
  // "secret" = server-side full API (nvc_); "public" = browser-safe publishable
  // key (nvcpub_) usable ONLY by hosted intake forms / public submit endpoint.
  keyType: text("key_type").notNull().default("secret"),
  // For PUBLIC (nvcpub_) keys only: the full browser-safe key, stored so it can
  // be re-displayed / auto-embedded in share links. Empty for secret keys
  // (those are never recoverable). Browser-safe by design — no API access.
  publicKey: text("public_key").notNull().default(""),
  // csv of allowed browser origins for a public key (CORS allow-list). Empty = any.
  allowedOrigins: text("allowed_origins").notNull().default(""),
  createdBy: text("created_by").notNull().default(""),
  createdByName: text("created_by_name").notNull().default(""),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("apikey_company_idx").on(t.companyId),
}));

/**
 * Hosted customer-facing intake form. One tenant can have many. Rendered at the
 * public route /f/:companyId/:slug and embeddable via iframe. Submissions create
 * a pending booking (lead) in the owning tenant. Bound to a public key so the
 * browser submit can authenticate without a session.
 */
export const intakeForms = pgTable("intake_forms", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  slug: text("slug").notNull(), // url segment, unique per company
  title: text("title").notNull().default("Request Service"),
  intro: text("intro").notNull().default(""), // short blurb shown atop the form
  // rich field schema: JSON [{id,key,type,label,placeholder,options[],required,enabled,sectionId,width}]
  fields: text("fields").notNull().default("[]"),
  // form sections: JSON [{id,title,description}] — fields reference sectionId
  sections: text("sections").notNull().default("[]"),
  // master "where it gets sent" — submission notification recipient
  recipientName: text("recipient_name").notNull().default(""),
  recipientEmail: text("recipient_email").notNull().default(""),
  // public key id this form submits with (FK-ish to api_keys.id, keyType=public)
  publicKeyId: text("public_key_id").notNull().default(""),
  // branding
  brandColor: text("brand_color").notNull().default("#06b6d4"),
  logoUrl: text("logo_url").notNull().default(""),
  successMessage: text("success_message").notNull().default("Thanks! We've received your request and will reach out shortly."),
  // default priority + service fallback when submitter doesn't pick one
  defaultServiceId: text("default_service_id").notNull().default(""),
  active: boolean("active").notNull().default(true),
  submitCount: integer("submit_count").notNull().default(0),
  createdBy: text("created_by").notNull().default(""),
  // "lead" = customer-facing intake (default, unchanged behavior).
  // "work_order" = internal employee work-order creation form: PIN-gated,
  // exposes client search/create + full catalog line-item builder + optional
  // technician/schedule assignment, mirroring the admin work-order modal.
  formType: text("form_type").notNull().default("lead"),
  // shared employee access code for work_order forms (not a login — a simple
  // shared PIN so the link alone isn't enough to create real work orders).
  accessCode: text("access_code").notNull().default(""),
  // work_order forms only: whether the employee submitting is allowed to pick
  // a technician + exact schedule time, or must leave it for a dispatcher.
  allowTechAssign: boolean("allow_tech_assign").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("intake_company_idx").on(t.companyId),
  slugIdx: index("intake_slug_idx").on(t.companyId, t.slug),
}));

/** Raw audit trail of every public form submission (before/independent of booking). */
export const intakeSubmissions = pgTable("intake_submissions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  companyId: text("company_id").notNull().default("default"),
  formId: text("form_id").notNull().default(""),
  bookingId: text("booking_id").notNull().default(""), // resulting lead, if created
  payload: text("payload").notNull().default("{}"), // JSON of submitted answers
  ipHash: text("ip_hash").notNull().default(""),
  origin: text("origin").notNull().default(""),
  createdAt: now(),
}, (t) => ({
  companyIdx: index("intakesub_company_idx").on(t.companyId),
  formIdx: index("intakesub_form_idx").on(t.formId),
}));

/**
 * B2B customer registry (the tenant catalog). Each row IS a tenant: its `id`
 * (slug) becomes the companyId stamped on every tenant-owned row. This table is
 * GLOBAL (not tenant-scoped) and is the allow-list source for cross-tenant
 * access by superadmins.
 */
/**
 * Platform-wide OAuth app credentials (Client ID/Secret per provider).
 * GLOBAL & superadmin-managed: registered ONCE by the platform owner so that
 * every tenant can just click "Connect" and authorize on the provider's site —
 * no API keys ever touched by tenants. Falls back to env vars when absent.
 */
export const oauthAppCredentials = pgTable("oauth_app_credentials", {
  provider: text("provider").primaryKey(), // quickbooks | gmail | google_calendar | ...
  clientId: text("client_id").notNull().default(""),
  clientSecret: text("client_secret").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  updatedBy: text("updated_by").notNull().default(""), // superadmin user id
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  createdAt: now(),
});

export const companies = pgTable("companies", {
  id: text("id").primaryKey(), // slug, e.g. "acme-hvac" — used as companyId everywhere
  name: text("name").notNull(),
  contactEmail: text("contact_email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  plan: text("plan").notNull().default("starter"), // starter | pro | enterprise
  industry: text("industry").notNull().default(""), // Primary Industry (ICP) — drives template/service presets. "other" = custom, see industryOther.
  industryOther: text("industry_other").notNull().default(""), // free-text business description when industry="other" (no preset fits)
  status: text("status").notNull().default("active"), // active | suspended
  createdBy: text("created_by").notNull().default(""), // superadmin user id
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  createdAt: now(),
});

/**
 * A person's membership OF a company. This is what makes one human able to work
 * for several companies at once.
 *
 * The `user` table is the IDENTITY (name, email, password, phone) and stays
 * globally unique by email — one human, one login, one password. Everything
 * that is actually company-specific lives here instead, one row per company:
 * their role, their permission overrides, whether they're a technician or a
 * driver, and who they report to.
 *
 * So a technician working for both Acme HVAC and Bolt Plumbing is ONE user row
 * and TWO membership rows. They sign in once and switch between companies.
 * Acme can make them a manager without Bolt's org chart changing, and Bolt can
 * remove them without touching their Acme access or their login.
 *
 * `authMiddleware` reads the membership for the acting company on every request
 * and overlays its role/permissions onto the session user, which is what makes
 * every existing `user.role` check become per-company automatically.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    companyId: text("company_id").notNull(),
    // Role AT THIS COMPANY. Same vocabulary as user.role
    // (superadmin | admin | manager | rider | customer).
    role: text("role").notNull().default("customer"),
    // Per-person permission override at this company (JSON array). NULL = role defaults.
    permissions: text("permissions"),
    // For field staff (role=rider): 'technician' | 'driver'.
    staffType: text("staff_type"),
    // Who they report to at THIS company (user.id).
    managerId: text("manager_id"),
    // active  = can sign in and work for this company
    // invited = added but hasn't accepted yet (no access until they do)
    // disabled= access revoked, kept for history so their jobs still resolve
    status: text("status").notNull().default("active"),
    // Set when an admin adds someone who ALREADY has a login elsewhere. The
    // second company never sets a password; the person accepts to join.
    invitedBy: text("invited_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [
    // One membership per person per company. This is the integrity rule that
    // keeps "add this tech" idempotent instead of silently duplicating them.
    uniqueIndex("memberships_user_company_uidx").on(table.userId, table.companyId),
    index("memberships_company_idx").on(table.companyId),
    index("memberships_user_idx").on(table.userId),
  ],
);

/**
 * GLOBAL, superadmin-curated deep research per ICP (industry-presets.ts id).
 * One row per industry, hand-researched from trade associations, standards
 * bodies, university/clinical literature, and trade publications — NOT
 * AI-generated. Feeds template-scout.ts / form-scout.ts as additional
 * generation context (best practices, real workflow stages, compliance
 * considerations, refined tone/notification guidance) on top of the static
 * IndustryPreset defaults, so starter templates/forms for that industry are
 * grounded in how the trade actually works, not just a generic guess.
 * Optional by design — an industry with no row here still gets the baseline
 * IndustryPreset experience; this only enriches it further.
 */
export const icpKnowledgeBase = pgTable("icp_knowledge_base", {
  industry: text("industry").primaryKey(), // industry-presets.ts id, e.g. "flooring"
  summary: text("summary").notNull().default(""), // 2-3 sentence grounding on the vertical
  bestPractices: text("best_practices").notNull().default(""), // JSON string[] — concrete operational best practices
  workflowNotes: text("workflow_notes").notNull().default(""), // how work actually flows; standards/certifications referenced
  terminologyNotes: text("terminology_notes").notNull().default(""), // industry jargon beyond the noun fields on IndustryPreset
  toneRefinement: text("tone_refinement").notNull().default(""), // expanded tone guidance beyond preset.aiTone
  notificationRefinement: text("notification_refinement").notNull().default(""), // expanded notification guidance beyond preset.notificationGuidance
  complianceNotes: text("compliance_notes").notNull().default(""), // regulatory/compliance considerations (licensing, EVV, safety, etc.)
  sources: text("sources").notNull().default(""), // JSON string {title,url}[] — citations for the research above
  researchedBy: text("researched_by").notNull().default(""), // superadmin user id who curated this
  researchedAt: timestamp("researched_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  createdAt: now(),
});

/**
 * Physical service locations — the "property" a job happens at.
 *
 * One row per distinct address per tenant (addressNormalized is the dedupe
 * key). Bookings link to it via bookings.propertyId, which is what turns a
 * pile of unrelated jobs into a permanent service history for that address
 * ("CarFax for buildings").
 *
 * publicToken backs the no-login customer property hub at /p/:token — a
 * persistent magic link that survives across jobs, unlike the per-job
 * tracking token which is scoped to one work order.
 */
export const properties = pgTable(
  "properties",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    companyId: text("company_id").notNull().default("default"),
    // dedupe key: lowercased, punctuation-stripped, whitespace-collapsed address
    addressNormalized: text("address_normalized").notNull(),
    // what we actually show the user — the address as originally entered
    addressDisplay: text("address_display").notNull().default(""),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    // most recent customer associated with this address (properties outlive customers)
    customerId: text("customer_id").references(() => user.id),
    // persistent public token for /p/:token — rotatable from admin for PII safety
    publicToken: text("public_token")
      .notNull()
      .$defaultFn(() => crypto.randomUUID().replace(/-/g, "").slice(0, 16)),
    notes: text("notes").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    companyIdx: index("prop_company_idx").on(t.companyId),
    addrIdx: index("prop_addr_idx").on(t.companyId, t.addressNormalized),
    tokenIdx: index("prop_token_idx").on(t.publicToken),
  }),
);

/**
 * Timestamped history of everything that happened on a job.
 *
 * The bookings table stores current *state* (status, startedAt, finishedAt).
 * This stores the *narrative* — an append-only event log. It's what powers the
 * customer-facing job timeline ("8:15 AM Technician arrived · 11:20 AM
 * Moisture testing complete") and the permanent job record.
 *
 * customerVisible gates what the homeowner sees on /t/:token — internal events
 * (staff notes, tech declined, pricing changes) stay office-only.
 */
export const jobEvents = pgTable(
  "job_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    companyId: text("company_id").notNull().default("default"),
    bookingId: text("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    // machine key: created | assigned | accepted | declined | enroute | arrived |
    // started | completed | cancelled | photo_added | signature_captured |
    // note_added | checklist_completed | message | review_submitted
    kind: text("kind").notNull(),
    actorRole: text("actor_role").notNull().default("system"), // system | dispatch | tech | client
    actorName: text("actor_name").notNull().default(""),
    // human-readable one-liner rendered directly in the timeline
    label: text("label").notNull().default(""),
    detail: text("detail").notNull().default(""),
    meta: text("meta").notNull().default("{}"), // JSON — photo url, duration, etc.
    customerVisible: boolean("customer_visible").notNull().default(false),
    createdAt: now(),
  },
  (t) => ({
    companyIdx: index("jobev_company_idx").on(t.companyId),
    bookingIdx: index("jobev_booking_idx").on(t.bookingId),
    createdIdx: index("jobev_created_idx").on(t.createdAt),
  }),
);

/**
 * Deferred work queue — the thing that lets anything happen *later*.
 *
 * Until this existed, every notification in the system was reactive (fired the
 * instant a lifecycle event happened). This backs review requests ("2h after
 * completion"), maintenance reminders ("in 90 days"), warranty expiry nudges,
 * and the time-based automation triggers (tech_idle, sla_risk).
 *
 * Claimed by services/scheduler.ts with a conditional UPDATE so two server
 * instances can never double-fire the same task.
 */
export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    companyId: text("company_id").notNull().default("default"),
    // handler key registered in services/scheduler.ts
    kind: text("kind").notNull(), // review_request | maintenance_reminder | warranty_expiry | automation_check
    bookingId: text("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    propertyId: text("property_id").references(() => properties.id, { onDelete: "cascade" }),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    payload: text("payload").notNull().default("{}"), // JSON handler args
    status: text("status").notNull().default("pending"), // pending | running | done | failed | cancelled
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    companyIdx: index("schedtask_company_idx").on(t.companyId),
    // the hot query: claim due pending work
    dueIdx: index("schedtask_due_idx").on(t.status, t.runAt),
    bookingIdx: index("schedtask_booking_idx").on(t.bookingId),
  }),
);

/**
 * Recurring service agreements — the thing that turns a one-off job into
 * repeat revenue.
 *
 * A plan says "this property needs this service every N days". The scheduler
 * queues a `maintenance_reminder` task ahead of each due date; when it fires we
 * notify the customer (and the office), then roll nextDueAt forward by
 * intervalDays and queue the next one. Cancelling the plan cancels its pending
 * task, so a deactivated plan goes quiet immediately.
 */
export const maintenancePlans = pgTable(
  "maintenance_plans",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    companyId: text("company_id").notNull().default("default"),
    name: text("name").notNull().default(""), // "Bi-annual furnace tune-up"
    customerId: text("customer_id").references(() => user.id),
    propertyId: text("property_id").references(() => properties.id, { onDelete: "cascade" }),
    serviceId: text("service_id").references(() => services.id),
    address: text("address").notNull().default(""), // denormalised for reminder copy
    intervalDays: integer("interval_days").notNull().default(180),
    // how far ahead of nextDueAt the reminder goes out
    remindDaysBefore: integer("remind_days_before").notNull().default(7),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    lastServiceAt: timestamp("last_service_at", { withTimezone: true }),
    notes: text("notes").notNull().default(""),
    active: boolean("active").notNull().default(true),
    remindersSent: integer("reminders_sent").notNull().default(0),
    createdAt: now(),
  },
  (t) => ({
    companyIdx: index("mplan_company_idx").on(t.companyId),
    dueIdx: index("mplan_due_idx").on(t.active, t.nextDueAt),
    propIdx: index("mplan_prop_idx").on(t.propertyId),
  }),
);

/**
 * Per-tenant outgoing email sending domains (Resend).
 * Tenant submits a domain -> superadmin approves (creates in Resend) ->
 * DNS records stored -> tenant adds them -> auto-poller flips to verified.
 * A tenant's emailFromAddress is only honored once its domain is "verified".
 */
export const tenantEmailDomains = pgTable(
  "tenant_email_domains",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    companyId: text("company_id").notNull().default("default"),
    domain: text("domain").notNull(),
    resendDomainId: text("resend_domain_id"), // set once created in Resend
    status: text("status").notNull().default("pending"), // pending | verifying | verified | failed
    region: text("region").notNull().default("eu-west-1"),
    records: text("records").notNull().default("[]"), // JSON: [{record,name,type,value,priority?,status}]
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdBy: text("created_by").notNull().default(""),
    createdAt: now(),
  },
  (t) => ({
    companyIdx: index("ted_company_idx").on(t.companyId),
  }),
);
