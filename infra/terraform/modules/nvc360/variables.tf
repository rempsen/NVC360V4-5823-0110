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
  description = "owner/repo allowed to assume the CI deploy role via OIDC."
  type        = string
  default     = "rempsen/NVC360V4-5823-0110"
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
