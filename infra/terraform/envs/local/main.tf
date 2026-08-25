resource "dockercompose_stack" "nvc360-v4" {
  name        = "nvc360-v4"
  working_dir = path.module

  service {
    name     = "db"
    image    = "ghcr.io/tursodatabase/libsql-server:latest"
    restart  = "unless-stopped"
    platform = "linux/amd64"

    ports = [
      "8080:8080",
      "5001:5001",
    ]

    environment = {
      SQLD_NODE = "primary"
    }

    volumes = [
      "sqld-data:/var/lib/sqld",
    ]
  }

  service {
    name        = "web"
    image       = "oven/bun:alpine"
    depends_on  = ["db", "redis"]
    working_dir = "/app"
    entrypoint  = ["/bin/sh", "/app/entrypoint.sh"]

    ports = [
      "5173:5173",
    ]

    environment = {
      DATABASE_URL    = "http://db:8080"
      BETTER_AUTH_URL = "http://localhost:5173"
      REDIS_URL       = "redis://redis:6379"
    }

    volumes = [
      "./packages/web:/app",
      "./dev/docker/entrypoint.sh:/app/entrypoint.sh",
      "node-modules:/app/node_modules",
    ]
  }

  service {
    name    = "redis"
    image   = "redis:7-alpine"
    restart = "unless-stopped"

    ports = [
      "6379:6379",
    ]
  }

  volume {
    name = "sqld-data"
  }

  volume {
    name = "node-modules"
  }
}