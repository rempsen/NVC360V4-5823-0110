terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State lives in S3 in the project account, versioned and encrypted, with
  # native S3 locking (use_lockfile) so no DynamoDB table is needed.
  # Bucket was bootstrapped by hand — a state backend cannot create itself.
  backend "s3" {
    bucket       = "nvc360-tfstate-293174400261"
    key          = "staging/terraform.tfstate"
    region       = "us-east-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "nvc360"
      Environment = "staging"
      ManagedBy   = "terraform"
      Repo        = "rempsen/NVC360V4-5823-0110"
    }
  }
}
