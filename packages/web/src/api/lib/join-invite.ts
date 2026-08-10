/**
 * The "join a second company" invite.
 *
 * Distinct from the existing technician invite (routes/invites.ts), which
 * creates a brand-new login and asks the person to set a password. This one is
 * for someone who ALREADY has an NVC360 login and is being added to another
 * company's roster. There is no password step at all — they accept with the
 * credentials they already have, which is exactly what keeps the second company
 * from gaining control of their existing account.
 */
import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { sendEmail, loadEmailBrand, resolveLogo } from "../../services/email";

const SITE = (process.env.WEBSITE_URL || "http://localhost:4200").replace(/\/$/, "");

async function companyDisplayName(companyId: string): Promise<string> {
  const [co] = await db
    .select()
    .from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, companyId));
  if (co?.name) return co.name;
  const [reg] = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId));
  return reg?.name || "NVC360";
}

export async function sendJoinCompanyInvite(a: {
  email: string;
  name?: string | null;
  companyId: string;
  membershipId: string;
}) {
  const company = await companyDisplayName(a.companyId);
  const brand = await loadEmailBrand(a.companyId);
  const accent = brand.brandColor || "#06B6D4";
  const logoSrc = resolveLogo(brand.logoUrl);
  const link = `${SITE}/join-company/${a.membershipId}`;

  const logoBlock = logoSrc
    ? `<img src="${logoSrc}" alt="${company}" style="height:40px;max-width:220px;display:block;margin:0 auto 8px"/>
       <div style="color:#fff;font-size:15px;font-weight:700;text-align:center">${company}</div>`
    : `<div style="color:#fff;font-size:18px;font-weight:800;text-align:center">${company}</div>`;

  await sendEmail({
    to: a.email,
    subject: `${company} would like to add you to their team`,
    html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <div style="background:linear-gradient(135deg,${accent},${accent}cc);border-radius:16px 16px 0 0;padding:22px 24px">
        ${logoBlock}
      </div>
      <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;padding:24px">
        <h2 style="margin:0 0 10px;color:#0f172a">You've been added to ${company}</h2>
        <p style="font-size:14px;color:#334155;line-height:1.6">
          Hi${a.name ? " " + a.name : ""}, <b>${company}</b> would like to add you to their team on NVC360.
        </p>
        <p style="font-size:14px;color:#334155;line-height:1.6">
          You already have an NVC360 account, so there's nothing new to set up —
          <b>keep using your existing email and password</b>. Once you accept,
          you'll be able to switch between your companies from the menu, and
          you'll only ever see one company's work at a time.
        </p>
        <a href="${link}" style="display:inline-block;margin-top:16px;background:${accent};color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">Accept &amp; join ${company}</a>
        <p style="margin-top:18px;font-size:12px;color:#94a3b8">
          If you weren't expecting this, you can ignore this email — nothing changes
          about your existing account and ${company} cannot see your other work
          unless you accept.
        </p>
        <p style="margin-top:10px;font-size:12px;color:#94a3b8">If the button doesn't work, paste this link: ${link}</p>
      </div>
    </div>`,
  });
}
