output "ecr_repository_url" {
  description = "Push target for CI: docker push <this>:<sha>"
  value       = module.nvc360.ecr_repository_url
}

output "uploads_bucket" {
  description = "Set as S3_BUCKET in the staging container. Leave S3_ENDPOINT unset so Bun.S3Client talks to AWS S3."
  value       = module.nvc360.uploads_bucket
}

output "app_config_secret_arn" {
  description = "Secrets Manager secret holding the staging runtime config JSON. Populate out of band."
  value       = module.nvc360.app_config_secret_arn
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN repo variable in GitHub. CI assumes this via OIDC — no access keys in GitHub secrets."
  value       = module.nvc360.github_deploy_role_arn
}

output "log_group" {
  description = "CloudWatch log group for application logs."
  value       = module.nvc360.log_group
}

output "alb_dns_name" {
  description = "Public DNS name of the staging load balancer. Point a CNAME at this, then set var.staging_url."
  value       = module.nvc360.alb_dns_name
}

output "ecs_cluster_name" {
  description = "ECS cluster name, needed by the CD workflow to force a new deployment."
  value       = module.nvc360.ecs_cluster_name
}

output "ecs_service_name" {
  description = "ECS service name, needed by the CD workflow."
  value       = module.nvc360.ecs_service_name
}

output "database_endpoint" {
  description = "Staging Postgres endpoint."
  value       = module.nvc360.database_endpoint
}
