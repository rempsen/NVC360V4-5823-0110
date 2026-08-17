# Fix NVC360 email — the one DNS record to change

**Domain:** nvc360.com
**DNS host:** GoDaddy (your nameservers are `pdns13.domaincontrol.com` / `pdns14.domaincontrol.com`)
**Time needed:** about 3 minutes, plus waiting for DNS
**Verified live:** 2026-08-16, against both Resend and public DNS

---

## What's wrong

There should be **exactly one** DKIM record for nvc360.com. Right now there are **two**, and
neither is the right one.

Here's what's actually published at `resend._domainkey.nvc360.com` today:

| # | Key starts with | What it is |
|---|---|---|
| 1 | `p=MIGfMA0...DKizE4vDzb3p/jSRf...` | **BMD Materials' key.** Copied from the bmdmaterials.com setup by mistake. |
| 2 | `p=MIGfMA0...DP8EIHJL84/YnKt1TML...` | An old, stale NVC360 key. No longer valid. |

And here's the key Resend is actually looking for — it isn't published anywhere:

`p=MIGfMA0...DNKnH45Jab/JtgwzMOni3Y7sjD...`

Because Resend can't find its key, it has marked nvc360.com as **failed**, and every email
from the NVC360 tenant is rejected. (BMD Materials is unaffected and sending normally.)

Your SPF and MX records are both **correct and verified** — don't touch those.

---

## What to change

### Step 1 — Delete both existing DKIM records

In GoDaddy, go to **My Products → nvc360.com → DNS → Manage DNS**.

Find the TXT records with **Name** `resend._domainkey` — there will be two of them.
**Delete both.**

> Only delete records whose name is exactly `resend._domainkey`. Leave every other record
> alone, especially anything named `send` or `@`.

### Step 2 — Add one new TXT record

Click **Add New Record** and enter:

| Field | Value |
|---|---|
| **Type** | TXT |
| **Name** | `resend._domainkey` |
| **Value** | see the long value below — copy it exactly |
| **TTL** | 1 Hour (or leave the default) |

**Value to paste:**

```
p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDNKnH45Jab/JtgwzMOni3Y7sjDZmpqkVsLYA8X8NfQD6sZR7rIgqKFh8Iw7RVfpvJ+g0u+niYFhNnVjI48yEjhXJcm55XR0fCkg8Vvh3pNewi93q7YqBnnjmmQnKwDfD6amhng1+B+QZVFXcprWXdtS6EIUyHNgblVaLIog1eD1QIDAQAB
```

Click **Save**.

**Three things that break this if you get them wrong:**

- Paste the value as **one unbroken line** — no line breaks, no spaces. It's long; make sure
  nothing got cut off. It must start with `p=MIGf` and end with `IDAQAB`.
- The name is `resend._domainkey`, **not** `resend._domainkey.nvc360.com`. GoDaddy adds the
  domain for you. If you type the full thing you'll end up with
  `resend._domainkey.nvc360.com.nvc360.com` and it won't work.
- Don't wrap the value in quotes. GoDaddy handles that itself.

### Step 3 — Leave these exactly as they are

These are already correct and verified. Changing them will break sending:

| Type | Name | Value |
|---|---|---|
| TXT | `send` | `v=spf1 include:amazonses.com ~all` |
| MX | `send` | `feedback-smtp.eu-west-1.amazonses.com` (priority 10) |

---

## What happens next

1. **DNS spreads** — usually 15 minutes to an hour, occasionally up to a few hours.
2. **The platform re-checks on its own.** It now re-checks every domain every six hours,
   including ones already marked verified or failed. There is no button to press.
3. **Email starts flowing again** for the NVC360 tenant the moment Resend flips the domain
   to verified.

If you want to confirm it early instead of waiting, open **Settings → Email Domains** in the
admin platform and use the re-check option there.

---

## How to tell it worked

In the admin platform, **Settings → Email Domains** should show nvc360.com as **Verified**
with all three records green.

Or, to check the DNS itself, visit:

```
https://dns.google/resolve?name=resend._domainkey.nvc360.com&type=TXT
```

You want to see **one** entry, and its value should start with `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDNKnH45Jab`.

If you still see two entries, or one starting with `DKizE4` or `DP8EIHJL`, one of the old
records is still there — go back and delete it.

---

## Related, and worth knowing

This domain had been broken since roughly early July and nothing flagged it. The platform
only re-checked domains that were still *waiting* on DNS — once a domain reached "verified"
it was never looked at again, so a domain that broke afterwards stayed marked verified
forever. That's fixed: verified and failed domains are now re-checked every six hours, and a
domain falling out of verified writes a loud error to the logs so it gets noticed.
