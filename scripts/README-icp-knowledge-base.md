# ICP knowledge base

The deep per-industry research that grounds NVC 360's per-tenant AI
customization. Without it, every new tenant still provisions fine — it just
falls back to the generic baseline, silently, with no error.

## What it is

One row per ICP in the `icp_knowledge_base` table (17 rows today), each holding
a summary, concrete best practices, real workflow notes, terminology, tone and
notification refinement, compliance considerations, and cited sources — hand
researched from trade associations, standards bodies and trade publications,
not AI-generated.

## Where it is used

Exactly one code path: `POST /api/superadmin/companies`, the only place in the
codebase that inserts a tenant. `loadIcpKnowledge()` in
`packages/web/src/api/routes/superadmin.ts` loads the row for the company's
industry and passes it into all three provisioning generators:

- `scoutStarterForms()` — the tenant's starter intake forms
- `scoutStarterTemplates()` — starter work-order templates
- `scoutStarterServices()` — the tailored service library

A missing row is expected and handled — all three degrade to the static
`IndustryPreset` in `packages/web/src/services/industry-presets.ts`.

## Files here

| File | Purpose |
| --- | --- |
| `icp-knowledge-base.json` | The committed snapshot of all 17 rows. Source of truth for restores. |
| `export-icp-knowledge-base.ts` | Read-only. Dumps the live table back into that JSON. |
| `restore-icp-knowledge-base.ts` | Replays the JSON into any database. Dry run by default. |
| `seed-icp-knowledge-base.ts` | Historical: the original Wave 1 seed (4 ICPs). |
| `seed-icp-knowledge-base-wave2.ts` | Historical: Wave 2, the remaining ICPs. |

The two `seed-*` scripts are kept as the record of how the rows were built.
Do not re-run them against a live database — they delete retired ids. Use
`restore-icp-knowledge-base.ts` instead.

## Standing up a fresh database

Migration `packages/web/drizzle/0002_icp_knowledge_base.sql` creates the table
empty, so after `db:migrate` you must also run:

```bash
# from the repo root
bun --env-file=.env scripts/restore-icp-knowledge-base.ts          # dry run, prints the plan
bun --env-file=.env scripts/restore-icp-knowledge-base.ts --apply  # write
```

It upserts by `industry`, so re-running is safe. It never deletes rows that
exist in the database but not in the JSON — it lists them and leaves them alone.

## After editing the research

Editing the source docs changes nothing on its own — the app only ever reads
the database table. Update the row (or the JSON + `--apply`), then re-export so
the committed snapshot stays in step:

```bash
bun --env-file=.env scripts/export-icp-knowledge-base.ts
git add scripts/icp-knowledge-base.json && git commit
```
