# ---------------------------------------------------------------------------
# The staging service itself: AWS App Runner.
#
# Why App Runner over ECS Fargate + ALB, given the plan recommended Fargate:
# the app is one stateless container listening on $PORT, which is exactly App
# Runner's shape. Fargate needs an ALB to get HTTPS and a hostname, and an ALB
# is ~$16/month idle before any compute. App Runner includes TLS, a hostname,
# health checks, and scale-to-one, for roughly a third of that. On a $100
# credit budget that difference matters, and nothing here is one-way: the image
# is the same, so moving staging or production to ECS later is a Terraform
# change, not an application change.
#
# Gated behind var.create_service because App Runner refuses to create until an
# image actually exists in ECR. Order of operations: apply with the gate off ->
# CI pushes an image -> flip the gate on.
# ---------------------------------------------------------------------------

# Lets App Runner pull from our private ECR repository.
data "aws_iam_policy_document" "apprunner_build_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["build.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apprunner_ecr_access" {
  count              = var.create_service ? 1 : 0
  name               = "${var.name_prefix}-apprunner-ecr"
  assume_role_policy = data.aws_iam_policy_document.apprunner_build_assume.json
}

resource "aws_iam_role_policy_attachment" "apprunner_ecr_access" {
  count      = var.create_service ? 1 : 0
  role       = aws_iam_role.apprunner_ecr_access[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

# The role the running container itself assumes — this is what gives the app
# access to its uploads bucket and its secrets. No access keys in env vars.
data "aws_iam_policy_document" "apprunner_task_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["tasks.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app_task" {
  count              = var.create_service ? 1 : 0
  name               = "${var.name_prefix}-app-task"
  assume_role_policy = data.aws_iam_policy_document.apprunner_task_assume.json
}

data "aws_iam_policy_document" "app_task" {
  statement {
    sid    = "UploadsBucket"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
    ]
    resources = ["${aws_s3_bucket.uploads.arn}/*"]
  }

  statement {
    sid       = "UploadsBucketList"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.uploads.arn]
  }

  statement {
    sid     = "ReadConfig"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = compact([
      aws_secretsmanager_secret.app_config.arn,
      var.create_database ? aws_secretsmanager_secret.db_url[0].arn : "",
    ])
  }
}

resource "aws_iam_role_policy" "app_task" {
  count  = var.create_service ? 1 : 0
  name   = "runtime"
  role   = aws_iam_role.app_task[0].id
  policy = data.aws_iam_policy_document.app_task.json
}

resource "aws_apprunner_service" "web" {
  count        = var.create_service ? 1 : 0
  service_name = "${var.name_prefix}-web"

  source_configuration {
    # CI pushes an image and calls StartDeployment. Terraform must not fight it.
    auto_deployments_enabled = false

    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_ecr_access[0].arn
    }

    image_repository {
      image_identifier      = "${aws_ecr_repository.web.repository_url}:${var.image_tag}"
      image_repository_type = "ECR"

      image_configuration {
        port = tostring(var.container_port)

        runtime_environment_variables = {
          NODE_ENV   = "production"
          PORT       = tostring(var.container_port)
          S3_BUCKET  = aws_s3_bucket.uploads.bucket
          AWS_REGION = var.region
          SENTRY_ENV = "staging"
          # Deliberately NOT set: S3_ENDPOINT (defaults to AWS S3),
          # S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (the task role supplies
          # credentials instead). Everything secret comes from Secrets Manager.
        }

        runtime_environment_secrets = merge(
          { APP_CONFIG_JSON = aws_secretsmanager_secret.app_config.arn },
          var.create_database ? { POSTGRES_URL = aws_secretsmanager_secret.db_url[0].arn } : {},
        )
      }
    }
  }

  instance_configuration {
    cpu               = "256" # 0.25 vCPU — staging, not production load
    memory            = "512" # MB
    instance_role_arn = aws_iam_role.app_task[0].arn
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/api/ready"
    interval            = 20
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  # One instance. This is not a cost decision — six setInterval sweeps run
  # inside this process and are only correct at a single instance. Raising
  # max_size before the background-task workstream lands would double-fire the
  # scheduler, automations and delay watcher.
  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.single[0].arn

  observability_configuration {
    observability_enabled = false
  }
}

resource "aws_apprunner_auto_scaling_configuration_version" "single" {
  count                           = var.create_service ? 1 : 0
  auto_scaling_configuration_name = "${var.name_prefix}-single"
  max_concurrency                 = 100
  min_size                        = 1
  max_size                        = 1
}
