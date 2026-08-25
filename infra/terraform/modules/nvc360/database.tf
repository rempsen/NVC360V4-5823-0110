# ---------------------------------------------------------------------------
# Staging Postgres — the Phase D migration target.
#
# The single most expensive line item in this footprint. Free for 12 months
# on this new account, roughly $15/month after.
#
# Placed in the default VPC's subnets on purpose: a purpose-built VPC with
# private subnets needs a NAT gateway to let the container reach the internet,
# and a NAT gateway alone is about $32/month — twice the cost of everything
# else here combined. Staging does not justify it. Access is restricted by
# security group instead, and the instance is not publicly reachable.
# ---------------------------------------------------------------------------

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_db_subnet_group" "postgres" {
  name       = "${var.name_prefix}-postgres"
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_security_group" "postgres" {
  name        = "${var.name_prefix}-postgres"
  description = "Staging Postgres. Ingress only from the App Runner VPC connector."
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Postgres accepts connections ONLY from the Fargate task security group —
# never from the internet. Created as a separate rule (not inline ingress) so
# the database can exist before the service does without a dependency cycle.
resource "aws_vpc_security_group_ingress_rule" "postgres_from_task" {
  security_group_id            = aws_security_group.postgres.id
  description                  = "Postgres from the staging Fargate task"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.task.id
}

# Master password is generated here and stored in Secrets Manager. It does land
# in Terraform state, which is why state lives in an encrypted, versioned,
# access-controlled bucket — and why this password is staging-only and must
# never be reused for production.
resource "random_password" "db" {
  length  = 32
  special = false # avoids URL-encoding pitfalls in DATABASE_URL
}

resource "aws_db_instance" "postgres" {
  identifier     = "${var.name_prefix}-postgres"
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.micro"

  allocated_storage     = 20
  max_allocated_storage = 50
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "nvc360"
  username = var.db_username
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.postgres.name
  vpc_security_group_ids = [aws_security_group.postgres.id]
  publicly_accessible    = false

  backup_retention_period = 7
  backup_window           = "07:00-08:00" # UTC — overnight in Canada
  maintenance_window      = "sun:08:30-sun:09:30"

  auto_minor_version_upgrade = true
  deletion_protection        = false # staging is disposable
  skip_final_snapshot        = true
  apply_immediately          = true

  performance_insights_enabled = false # extra cost, not needed for staging
}

resource "aws_secretsmanager_secret" "db_url" {
  name                    = "${var.name_prefix}/postgres-url"
  description             = "libpq connection URL for the staging Postgres instance."
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db_url" {
  secret_id = aws_secretsmanager_secret.db_url.id
  secret_string = format(
    "postgresql://%s:%s@%s/%s?sslmode=require",
    var.db_username,
    random_password.db.result,
    aws_db_instance.postgres.endpoint,
    "nvc360",
  )
}
