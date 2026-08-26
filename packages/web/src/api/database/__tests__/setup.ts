/**
 * Shared Postgres test bootstrap.
 *
 * Bun runs every test file in one process against the same database, so this
 * ensures the full schema exists exactly once (via drizzle's migrator) rather
 * than each file deriving and creating its own tables the way the old SQLite
 * ":memory:" era did — there is no in-memory Postgres equivalent, so tests
 * now run against the real local Postgres from docker-compose.yml.
 *
 * Import this FIRST (before any `await import("../index")` of the real db
 * client) so DATABASE_URL is set before that module reads it, then
 * `await ensureSchema()` before seeding any data.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { join } from "node:path";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://nvc360:nvc360_local@localhost:5432/nvc360";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let ready: Promise<void> | null = null;

/** Ensures the full schema exists in the test Postgres database. Runs once per test process. */
export function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL });
      try {
        await migrate(drizzle(pool), {
          migrationsFolder: join(import.meta.dir, "../../../../drizzle"),
        });
        // Fresh-process guarantee: wipe all data so repeated local `bun test`
        // runs behave like the old SQLite ":memory:" store did (empty at the
        // start of every process) rather than a persistent database that
        // accumulates rows across runs and breaks exact-equality assertions.
        const { rows } = await pool.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
        );
        if (rows.length > 0) {
          const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
          await pool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
        }
      } finally {
        await pool.end();
      }
    })();
  }
  return ready;
}
