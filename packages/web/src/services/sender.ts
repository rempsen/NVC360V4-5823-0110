/**
 * The one place that decides what a tenant's outbound mail may claim to be from.
 *
 * The rule (stated at the top of email-domains.ts): a tenant's
 * emailFromAddress is only honoured once that domain has a
 * tenant_email_domains row with status "verified". dispatch.ts enforced it;
 * email.ts's resolveFromAddress() did not, which left the Stripe receipt and
 * the password-reset email able to send as an unverified — or simply
 * unowned — domain. Both senders now call this.
 *
 * Pure on purpose: the DB read (verifiedDomainsForCompany) stays at the call
 * site so the decision itself is testable without credentials.
 */

export interface SenderConfig {
  emailFromName?: string | null;
  emailFromAddress?: string | null;
  emailReplyTo?: string | null;
}

export interface SenderIdentity {
  /** RFC 5322 "Name <addr>", or undefined to let the platform default apply. */
  from?: string;
  replyTo?: string;
}

/**
 * @param verifiedDomains lowercase domains this company has verified in Resend.
 *   Exact match only — a subdomain is a separate Resend domain, and suffix
 *   matching would let notbmdmaterials.com ride on bmdmaterials.com.
 */
export function pickSender(cfg: SenderConfig, verifiedDomains: string[]): SenderIdentity {
  // Reply-to is independent of the From guard: it is a header the recipient's
  // client honours, not an identity we assert, and several tenants set only
  // this so office replies land in the right inbox.
  const replyTo = cfg.emailReplyTo?.trim() || undefined;

  const addr = cfg.emailFromAddress?.trim() || "";
  if (!addr) return { replyTo };

  const parts = addr.split("@");
  if (parts.length !== 2) return { replyTo };
  const domain = (parts[1] || "").trim().toLowerCase();
  if (!domain || !parts[0]?.trim()) return { replyTo };

  const allowed = new Set(verifiedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean));
  if (!allowed.has(domain)) return { replyTo };

  const displayName = (cfg.emailFromName || "").trim() || domain;
  return { from: `${displayName} <${addr}>`, replyTo };
}

/** The domain part of "Name <user@host>" or a bare "user@host", lowercased. */
export function senderDomain(addr: string | undefined | null): string {
  const m = /<([^>]+)>\s*$/.exec((addr || "").trim());
  const bare = (m ? m[1] : addr || "").trim();
  return (bare.split("@")[1] || "").trim().toLowerCase();
}

/**
 * When Resend rejects a send with "domain is not verified", who do we retry as?
 *
 * The old code retried with the global EMAIL_FROM whenever it differed from the
 * sender STRING. Observed live: a tenant sending as "NVC360
 * <contact@nvc360.com>" with EMAIL_FROM="contact@nvc360.com" retried on the
 * very same broken domain — a guaranteed second failure and a wasted API call.
 * Compare domains, not strings, and fall through to the shared test sender.
 *
 * Returns undefined when there is nowhere better to go.
 */
export function pickRetrySender(
  sender: string,
  envFrom: string,
  fallback: string,
): string | undefined {
  const bad = senderDomain(sender);
  for (const candidate of [envFrom, fallback]) {
    if (!candidate) continue;
    if (candidate === sender) continue;
    if (bad && senderDomain(candidate) === bad) continue;
    return candidate;
  }
  return undefined;
}
