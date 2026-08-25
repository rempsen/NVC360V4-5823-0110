terraform {
  required_providers {
    dockercompose = {
      source  = "xRizur/dockercompose"
      version = "~> 1.1"
    }
  }
}

# Default configuration using local Docker instance
provider "dockercompose" {
  project_directory = path.module
}