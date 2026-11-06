# bench-harness

Local experiment/analysis scripts for the memory-provider benchmarking work.
Not part of the app (`tsconfig` scopes to `src/**`); run directly with `bun`/`bash`
from the repo root. Kept out of the root to keep the fork's divergence surface
legible against upstream `supermemoryai/memorybench`.

## Reusable

- **`pooled-mcnemar.ts`** — pooled exact-McNemar over replicate pairs, read-only
  over `data/runs/<runId>/report.json`. `bun run bench-harness/pooled-mcnemar.ts --ctl … --trt …`

## One-shot / archival

Tied to specific historical run IDs; kept for provenance, not expected to run as-is:

- `chunk-seed.ts`, `chunk-merge.ts`, `run-chunks.sh` — chunked driver for the sm-clean500 self-hosted run
- `smoke-sm-local.ts` — retrieval-only smoke check
- `copy-mnemd-fq-checkpoint.ts`, `mnemd-batch-vs-capture.ts` — mnemd provider checkpoint and capture experiments
