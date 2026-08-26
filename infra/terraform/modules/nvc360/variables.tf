variable "region" {
  description = "AWS region. us-east-2 matches the project account default and the region Turso already hosts our database in, so cross-region latency does not change during the Phase D migration."
  type        = string
  default     = "us-east-2"
}

variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
  default     = "nvc360-staging"
}

variable "github_repo" {
  description = "owner/repo allowed to assume the CI deploy role via OIDC. Human-readable only — the trust policy matches on the stable IDs below, not this string, so renaming the repo again does not require an apply here (only updating this description/tag)."
  type        = string
  default     = "rempsen/NVC360V4-5823-0110"
}

variable "github_repository_id" {
  description = <<-EOT
    Numeric GitHub repository ID for the OIDC trust policy. GitHub's `sub`
    claim appends "@<repository_id>" to the repo name once a repo has been
    renamed (this one was, from NVC360V4-7630), so matching on the plain
    "owner/repo" string in `sub` silently stops working. Matching on
    repository_id/repository_owner_id instead is immune to future renames.
    Found via CloudTrail on the actual token presented by a failed
    AssumeRoleWithWebIdentity call; also readable from
    `gh api repos/rempsen/NVC360V4-5823-0110 --jq .id`.
  EOT
  type        = string
  default     = "1330189422"
}

variable "github_repository_owner_id" {
  description = "Numeric GitHub owner (user/org) ID for the OIDC trust policy — see github_repository_id for why this is matched instead of the owner name."
  type        = string
  default     = "15948680"
}

variable "container_port" {
  description = "Port the Bun server binds. Matches PORT in the Dockerfile."
  type        = number
  default     = 4200
}

variable "image_tag" {
  description = "ECR image tag App Runner should run. CI sets this to the commit SHA."
  type        = string
  default     = "latest"
}

variable "db_username" {
  description = "Master username for the staging Postgres instance."
  type        = string
  default     = "nvc360_admin"
}

variable "acm_certificate_arn" {
  description = <<-EOT
    ACM certificate for HTTPS on the ALB. Empty = HTTP only, which is fine for
    a password-protected staging box but must be set before any real data goes
    near it. Requires a validated cert for the staging hostname in this region.
  EOT
  type        = string
  default     = ""
}

variable "staging_url" {
  description = "Public URL of staging. The app self-pings /api/ready using this, and it is used for absolute links in emails/SMS. Set to the ALB DNS name after the first apply, or to the CNAME once DNS is pointed."
  type        = string
  default     = "http://localhost:4200"
}
