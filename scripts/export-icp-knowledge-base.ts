// Export the live icp_knowledge_base table to scripts/icp-knowledge-base.json.
//
// This JSON is the committed, reproducible copy of the 17-ICP research
// snapshot. The two seed scripts in this folder are the historical record of
// HOW the rows were built (Wave 1 = 4 rows, Wave 2 = the rest); this export is
// the current state of truth, and restore-icp-knowledge-base.ts replays it
// into any database.
//
// Read-only — it never writes to the database.
//
// Run from the repo root:
//   bun --env-file=.env scripts/export-icp-knowledge-base.ts

import { createClient } from "@libsql/client";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

const COLS = [
  "industry",
  "summary",
  "best_practices",
  "workflow_notes",
  "terminology_notes",
  "tone_refinement",
  "notification_refinement",
  "compliance_notes",
  "sources",
  "researched_by",
  "researched_at",
] as const;

const res = await client.execute(
  `SELECT ${COLS.join(", ")} FROM icp_knowledge_base ORDER BY industry`,
);

const rows = res.rows.map((r) =>
  Object.fromEntries(COLS.map((c) => [c, (r as any)[c] ?? null])),
);

const out = {
  // Bump when the shape of a row changes, not when content is edited.
  schemaVersion: 1,
  exportedAt: new Date().toISOString(),
  table: "icp_knowledge_base",
  rowCount: rows.length,
  rows,
};

const path = join(import.meta.dir, "icp-knowledge-base.json");
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");

console.log(`exported ${rows.length} rows -> ${path}`);
for (const r of rows) {
  const n = (s: string) => {
    try {
      const a = JSON.parse((r as any)[s] || "[]");
      return Array.isArray(a) ? a.length : 0;
    } catch {
      return 0;
    }
  };
  console.log(
    `  ${r.industry}: summary=${String(r.summary).length}ch practices=${n("best_practices")} sources=${n("sources")}`,
  );
}
