import { db } from "./database";
import * as schema from "./database/schema";
import { auth } from "./auth";
import { eq } from "drizzle-orm";
import { attachMembership } from "./lib/memberships";

const U = "https://images.unsplash.com/";
const img = (id: string) => `${U}${id}?auto=format&fit=crop&w=900&q=70`;

const SERVICES = [
  { name: "HVAC Service Call", category: "HVAC", icon: "thermometer", basePrice: 140, durationMins: 90, image: img("photo-1581094794329-c8112a89af12"), description: "Heating & cooling diagnostics, repair and maintenance." },
  { name: "Plumbing Repair", category: "Plumbing", icon: "wrench", basePrice: 120, durationMins: 90, image: img("photo-1607472586893-edb57bdc0e39"), description: "Leaks, clogs, installs — fixed fast by licensed plumbers." },
  { name: "Electrical Service", category: "Electrical", icon: "zap", basePrice: 150, durationMins: 90, image: img("photo-1621905251189-08b45d6a269e"), description: "Wiring, panels, fixtures by licensed electricians." },
  { name: "Appliance Repair", category: "Appliance", icon: "washing-machine", basePrice: 110, durationMins: 75, image: img("photo-1581092918056-0c4c3acd3789"), description: "Fridge, washer, dryer & oven repairs." },
  { name: "Equipment Install", category: "Install", icon: "hammer", basePrice: 320, durationMins: 180, image: img("photo-1503387762-592deb58ef4e"), description: "New unit & equipment installation." },
  { name: "Delivery & Pickup", category: "Logistics", icon: "truck", basePrice: 45, durationMins: 45, image: img("photo-1586528116311-ad8dd3c8310d"), description: "Same-day pickup & delivery, tracked live." },
  { name: "Emergency Dispatch", category: "Emergency", icon: "siren", basePrice: 240, durationMins: 90, image: img("photo-1632833239869-a37e3a5806d2"), description: "24/7 rapid response for urgent service." },
  { name: "Preventive Maintenance", category: "Maintenance", icon: "clipboard-check", basePrice: 95, durationMins: 60, image: img("photo-1504328345606-18bbc8c9d7d1"), description: "Scheduled inspections & tune-ups." },
];

// Technicians around downtown Toronto with skill classes + map colors
const TECHS = [
  { name: "Marcus Lee", email: "marcus@nvc360.app", vehicle: "Service Van #12", skills: "HVAC,Electrical", skillClass: "HVAC", color: "#0ea5e9", lat: 43.6629, lng: -79.3957, status: "enroute" },
  { name: "Aisha Khan", email: "aisha@nvc360.app", vehicle: "Compact #04", skills: "Appliance,Maintenance", skillClass: "Appliance", color: "#10b981", lat: 43.6452, lng: -79.3806, status: "onsite" },
  { name: "Diego Ramos", email: "diego@nvc360.app", vehicle: "Pickup #21", skills: "Install,Emergency", skillClass: "Install", color: "#f59e0b", lat: 43.6708, lng: -79.3865, status: "available" },
  { name: "Priya Nair", email: "priya@nvc360.app", vehicle: "Service Van #08", skills: "Plumbing", skillClass: "Plumbing", color: "#a855f7", lat: 43.6510, lng: -79.4000, status: "available" },
  { name: "Tyler Brooks", email: "tyler@nvc360.app", vehicle: "Truck #33", skills: "Electrical,Install", skillClass: "Electrical", color: "#22d3ee", lat: 43.6580, lng: -79.3700, status: "break" },
  { name: "Sofia Russo", email: "sofia@nvc360.app", vehicle: "Compact #15", skills: "HVAC,Maintenance", skillClass: "HVAC", color: "#ec4899", lat: 43.6395, lng: -79.3900, status: "enroute" },
  { name: "Jamal Carter", email: "jamal@nvc360.app", vehicle: "Cargo Van #41", skills: "Logistics", skillClass: "Logistics", color: "#84cc16", lat: 43.6680, lng: -79.4050, status: "available" },
  { name: "Emma Wilson", email: "emma@nvc360.app", vehicle: "Service Van #19", skills: "Plumbing,Appliance", skillClass: "Plumbing", color: "#f97316", lat: 43.6470, lng: -79.3650, status: "offline" },
];

const CLIENTS = [
  { name: "Sarah Mitchell", email: "customer@nvc360.app", phone: "+14165550200" },
  { name: "Robert Chen", email: "robert@nvc360.app", phone: "+14165550211" },
  { name: "Linda Park", email: "linda@nvc360.app", phone: "+14165550222" },
];

