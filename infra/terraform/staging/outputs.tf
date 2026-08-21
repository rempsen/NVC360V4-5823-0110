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

output "service_url" {
  description = "Public HTTPS URL of the staging service (null until create_service = true)."
  value       = var.create_service ? "https://${aws_apprunner_service.web[0].service_url}" : null
}

output "database_endpoint" {
  description = "Staging Postgres endpoint (null until create_database = true)."
  value       = var.create_database ? aws_db_instance.postgres[0].endpoint : null
}
