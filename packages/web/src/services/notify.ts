import * as schema from "../api/database/schema";
import { eq } from "drizzle-orm";
import { tdb } from "../api/database/tenant";
import { sendEmail, emailTemplates, loadEmailBrand, resolveFromAddress } from "./email";
import { buildSingleEventIcs } from "./ics";
import { sendPush } from "./push";
import { companyTimeZone } from "./company-tz";

type EventType =
  | "booking_confirmed"
  | "assigned"
  | "enroute"
  | "arrived"
  | "completed"
  | "reminder"
  | "receipt";

interface NotifyArgs {
  companyId: string;
  type: EventType;
  userId: string;
  bookingId: string;
  title: string;
  body: string;
  emailKind?: keyof typeof emailTemplates;
  email?: string;
  emailData?: Parameters<(typeof emailTemplates)["bookingConfirmed"]>[0];
}

/** Create an in-app notification and optionally fire an email. */
export async function notify(args: NotifyArgs) {
  await tdb(args.companyId).insert(schema.notifications, {
    userId: args.userId,
    bookingId: args.bookingId,
    type: args.type,
    title: args.title,
    body: args.body,
  });

  // Mirror the in-app notification to the user's devices. Fire-and-forget —
  // a push failure must never break the notify() flow.
  sendPush(args.userId, args.title, args.body, {
    type: args.type,
    bookingId: args.bookingId,
  }).catch(() => {});

  if (args.emailKind && args.email && args.emailData) {
    // Brand every outbound email with this tenant's logo + name.
    const [brand, identity, tz] = await Promise.all([
      loadEmailBrand(args.companyId),
      resolveFromAddress(args.companyId),
      companyTimeZone(args.companyId),
    ]);
    // Appointment times render on the tenant's clock, not the server's UTC.
    const tpl = emailTemplates[args.emailKind](args.emailData, brand, tz);
    // Attach a calendar invite for appointment confirmations & reminders.
    let attachments;
    if (args.emailKind === "bookingConfirmed" || args.emailKind === "reminder") {
      try {
        const d = args.emailData;
        const start = new Date(d.scheduledAt);
        const ics = buildSingleEventIcs({
          uid: `booking-${d.bookingId}@nvc360`,
          title: `${d.serviceName} appointment`,
          // White-label: the invite a customer files in their calendar names
          // THEIR contractor, not the platform.
          description: `${brand.company} service appointment${d.riderName ? ` with ${d.riderName}` : ""}.`,
          location: d.address,
          start,
          end: new Date(start.getTime() + 60 * 60_000),
          status: "CONFIRMED",
          alarmMinutesBefore: 60,
        });
        attachments = [
          { filename: "appointment.ics", content: ics, contentType: "text/calendar" },
        ];
      } catch (e) {
        console.error("ics build failed", e);
      }
    }
    // fire and forget — pass tenant's from/replyTo if configured
    sendEmail({
      to: args.email,
      subject: tpl.subject,
      html: tpl.html,
      attachments,
      ...(identity.from ? { from: identity.from } : {}),
      ...(identity.replyTo ? { replyTo: identity.replyTo } : {}),
    }).catch((e) => console.error("notify email failed", e));
  }
}

/** Build the email data payload from a booking id (tenant-scoped). */
export async function buildEmailData(companyId: string, bookingId: string) {
  const t = tdb(companyId);
  const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, bookingId));
  if (!b) return null;
  const svc = await t.selectOne(schema.services, eq(schema.services.id, b.serviceId));
  // `user` is a global (auth-owned) table; scope the lookup to this booking's
  // customer id, which we already proved belongs to the tenant via the booking.
  const cust = await t.selectOne(schema.user, eq(schema.user.id, b.customerId));
  let riderName: string | undefined;
  if (b.riderId) {
    const r = await t.selectOne(schema.riders, eq(schema.riders.id, b.riderId));
    if (r) {
      const ru = await t.selectOne(schema.user, eq(schema.user.id, r.userId));
      riderName = ru?.name;
    }
  }
  return {
    booking: b,
    email: cust?.email ?? "",
    customerName: cust?.name ?? "there",
    emailData: {
      customerName: cust?.name ?? "there",
      serviceName: svc?.name ?? "service",
      scheduledAt: b.scheduledAt,
      address: b.address,
      price: b.price,
      bookingId: b.id,
      riderName,
    },
  };
}