const TEMPLATES = [
  {
    name: "HVAC Service Call", category: "HVAC", icon: "thermometer", color: "#0ea5e9", estimatedMins: 90,
    description: "Standard diagnostic + repair visit for heating/cooling systems.",
    fields: JSON.stringify([
      { id: "unit", label: "Unit Type", type: "select", required: true, options: ["Furnace", "AC", "Heat Pump", "Boiler"] },
      { id: "issue", label: "Reported Issue", type: "textarea", required: true },
      { id: "serial", label: "Serial #", type: "text", required: false },
    ]),
    checklist: JSON.stringify([
      { id: "c1", label: "Inspect unit & confirm fault" },
      { id: "c2", label: "Check refrigerant / pressures" },
      { id: "c3", label: "Test electrical connections" },
      { id: "c4", label: "Photo before/after (CompanyCam)" },
      { id: "c5", label: "Client sign-off" },
    ]),
  },
  {
    name: "Delivery Drop", category: "Logistics", icon: "truck", color: "#84cc16", estimatedMins: 30,
    description: "Pickup and deliver with proof of delivery.",
    fields: JSON.stringify([
      { id: "po", label: "PO / Order #", type: "text", required: true },
      { id: "items", label: "Item Count", type: "number", required: true },
      { id: "instructions", label: "Delivery Instructions", type: "textarea", required: false },
    ]),
    checklist: JSON.stringify([
      { id: "c1", label: "Verify items at pickup" },
      { id: "c2", label: "Confirm delivery address" },
      { id: "c3", label: "Capture proof-of-delivery photo" },
      { id: "c4", label: "Signature" },
    ]),
  },
  {
    name: "Equipment Install", category: "Install", icon: "hammer", color: "#f59e0b", estimatedMins: 180,
    description: "Full new-equipment installation workflow.",
    fields: JSON.stringify([
      { id: "model", label: "Model #", type: "text", required: true },
      { id: "location", label: "Install Location", type: "text", required: true },
      { id: "permit", label: "Permit Required?", type: "select", required: false, options: ["Yes", "No"] },
    ]),
    checklist: JSON.stringify([
      { id: "c1", label: "Confirm site readiness" },
      { id: "c2", label: "Remove old unit" },
      { id: "c3", label: "Install & connect new unit" },
      { id: "c4", label: "Test & commission" },
      { id: "c5", label: "Photo documentation" },
      { id: "c6", label: "Client walkthrough & sign-off" },
    ]),
  },
];

const RULES = [
  { name: "Auto-assign nearest qualified tech", description: "When a work order is created, assign the closest available technician whose skill class matches.", trigger: "wo_created", action: "auto_assign", actionConfig: JSON.stringify({ matchSkill: true, maxRadiusKm: 25 }), conditions: JSON.stringify({ priorityIn: ["normal", "high", "urgent"] }) },
  { name: "SMS client when tech departs", description: "Fire 'tech on the way' SMS with live tracking link the moment status changes to en route.", trigger: "tech_enroute", action: "send_sms", actionConfig: JSON.stringify({ template: "enroute" }), conditions: JSON.stringify({}) },
  { name: "Escalate idle technicians", description: "Notify dispatch if an available tech sits idle for more than 30 minutes during business hours.", trigger: "tech_idle", action: "notify_dispatch", actionConfig: JSON.stringify({ idleMins: 30 }), conditions: JSON.stringify({}), enabled: false },
  { name: "Reroute on SLA risk", description: "AI re-optimizes routes when a work order is at risk of missing its SLA window.", trigger: "sla_risk", action: "reroute", actionConfig: JSON.stringify({ bufferMins: 15 }), conditions: JSON.stringify({}) },
];

const INTEGRATIONS = [
  { provider: "quickbooks", accountLabel: "" },
  { provider: "gmail", accountLabel: "" },
  { provider: "google_calendar", accountLabel: "" },
  { provider: "office365", accountLabel: "" },
  { provider: "outlook", accountLabel: "" },
  { provider: "xero", accountLabel: "" },
  { provider: "companycam", accountLabel: "" },
];

