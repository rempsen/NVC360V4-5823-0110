/**
 * Who a tenant's mail is allowed to claim to be from.
 *
 * services/email-domains.ts states the contract at the top of the file: "A
 * tenant's emailFromAddress is only honored once its domain row is status ===
 * 'verified' — see services/email.ts + dispatch.ts send guard."
 *
 * dispatch.ts really does apply that guard. services/email.ts's
 * resolveFromAddress() did NOT — it only checked that the address had a
 * non-empty domain part. That path is reachable on the Stripe receipt email
 * (services/notify.ts) and the password-reset email (api/auth.ts), so a tenant
 * who typed a domain they have not verified — or do not own — became the
 * envelope From on real outbound mail. Live proof on the current database:
 * allco-electrical has careers@allcoelectrical.com set with no domain row at all.
 *
 * The guard is now one pure function shared by both senders, and this pins it.
 */
import { describe, it, expect } from "bun:test";

process.env.DATABASE_URL = "postgresql://placeholder:placeholder@localhost:5432/placeholder"; // never queried by this pure-logic test

const { pickSender } = await import("../sender");

const VERIFIED = ["bmdmaterials.com", "nvc360.com"];

describe("pickSender only honours a verified sending domain", () => {
  it("uses the tenant's own address when their domain is verified", () => {
    expect(
      pickSender(
        { emailFromName: "BMD Materials", emailFromAddress: "contact@bmdmaterials.com" },
        VERIFIED,
      ).from,
    ).toBe("BMD Materials <contact@bmdmaterials.com>");
  });

  it("refuses an address whose domain has no verified row", () => {
    const s = pickSender(
      { emailFromName: "Allco Electrical", emailFromAddress: "careers@allcoelectrical.com" },
      VERIFIED,
    );
    expect(s.from).toBeUndefined();
  });

  it("refuses when the tenant has verified nothing at all", () => {
    expect(
      pickSender({ emailFromName: "BMD", emailFromAddress: "contact@bmdmaterials.com" }, []).from,
    ).toBeUndefined();
  });

  it("matches the domain case-insensitively and ignores whitespace", () => {
    expect(
      pickSender(
        { emailFromName: " BMD Materials ", emailFromAddress: "  Contact@BMDMaterials.COM " },
        VERIFIED,
      ).from,
    ).toBe("BMD Materials <Contact@BMDMaterials.COM>");
  });

  it("does not let a lookalike domain ride on a verified suffix", () => {
    // notbmdmaterials.com ends with bmdmaterials.com as a string but is a
    // different domain, and a subdomain is a separate Resend domain too.
    expect(
      pickSender({ emailFromAddress: "hi@notbmdmaterials.com" }, VERIFIED).from,
    ).toBeUndefined();
    expect(
      pickSender({ emailFromAddress: "hi@mail.bmdmaterials.com" }, VERIFIED).from,
    ).toBeUndefined();
  });

  it("falls back to the domain as the display name when no name is set", () => {
    expect(pickSender({ emailFromAddress: "contact@nvc360.com" }, VERIFIED).from).toBe(
      "nvc360.com <contact@nvc360.com>",
    );
  });

  it("returns nothing for a blank or malformed address", () => {
    expect(pickSender({ emailFromAddress: "" }, VERIFIED).from).toBeUndefined();
    expect(pickSender({ emailFromAddress: "   " }, VERIFIED).from).toBeUndefined();
    expect(pickSender({ emailFromAddress: "no-at-sign" }, VERIFIED).from).toBeUndefined();
    expect(pickSender({ emailFromAddress: "trailing@" }, VERIFIED).from).toBeUndefined();
  });

  it("keeps the reply-to even when the from-address is refused", () => {
    // precon-builders on the live DB is exactly this shape: a reply-to set with
    // no from-address. Replies must still reach the office.
    const s = pickSender(
      { emailFromAddress: "careers@allcoelectrical.com", emailReplyTo: "office@allco.test" },
      VERIFIED,
    );
    expect(s.from).toBeUndefined();
    expect(s.replyTo).toBe("office@allco.test");
  });

  it("omits an empty reply-to rather than sending an empty header", () => {
    expect(pickSender({ emailFromAddress: "", emailReplyTo: "  " }, VERIFIED).replyTo).toBeUndefined();
  });
});

const { pickRetrySender, senderDomain } = await import("../sender");

const ENV = "contact@nvc360.com";
const SHARED = "NVC360 <onboarding@resend.dev>";

describe("pickRetrySender — where a rejected send goes next", () => {
  it("reads the domain out of both header shapes", () => {
    expect(senderDomain("BMD Materials <contact@BMDMaterials.com>")).toBe("bmdmaterials.com");
    expect(senderDomain("contact@nvc360.com")).toBe("nvc360.com");
    expect(senderDomain("")).toBe("");
  });

  it("never retries on the domain that just failed", () => {
    // Observed live: sender nvc360.com, EMAIL_FROM also nvc360.com. Retrying
    // there is a guaranteed second failure.
    expect(pickRetrySender("NVC360 <contact@nvc360.com>", ENV, SHARED)).toBe(SHARED);
  });

  it("prefers the platform's own address over Resend's shared test sender", () => {
    // A tenant's broken domain should not drag customers onto resend.dev if we
    // have a real verified platform address to use.
    expect(pickRetrySender("Allco <careers@allcoelectrical.com>", ENV, SHARED)).toBe(ENV);
  });

  it("gives up rather than retrying as itself", () => {
    expect(pickRetrySender(SHARED, "", SHARED)).toBeUndefined();
  });
});
