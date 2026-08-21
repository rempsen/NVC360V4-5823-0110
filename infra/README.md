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
| Budget guard | `nvc360-monthly-cost-guard`, $40/month, alerts to dan@nvc360.com at 50%, 90%, and 100% forecast |
| Terraform state | `s3://nvc360-tfstate-293174400261/staging/terraform.tfstate`, versioned + encrypted, S3 native locking |

The account is on the free plan with $100 of credits expiring Feb 2027, which
is why every expensive resource in this stack is behind an explicit flag.

## Design decisions worth knowing

**App Runner, not ECS + ALB.** The app is one stateless container on `$PORT` —
App Runner's exact shape. An ALB costs ~$16/month sitting idle before any
compute; App Runner bundles TLS, hostname, health checks and scale-to-one for
about a third of that. Nothing is one-way: the image is identical, so moving to
ECS Fargate later is a Terraform change, not an application change.

**Default VPC, no NAT gateway.** A NAT gateway is ~$32/month, more than the rest
of this footprint combined. Staging does not justify it. Isolation comes from
security groups and `publicly_accessible = false` on the database.

**Max one instance, deliberately.** Six `setInterval` sweeps (presence,
scheduler, automation, delay-watch, email-domain poll, DB ping) run inside the
web process. They are correct at exactly one instance. Raising `max_size`
before the background-task workstream lands would double-fire the scheduler,
automations and the delay watcher. The autoscaling config pins min = max = 1
and the comment in `service.tf` says why.

**S3 for staging uploads instead of Tigris.** The app already talks to storage
through the plain S3 wire protocol via `Bun.S3Client`, so this is an env-var
change: set `S3_BUCKET`, leave `S3_ENDPOINT` unset. Do not reintroduce the AWS
SDK server-side — it pulled ~570 modules / 1.4 MB and OOM'd the bundler, which
is the reason `Bun.S3Client` is used in the first place.

**One secret, not thirty.** Secrets Manager bills per secret per month and this
app has ~30 config keys, so runtime config is a single JSON blob. Terraform
creates the secret but never writes real values into it — those go in out of
band so they never land in Terraform state.

**GitHub OIDC, no access keys in CI.** The deploy role trusts only
`repo:rempsen/NVC360V4-7630:ref:refs/heads/main`. No long-lived AWS key ever
gets stored in GitHub secrets.

## Cost gates

Both default to `false`. A fresh `terraform apply` creates only near-zero-cost
resources (ECR repo, S3 bucket, one secret, log group, IAM roles).

| Variable | Creates | Cost |
|---|---|---|
| `create_database` | RDS Postgres db.t4g.micro, 20 GB gp3, 7-day backups | Free for 12 months on this account, then ~$15/month |
| `create_service` | App Runner service, 0.25 vCPU / 0.5 GB, 1 instance | ~$5–15/month |

`create_service` also requires an image to already exist in ECR — App Runner
refuses to create otherwise. Order of operations:

1. `terraform apply` with both gates off — foundation only.
2. CI builds and pushes the image to ECR (assumes the OIDC deploy role).
3. Set `create_service = true` and apply again.

## Usage

```bash
cd infra/terraform/staging
terraform init
terraform plan            # always read this before applying
terraform apply
```

Credentials: the sandbox uses an IAM user access key kept outside the repo at
`~/.nvc360-secrets/aws.env`. It is deliberately not in the repo — note that
`.gitignore` covers `.env` but did not cover `.env.aws`, which is now fixed.

## Blocker found on first apply: an org Service Control Policy

The first `terraform apply` created 13 of 14 resources and then failed:

```
Error: creating IAM OIDC Provider: AccessDenied
  ... with an explicit deny in a service control policy:
  arn:aws:organizations::759046793211:policy/o-6bve4kb61f/service_control_policy/p-2vlxg9hb
```

Account 293174400261 is an **AWS "Project" account**, not an ordinary member
account. The organization applies an SCP that overrides even
`AdministratorAccess`. Probing the SCP from inside the account gave this map:

| Service | Status |
|---|---|
| App Runner | **DENIED by SCP** |
| Lightsail | **DENIED by SCP** |
| `iam:CreateOpenIDConnectProvider` | **DENIED by SCP** |
| ECS / Fargate | allowed |
| ELBv2 (ALB) | allowed |
| RDS | allowed |
| EC2, Lambda, EKS, Amplify, CodeBuild | allowed |
| Secrets Manager, CloudWatch Logs, ECR, S3 | allowed |
| IAM roles and policies | allowed |

Two consequences:

1. **`service.tf` cannot be applied as written.** App Runner was chosen for cost
   (no ALB), and it is unavailable in this account. The compute layer has to be
   ECS Fargate + ALB instead, which adds roughly $16/month for the load
   balancer — real money against $100 of credits.
2. **GitHub OIDC cannot be created here.** Without it, CI has to authenticate
   with a long-lived IAM access key stored in GitHub secrets, which is the
   thing OIDC exists to avoid.

Both are fixable from the management account (759046793211) by loosening or
detaching that SCP for this account, or by moving the workload to an ordinary
member account instead of a Project account. That decision is pending — see the
chat thread. Until then the foundation resources below are live and correct, and
nothing is running.

## Not done yet

- CD workflow (build → push → migrate → deploy → smoke → promote). The OIDC
  role and ECR repo it needs now exist; the workflow itself does not.
- Populating the staging config secret. Needs a staging database URL, which is
  blocked on the Turso account-ownership question, plus test-mode Stripe,
  Twilio and Resend credentials.
- Monitoring and alerting.
- Anything in production. Nothing here touches the live environment.
