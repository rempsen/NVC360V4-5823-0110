# NVC360 Infrastructure

Everything in this directory is new as of August 2026 and exists to answer the
gaps Joel raised in his architecture review: no CI/CD, no staging, no IaC, and
no portable definition of how the app runs.

## What's here

```
infra/terraform/staging/     Staging environment, AWS account 293174400261, us-east-2
```

The container definition itself lives at the repo root (`Dockerfile`,
`docker-compose.yml`) because Docker needs the build context there.

## AWS account

| | |
|---|---|
| Project | NVC360 App v5 |
| Account | 293174400261 (member of org o-6bve4kb61f, management account 759046793211) |
| Region | us-east-2 (Ohio) — the same region Turso already hosts our database in |
| Plan | Paid account as of 2026-08-21. The upgrade removed the hard spend limit; AWS Budgets now only sends email, it does not stop spend. |
| Budget guard | `nvc360-monthly-cost-guard`, $40/month, alerts to dan@nvc360.com at 50% and 90% actual, 100% forecast |
| Terraform state | `s3://nvc360-tfstate-293174400261/staging/terraform.tfstate`, versioned + encrypted, S3 native locking |

The $100 of promotional credits expiring Feb 21 2027 predate the paid upgrade.
**Whether they survived the plan change has not been verified** — do not budget
against them until someone confirms it in the Billing console.

Note the $40 budget is a deliberate tripwire, not a ceiling, and it *will* be
breached: when the RDS free tier ends in August 2027 the steady-state footprint
is roughly $42/month.

## Design decisions worth knowing

**ECS Fargate + ALB, not App Runner.** App Runner is permitted in this account
(see the SCP section below) and was the original choice on cost — it bundles TLS,
hostname and health checks where an ALB costs ~$16/month sitting idle. It was
rejected anyway, on a hard technical limit: **App Runner injects whole secrets
only.** It cannot select an individual key out of a JSON secret. Our runtime
config is a single JSON blob of ~19 keys, so App Runner would mean either ~19
separate secrets at $0.40/month each (~$7.60, roughly half the ALB saving) or an
application change to read a config blob at boot. Paying $16 to avoid rewriting
config loading and to keep one secret instead of nineteen is the better trade.
The image is identical either way, so this stays reversible.

**Default VPC, no NAT gateway.** A NAT gateway is ~$32/month, more than the rest
of this footprint combined. Staging does not justify it. Isolation comes from
security groups and `publicly_accessible = false` on the database.

**Exactly one instance — correctness, not cost.** `packages/web/src/server.ts`
registers **seven** `setInterval` sweeps, and `services/scheduler.ts` and
`services/retention.ts` add more. They are correct at exactly one instance.
Running two would double-fire the scheduler, automations and the delay watcher.
`desired_count = 1` is pinned and every enforcement point in `service.tf` says
why. This constraint lifts only when the background-task workstream moves those
sweeps out of the web process.

**S3 for staging uploads.** Production storage is **Tigris**, not AWS S3
(`S3_ENDPOINT=https://t3.storage.dev`). Because the app talks to storage over the
plain S3 wire protocol via `Bun.S3Client`, pointing staging at real S3 is a
credential swap with zero code change — set `S3_BUCKET`, leave `S3_ENDPOINT`
unset. Do not reintroduce the AWS SDK server-side: it pulled ~570 modules /
1.4 MB and OOM'd the bundler, which is why `Bun.S3Client` is used at all.

**One secret, not thirty.** Secrets Manager bills per secret per month and this
app has ~30 config keys, so runtime config is a single JSON blob. Terraform
creates the secret but never writes real values into it — those go in out of
band so they never land in Terraform state. `nvc360-staging/app-config` currently
holds a **placeholder value only**.

**GitHub OIDC, no access keys in CI.** The deploy role trusts a single
`repo:<owner>/<repo>:ref:refs/heads/main` subject, so no long-lived AWS key is
stored in GitHub. The OIDC provider was created by hand and then imported into
Terraform state, so `terraform plan` is clean.

> ⚠️ **Known defect:** `var.github_repo` still defaults to
> `rempsen/NVC360V4-7630`, which is not this repository. The real remote is
> `rempsen/NVC360V4-5823-0110`. Until that default is corrected **and applied**,
> the deploy role's trust condition will refuse the real repository's OIDC token
> and CD will fail at the credentials step. The same stale string is also a
> `Repo` tag in `versions.tf`. This has never been exercised because
> `create_service = false` and no deploy has run.

## Cost gates

