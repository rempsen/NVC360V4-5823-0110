// Restore icp_knowledge_base from the committed scripts/icp-knowledge-base.json.
//
// This is the disaster-recovery / fresh-database path for the 17-ICP research
// snapshot that onboarding reads (see loadIcpKnowledge() in
// packages/web/src/api/routes/superadmin.ts). Migration 0002 creates the table
// EMPTY — without this step a new database silently falls back to the generic
// baseline for every new tenant.
//
// Idempotent: upserts by industry (primary key). It never deletes rows that
// exist in the database but not in the JSON — cleanup is a deliberate manual
// act, not a side effect of a restore.
//
// Dry run (default — prints the plan, writes nothing):
//   bun --env-file=.env scripts/restore-icp-knowledge-base.ts
// Apply:
//   bun --env-file=.env scripts/restore-icp-knowledge-base.ts --apply

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

const file = JSON.parse(
  readFileSync(join(import.meta.dir, "icp-knowledge-base.json"), "utf8"),
) as {
  schemaVersion: number;
  rowCount: number;
  rows: Record<string, string | number | null>[];
};

if (file.schemaVersion !== 1)
  throw new Error(`unsupported schemaVersion ${file.schemaVersion}`);
if (file.rows.length !== file.rowCount)
  throw new Error(
    `corrupt export: rowCount ${file.rowCount} but ${file.rows.length} rows`,
  );

const existing = new Set(
  (await client.execute("SELECT industry FROM icp_knowledge_base")).rows.map(
    (r) => String((r as any).industry),
  ),
);

const now = Date.now();
let created = 0;
let updated = 0;

for (const r of file.rows) {
  const isNew = !existing.has(String(r.industry));
  isNew ? created++ : updated++;
  console.log(`${isNew ? "CREATE" : "UPDATE"}  ${r.industry}`);
  if (!APPLY) continue;

  await client.execute({
    sql: `INSERT INTO icp_knowledge_base
            (industry, summary, best_practices, workflow_notes, terminology_notes,
             tone_refinement, notification_refinement, compliance_notes, sources,
             researched_by, researched_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(industry) DO UPDATE SET
            summary = excluded.summary,
            best_practices = excluded.best_practices,
            workflow_notes = excluded.workflow_notes,
            terminology_notes = excluded.terminology_notes,
            tone_refinement = excluded.tone_refinement,
            notification_refinement = excluded.notification_refinement,
            compliance_notes = excluded.compliance_notes,
            sources = excluded.sources,
            researched_by = excluded.researched_by,
            researched_at = excluded.researched_at,
            updated_at = excluded.updated_at`,
    args: [
      r.industry as string,
      (r.summary ?? "") as string,
      (r.best_practices ?? "") as string,
      (r.workflow_notes ?? "") as string,
      (r.terminology_notes ?? "") as string,
      (r.tone_refinement ?? "") as string,
      (r.notification_refinement ?? "") as string,
      (r.compliance_notes ?? "") as string,
      (r.sources ?? "") as string,
      (r.researched_by ?? "") as string,
      (r.researched_at ?? null) as number | null,
      now,
    ],
  });
}

const orphans = [...existing].filter(
  (i) => !file.rows.some((r) => r.industry === i),
);

console.log(
  `\n${APPLY ? "applied" : "DRY RUN (pass --apply to write)"} — ${created} to create, ${updated} to update`,
);
if (orphans.length)
  console.log(
    `note: ${orphans.length} row(s) in the database are not in the export and were left alone: ${orphans.join(", ")}`,
  );
