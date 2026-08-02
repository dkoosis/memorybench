# bench-harness

Local experiment/analysis scripts for the trixi-provider benchmarking work.
Not part of the app (`tsconfig` scopes to `src/**`); run directly with `bun`/`bash`
from the repo root. Kept out of the root to keep the fork's divergence surface
legible against upstream `supermemoryai/memorybench`.

## Reusable

- **`pooled-mcnemar.ts`** — pooled exact-McNemar over replicate pairs, read-only
  over `data/runs/<runId>/report.json`. `bun run bench-harness/pooled-mcnemar.ts --ctl … --trt …`

## One-shot / archival

Tied to specific historical run IDs and now-deleted `bin/trixi-*` binaries; kept
for provenance, not expected to run as-is:

- `create-*-ckpt.ts` — checkpoint seeders for specific runs (det, rep, screen, full, full500)
- `chunk-seed.ts`, `chunk-merge.ts`, `run-chunks.sh` — chunked driver for the sm-clean500 self-hosted run
- `smoke-ingest.ts`, `smoke-sm-local.ts`, `smoke-compare.sh` — retrieval-only smoke checks
- `knob-full.sh`, `set-knob.sh`, `run-replicates.sh` — session-diversity-weight knob sweeps
- `backfill-*.sh`, `backfill-sess-tags.pl` — one-time container/tag backfills
