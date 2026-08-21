data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
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
# Runtime configuration. ONE Secrets Manager secret holding a JSON blob rather
# than one secret per key: Secrets Manager bills per secret per month, and this
# app has ~30 config keys. The container reads the whole blob at boot.
#
# Terraform creates the secret but deliberately does NOT set its value — real
# credentials are written out of band (CLI or console) so they never enter
# Terraform state, which is stored in S3 and readable by anyone with state
# access. ignore_changes keeps Terraform from fighting those manual writes.
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "app_config" {
  name        = "${var.name_prefix}/app-config"
  description = "Runtime env for the staging container, as a JSON object. Values are set out of band, never through Terraform."

  # Staging secrets should be re-creatable immediately, not held for 30 days.
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app_config_placeholder" {
  secret_id = aws_secretsmanager_secret.app_config.id

  secret_string = jsonencode({
    PLACEHOLDER = "Replace via: aws secretsmanager put-secret-value --secret-id ${var.name_prefix}/app-config --secret-string file://staging.json"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
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
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main"]
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

  statement {
    sid    = "DeployService"
    effect = "Allow"
    actions = [
      "apprunner:StartDeployment",
      "apprunner:DescribeService",
      "apprunner:ListServices",
      "apprunner:ListOperations",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
