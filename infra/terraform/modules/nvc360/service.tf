# ---------------------------------------------------------------------------
# The staging service: ECS Fargate behind an Application Load Balancer.
#
# This was originally written for AWS App Runner, which is a better fit for a
# single stateless container and needs no load balancer (~$16/month cheaper).
# App Runner is DENIED by the organization's Service Control Policy on this
# Project account (see infra/README.md), so Fargate + ALB it is. If that SCP is
# ever loosened, App Runner becomes worth revisiting purely on cost.
#
# This is the part that costs money: ~$16/month for the ALB plus ~$9/month for
# one always-on 0.25 vCPU / 0.5 GB Fargate task.
#
# Networking uses the default VPC's public subnets with public IPs assigned, on
# purpose: private subnets would need a NAT gateway (~$32/month) for the task to
# reach Turso, Stripe, Twilio and Resend. Isolation comes from security groups —
# the task accepts traffic only from the ALB, and the database only from the
# task.
# ---------------------------------------------------------------------------

locals {
  container_name = "web"

  # Config keys pulled from Secrets Manager into the container environment,
  # injected key by key using ECS's "<secret-arn>:<json-key>::" syntax across
  # two JSON-object secrets (main.tf) — Secrets Manager bills per secret per
  # month, and this app needs ~25 keys.
  #
  # managed_secret_keys: Terraform generates or derives these itself and keeps
  # them in sync. manual_secret_keys: developers set these by hand via the AWS
  # console; Terraform only seeds placeholders so the task can start.
  #
  # Deliberately absent: S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (the task role
  # supplies credentials) and S3_ENDPOINT (unset = real AWS S3).
  managed_secret_keys = [
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
  ]

  manual_secret_keys = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_MAPS_API_KEY",
    "RESEND_API_KEY",
    "EMAIL_FROM",
    "STRIPE_SECRET_KEY",
    "STRIPE_PUBLISHABLE_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "AUTUMN_SECRET_KEY",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER",
    "AI_GATEWAY_API_KEY",
    "AI_GATEWAY_BASE_URL",
    "SENTRY_DSN",
    "REDIS_URL",
  ]
}

# --- Security groups -------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "Public ingress to the staging load balancer."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "To the Fargate task"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "task" {
  name        = "${var.name_prefix}-task"
  description = "Staging Fargate task. Ingress only from the ALB."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "App port from ALB only"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "Outbound to Turso, Stripe, Twilio, Resend, ECR, S3"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- Load balancer ---------------------------------------------------------

resource "aws_lb" "web" {
  name               = "${var.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default.ids

  idle_timeout = 300 # SSE streams hold connections open; 60s default cuts them
}

resource "aws_lb_target_group" "web" {
  name        = "${var.name_prefix}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip" # awsvpc networking
  vpc_id      = data.aws_vpc.default.id

  # Give in-flight SSE streams time to finish on deploy.
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/api/ready"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.web.arn
  port              = 80
  protocol          = "HTTP"

  # With a certificate, force HTTPS. Without one, serve HTTP so staging is
  # reachable before DNS and ACM are sorted out.
  default_action {
    type = var.acm_certificate_arn == "" ? "forward" : "redirect"

    target_group_arn = var.acm_certificate_arn == "" ? aws_lb_target_group.web.arn : null

    dynamic "redirect" {
      for_each = var.acm_certificate_arn == "" ? [] : [1]
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = var.acm_certificate_arn != "" ? 1 : 0
  load_balancer_arn = aws_lb.web.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# --- IAM -------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: what ECS itself needs — pull the image, write logs, read the
# secrets it injects into the container.
resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "ReadInjectedSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app_config.arn, aws_secretsmanager_secret.app_config_managed.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# Task role: what the application code itself can do at runtime.
resource "aws_iam_role" "app_task" {
  name               = "${var.name_prefix}-app-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
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
}

resource "aws_iam_role_policy" "app_task" {
  name   = "runtime"
  role   = aws_iam_role.app_task.id
  policy = data.aws_iam_policy_document.app_task.json
}

# --- ECS -------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = var.name_prefix

  setting {
    name  = "containerInsights"
    value = "disabled" # extra CloudWatch cost, not worth it for staging
  }
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name_prefix}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = local.container_name
      image     = "${aws_ecr_repository.web.repository_url}:${var.image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = var.container_port
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = tostring(var.container_port) },
        { name = "S3_BUCKET", value = aws_s3_bucket.uploads.bucket },
        { name = "AWS_REGION", value = var.region },
        { name = "SENTRY_ENV", value = "staging" },
        # The app self-pings this to stay warm; point it at the ALB so the
        # request traverses the real path rather than localhost.
        { name = "APP_URL", value = var.staging_url },
        { name = "WEBSITE_URL", value = var.staging_url },
      ]

      secrets = concat(
        [
          for k in local.manual_secret_keys : {
            name      = k
            valueFrom = "${aws_secretsmanager_secret.app_config.arn}:${k}::"
          }
        ],
        [
          for k in local.managed_secret_keys : {
            name      = k
            valueFrom = "${aws_secretsmanager_secret.app_config_managed.arn}:${k}::"
          }
        ],
      )

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "web"
        }
      }

      # Container-level health check, independent of the ALB's.
      healthCheck = {
        command     = ["CMD-SHELL", "bun -e 'const r = await fetch(\"http://127.0.0.1:${var.container_port}/api/ready\"); process.exit(r.ok ? 0 : 1)' || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
  ])
}

resource "aws_ecs_service" "web" {
  name            = "${var.name_prefix}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  launch_type     = "FARGATE"

  # Exactly one task. This is NOT a cost decision: six setInterval sweeps
  # (presence, scheduler, automation, delay-watch, email-domain poll, DB ping)
  # run inside this process and are only correct at a single instance. Raising
  # this before the background-task workstream lands would double-fire the
  # scheduler, automations and the delay watcher.
  desired_count = 1

  # With one task, a rolling deploy needs room to start the replacement before
  # draining the old one.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 200

  # Roll back automatically if the new task never goes healthy.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  health_check_grace_period_seconds = 60

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true # no NAT gateway — see header
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = local.container_name
    container_port   = var.container_port
  }

  # CI deploys by registering a new task definition revision, so Terraform must
  # not revert the running revision on the next apply.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.http]
}
