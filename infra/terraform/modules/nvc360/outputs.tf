output "ecr_repository_url" {
  description = "Push target for CI: docker push <this>:<sha>"
  value       = aws_ecr_repository.web.repository_url
}

output "uploads_bucket" {
  description = "Set as S3_BUCKET in the staging container. Leave S3_ENDPOINT unset so Bun.S3Client talks to AWS S3."
  value       = aws_s3_bucket.uploads.bucket
}

output "app_config_secret_arn" {
  description = "Secrets Manager secret holding the staging runtime config JSON. Populate out of band."
  value       = aws_secretsmanager_secret.app_config.arn
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN repo variable in GitHub. CI assumes this via OIDC — no access keys in GitHub secrets."
  value       = aws_iam_role.github_deploy.arn
}

output "log_group" {
  description = "CloudWatch log group for application logs."
  value       = aws_cloudwatch_log_group.app.name
}

output "alb_dns_name" {
  description = "Public DNS name of the staging load balancer. Point a CNAME at this, then set var.staging_url."
  value       = aws_lb.web.dns_name
}

output "ecs_cluster_name" {
  description = "ECS cluster name, needed by the CD workflow to force a new deployment."
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "ECS service name, needed by the CD workflow."
  value       = aws_ecs_service.web.name
}

output "database_endpoint" {
  description = "Staging Postgres endpoint."
  value       = aws_db_instance.postgres.endpoint
}

output "better_auth_secret" {
  description = "Generated BETTER_AUTH_SECRET value. Terraform keeps this in sync in the app-config-managed secret automatically; exposed here for reference."
  value       = random_password.better_auth_secret.result
  sensitive   = true
}