| Variable | Creates | Cost | Current |
|---|---|---|---|
| `create_database` | RDS Postgres db.t4g.micro, 20 GB gp3, 7-day backups | Free for 12 months, then ~$15/month | **`true`** — live since 2026-08-21 |
| `create_service` | ECS Fargate service 0.25 vCPU / 0.5 GB + ALB, 1 task | ~$25/month (ALB ~$16 + task ~$9) | `false` |

`create_service` also requires an image to already exist in ECR. Order of
operations:

1. `terraform apply` with `create_service = false` — foundation only.
2. CI builds and pushes the image to ECR (assumes the OIDC deploy role).
3. Set `create_service = true` and apply again.

Do not flip `create_service` without Dan's explicit approval — nothing above a
few dollars a month gets created without telling him first.

## Usage

```bash
cd infra/terraform/staging
terraform init
terraform plan            # always read this before applying
terraform apply
```

Credentials: the sandbox uses an IAM user access key kept outside the repo at
`~/.nvc360-secrets/aws.env` (chmod 600). Source it and export
`AWS_DEFAULT_REGION=us-east-2`.

## Resolved: the org SCP that blocked the first apply

**This blocker is gone.** It is documented here because it shaped the design and
because the reasoning is worth keeping.

The first `terraform apply` created 13 of 14 resources and then failed:

```
Error: creating IAM OIDC Provider: AccessDenied
  ... with an explicit deny in a service control policy:
  arn:aws:organizations::759046793211:policy/o-6bve4kb61f/service_control_policy/p-2vlxg9hb
```

Account 293174400261 was an AWS "Project" account, and the organization applied
a Service Control Policy that overrode even `AdministratorAccess`. It denied
App Runner, Lightsail and `iam:CreateOpenIDConnectProvider`, while allowing ECS,
Fargate, ALB, RDS, EC2, Lambda, Secrets Manager, CloudWatch Logs, ECR, S3 and
IAM roles.

**Dan's paid-account upgrade on 2026-08-21 removed it as a side effect.**
Verified by live probe rather than by reading documentation:

| Probe | Result |
|---|---|
| `iam:CreateOpenIDConnectProvider` | **succeeded** — the provider now exists and is imported into Terraform state |
| App Runner `create-auto-scaling-configuration` | **succeeded** — probe resource named `scp-probe`, since deleted |

Two footnotes for anyone who revisits this:

- **The App Runner decision did not reverse when the block lifted.** App Runner
  became available and was still rejected, for the whole-secrets reason in the
  design section above. Availability was never the deciding factor in the end.
- **SCPs are editable only from the management account** (759046793211,
  dan@nvc360.com). Attempting to edit one from inside member account
  293174400261 returns a permissions error, which is expected behaviour and not
  a sign of a broken account. Moot now that the policy is gone.

## Live resources

Eight tagged resources. **No ECS cluster exists and nothing is running.**

| Resource | Notes |
|---|---|
| RDS `nvc360-staging-postgres` | Postgres 16.13, db.t4g.micro, 20 GB gp3, encrypted, not publicly accessible, 7-day backups, `available` |
| Secret `nvc360-staging/postgres-url` | Live. Machine-generated password, never typed by a human |
| Secret `nvc360-staging/app-config` | Placeholder value only — still needs populating |
| ECR `nvc360-staging-web` | Empty until the first CI push |
| S3 `nvc360-staging-uploads-293174400261` | Staging uploads |
| S3 `nvc360-tfstate-293174400261` | Terraform state, versioned, native locking |
| CloudWatch `/nvc360/nvc360-staging/app` | Log group |
| IAM role `nvc360-staging-github-deploy` + GitHub OIDC provider | CD identity — see the `github_repo` defect above |

## Not done yet

- **Correct `var.github_repo`** to `rempsen/NVC360V4-5823-0110` and apply, or CD
  cannot authenticate. Highest-priority item in this directory.
- Populating `nvc360-staging/app-config` with real staging values — needs
  test-mode Stripe, Twilio and Resend credentials.
- Turning on staging compute (`create_service = true` plus a first image push,
  ~$25/month). Needs approval.
- ACM certificate and a `staging.nvc360.com` hostname before any real data goes
  in.
- Rotating or retiring the long-lived `nvc360-agent` access key now that OIDC
  works.
- Monitoring and alerting, including uptime checks.
- Anything in production. Nothing here touches the live environment.

## Verification notes

The container image has **never been built locally** — Docker cannot be
installed in the development sandbox. The only proof the `Dockerfile` works is
GitHub Actions: CI run #72 on commit `b604ba3` passed both the `verify` job and
`Container image builds` (build plus a boot smoke test asserting the container
binds its port). Never claim the image builds without a green CI run behind it.