export async function seed() {
  const existing = await db.select().from(schema.services).limit(1);
  if (existing.length > 0) {
    return { skipped: true, message: "Already seeded" };
  }

  await db.insert(schema.services).values(SERVICES);
  const templates = await db.insert(schema.taskTemplates).values(TEMPLATES).returning();
  await db.insert(schema.automationRules).values(RULES as any);
  await db.insert(schema.integrations).values(INTEGRATIONS);

  // dispatcher / company admin
  await ensureUser("Dana Ortiz", "admin@nvc360.app", "admin123", "admin", "+14165550100");

  // technician users + profiles
  const techIds: string[] = [];
  let i = 0;
  for (const t of TECHS) {
    const uid = await ensureUser(t.name, t.email, "rider123", "rider", "+1416555" + String(1000 + i).padStart(4, "0"));
    i++;
    if (uid) {
      const [exists] = await db.select().from(schema.riders).where(eq(schema.riders.userId, uid));
      if (!exists) {
        const [prof] = await db.insert(schema.riders).values({
          userId: uid,
          vehicle: t.vehicle,
          skills: t.skills,
          skillClass: t.skillClass,
          color: t.color,
          phone: "+1416555" + String(1000 + techIds.length).padStart(4, "0"),
          status: t.status,
          lat: t.lat,
          lng: t.lng,
          locationUpdatedAt: new Date(),
          completedJobs: Math.floor(Math.random() * 200 + 50),
        }).returning();
        techIds.push(prof.id);
      }
    }
  }

  // clients
  const clientIds: string[] = [];
  for (const c of CLIENTS) {
    const uid = await ensureUser(c.name, c.email, "customer123", "customer", c.phone);
    if (uid) clientIds.push(uid);
  }

  // demo work orders in various states
  const svc = await db.select().from(schema.services);
  const findSvc = (cat: string) => svc.find((s) => s.category === cat) ?? svc[0];
  const tmplFor = (cat: string) => templates.find((t) => t.category === cat);
  const now = Date.now();
  const h = 3600_000;

  const WO = [
    { client: 0, cat: "HVAC", title: "No cooling — upstairs AC", addr: "240 Queen St W, Toronto", lat: 43.6500, lng: -79.3900, status: "enroute", tech: 0, priority: "high", eta: 8 },
    { client: 1, cat: "Plumbing", title: "Kitchen sink leak", addr: "88 Yorkville Ave, Toronto", lat: 43.6709, lng: -79.3933, status: "in_progress", tech: 1, priority: "normal" },
    { client: 2, cat: "Install", title: "New furnace install", addr: "15 King St E, Toronto", lat: 43.6489, lng: -79.3776, status: "assigned", tech: 2, priority: "normal" },
    { client: 0, cat: "Logistics", title: "Parts delivery to site B", addr: "601 Bay St, Toronto", lat: 43.6560, lng: -79.3830, status: "pending", tech: null, priority: "low" },
    { client: 1, cat: "Emergency", title: "Burst pipe — water damage", addr: "120 Adelaide St W, Toronto", lat: 43.6495, lng: -79.3840, status: "pending", tech: null, priority: "urgent" },
    { client: 2, cat: "HVAC", title: "Annual maintenance tune-up", addr: "200 Front St W, Toronto", lat: 43.6440, lng: -79.3870, status: "completed", tech: 5, priority: "normal" },
    { client: 0, cat: "Electrical", title: "Panel upgrade quote", addr: "44 Gerrard St E, Toronto", lat: 43.6595, lng: -79.3790, status: "completed", tech: 4, priority: "normal" },
  ];

  for (const w of WO) {
    const s = findSvc(w.cat);
    const tmpl = tmplFor(w.cat);
    await db.insert(schema.bookings).values({
      customerId: clientIds[w.client],
      serviceId: s.id,
      templateId: tmpl?.id ?? null,
      riderId: w.tech !== null ? techIds[w.tech] : null,
      title: w.title,
      priority: w.priority,
      status: w.status,
      scheduledAt: new Date(now + (Math.random() * 6 - 1) * h),
      address: w.addr,
      lat: w.lat,
      lng: w.lng,
      notes: "",
      price: s.basePrice,
      paymentStatus: w.status === "completed" ? "paid" : "unpaid",
      customerPhone: CLIENTS[w.client].phone,
      etaMins: w.eta ?? null,
    });
  }

  return { ok: true };
}

async function ensureUser(
  name: string,
  email: string,
  password: string,
  role: string,
  phone: string,
): Promise<string | null> {
  const [existing] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  if (existing) return existing.id;
  try {
    await auth.api.signUpEmail({
      body: { name, email, password, role, phone } as any,
    });
  } catch (e) {
    console.error("signup failed for", email, e);
  }
  const [u] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  if (u) {
    await db.update(schema.user).set({ role, phone }).where(eq(schema.user.id, u.id));
    // Roles are resolved from memberships now, so a seeded user without one
    // would sign in with no role at all.
    await attachMembership({
      userId: u.id,
      companyId: u.companyId ?? "default",
      role,
      status: "active",
    });
    return u.id;
  }
  return null;
}
