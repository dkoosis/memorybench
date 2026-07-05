// tx-1e5a5 smoke: fresh ingest of 5 enumeration multi-session haystacks into
// tagged trixi containers (sess: tags via f608ae9). Retrieval-only smoke — no
// answer/judge. Run: TRIXI_BIN=/tmp/trixi-tx1e5a5 bun run smoke-ingest.ts
import LongMemEvalBenchmark from "./src/benchmarks/longmemeval/index"
import TrixiProvider from "./src/providers/trixi/index"
import { getProviderConfig } from "./src/utils/config"

const RUN = "trixi116smoke"
const QIDS = ["6d550036", "b5ef892d", "3a704032", "2e6d26dc", "gpt4_2f8be40d"]

const bench = new LongMemEvalBenchmark()
await bench.load()

const provider = new TrixiProvider()
await provider.initialize(getProviderConfig("trixi"))

for (const qid of QIDS) {
  const sessions = bench.getHaystackSessions(qid)
  const containerTag = `${qid}-${RUN}`
  const t0 = Date.now()
  const res = await provider.ingest(sessions, { containerTag })
  await provider.awaitIndexing(res, containerTag)
  console.log(
    `INGESTED ${qid}: ${sessions.length} sessions -> ${res.documentIds.length} nugs, container=${containerTag}, ${((Date.now() - t0) / 1000).toFixed(0)}s`
  )
}
console.log("DONE")
