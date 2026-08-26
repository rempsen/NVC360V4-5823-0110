resource "dockercompose_stack" "nvc360-v4" {
  name        = "nvc360-v4"
  working_dir = path.module

  service {
    name    = "db"
    image   = "postgres:16-alpine"
    restart = "unless-stopped"

    ports = [
      "5432:5432",
    ]

    environment = {
      POSTGRES_USER     = "nvc360"
      POSTGRES_PASSWORD = "nvc360_local"
      POSTGRES_DB       = "nvc360"
    }

    volumes = [
      "pgdata:/var/lib/postgresql/data",
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
      DATABASE_URL    = "postgresql://nvc360:nvc360_local@db:5432/nvc360"
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
    name = "pgdata"
  }

  volume {
    name = "node-modules"
  }
}