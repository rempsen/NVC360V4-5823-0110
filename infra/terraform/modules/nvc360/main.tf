data "aws_caller_identity" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  database_url = "postgresql://${var.db_username}:${random_password.db.result}@${aws_db_instance.postgres.endpoint}/nvc360?sslmode=require"
}

# ---------------------------------------------------------------------------
# Container registry. CI pushes the image built from the repo Dockerfile here.
# Cost: storage only, pennies. Old untagged layers expire after 14 days.
# ---------------------------------------------------------------------------
resource "aws_ecr_repository" "web" {
  name                 = "${var.name_prefix}-web"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "web" {
  repository = aws_ecr_repository.web.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 14 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the 20 most recent tagged images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# Object storage for staging uploads. Replaces Tigris in this environment.
# The application already speaks the plain S3 wire protocol through
# Bun.S3Client, so pointing it here is an env-var change and nothing more:
# S3_ENDPOINT unset (default AWS), S3_BUCKET = this bucket.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "uploads" {
  bucket = "${var.name_prefix}-uploads-${local.account_id}"
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Staging is disposable — do not pay to store old versions forever.
resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# CORS so the browser can PUT directly to presigned URLs, same as Tigris today.
resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "HEAD"]
    allowed_origins = ["*"] # staging only — production must list real origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# ---------------------------------------------------------------------------
# Runtime configuration, split across two Secrets Manager secrets so
# Terraform-managed values can be updated normally while hand-entered ones are
# never reverted. Both are JSON blobs (not one secret per key) because
# Secrets Manager bills per secret per month and this app has ~30 config keys;
# the container reads both at boot.
#
# app_config: everything developers set by hand (Stripe, Twilio, Turso, etc.)
# directly via the AWS console or `aws secretsmanager put-secret-value`, never
# through this file or a tfvars file. Terraform seeds "" placeholders once so
# the ECS task can pull secrets and start, then ignore_changes keeps it from
# reverting those edits back to placeholders on the next apply.
#
# app_config_managed: values Terraform can generate or derive itself
# (BETTER_AUTH_SECRET, DATABASE_URL). No ignore_changes — Terraform writes a
# new secret version whenever either value changes.
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "app_config" {
  name        = "${var.name_prefix}/app-config"
  description = "Hand-entered runtime env for the staging container, as a JSON object. Update via the AWS console or `aws secretsmanager put-secret-value`, not Terraform."

  # Staging secrets should be re-creatable immediately, not held for 30 days.
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app_config" {
  secret_id = aws_secretsmanager_secret.app_config.id

  secret_string = jsonencode({ for k in local.manual_secret_keys : k => "" }) # every key the container expects exists

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "app_config_managed" {
  name        = "${var.name_prefix}/app-config-managed"
  description = "Terraform-managed runtime env for the staging container, as a JSON object."

  recovery_window_in_days = 0
}

# better-auth's session/cookie signing key. Pure random material — unlike the
# app_config keys, it needs no third-party account, so Terraform generates it.
resource "random_password" "better_auth_secret" {
  length  = 44
  special = false # avoids escaping pitfalls in shell/JSON handling downstream
}

resource "aws_secretsmanager_secret_version" "app_config_managed" {
  secret_id = aws_secretsmanager_secret.app_config_managed.id

  secret_string = jsonencode({
    BETTER_AUTH_SECRET = random_password.better_auth_secret.result,
    DATABASE_URL       = local.database_url,
  })
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/nvc360/${var.name_prefix}/app"
  retention_in_days = 14
}

# ---------------------------------------------------------------------------
# GitHub Actions OIDC. Lets CI push images and trigger deploys using a
# short-lived assumed role instead of a long-lived access key stored in GitHub
# secrets. This is the piece that makes the CD workstream safe to build.
# ---------------------------------------------------------------------------
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Only this repo, and only its main branch — not every branch, and not
    # pull requests from forks.
    #
    # AWS requires a Federated-OIDC trust policy to scope on `sub` (or
    # job_workflow_ref) — a policy that only used repository_id/ref claims
    # was rejected at apply time with "must evaluate ... sub ... which is
    # not scoped to all". So `sub` stays, but wildcarded on the human-readable
    # owner/repo names and pinned on the numeric IDs instead: GitHub appends
    # "@<id>" disambiguators to renamed repos/owners in `sub` (this repo was
    # renamed from NVC360V4-7630), which silently broke the old exact-name
    # StringLike match. repository_id/repository_owner_id are stable across
    # any future rename, so matching on them is the durable part; the ref
    # restriction lives in both the sub pattern and its own claim below.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:*@${var.github_repository_owner_id}/*@${var.github_repository_id}:ref:refs/heads/*"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_id"
      values   = [var.github_repository_id]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_owner_id"
      values   = [var.github_repository_owner_id]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:ref"
      values   = ["refs/heads/*"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${var.name_prefix}-github-deploy"
  description        = "Assumed by GitHub Actions on main to push images and deploy staging."
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrPush"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.web.arn]
  }

  # RegisterTaskDefinition and DescribeTaskDefinition don't support
  # resource-level restriction (AWS requires "*" for both).
  statement {
    sid    = "EcsTaskDefinitions"
    effect = "Allow"
    actions = [
      "ecs:RegisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "EcsDeploy"
    effect = "Allow"
    actions = [
      "ecs:DescribeServices",
      "ecs:UpdateService",
    ]
    resources = ["arn:aws:ecs:${var.region}:${local.account_id}:service/${var.name_prefix}/${var.name_prefix}-web"]
  }

  # The rolling deploy's new task definition revision references these roles;
  # ECS itself (not the deploy role) launches the task, so this is scoped to
  # exactly the two roles the task definition uses and to the ECS service
  # principal only.
  statement {
    sid       = "PassEcsRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.app_task.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # The smoke-test step reads the ALB's DNS name. elbv2 Describe* actions
  # don't support resource-level restriction either.
  statement {
    sid       = "DescribeLoadBalancer"
    effect    = "Allow"
    actions   = ["elasticloadbalancing:DescribeLoadBalancers"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
