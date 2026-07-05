// Smoke: ingest one LongMemEval haystack into local supermemory, search it back.
// Validates baseURL wiring + local server path. Run: bun run smoke-sm-local.ts
import LongMemEvalBenchmark from "./src/benchmarks/longmemeval/index"
import SupermemoryProvider from "./src/providers/supermemory/index"
import { getProviderConfig } from "./src/utils/config"

const QID = "6d550036"
const bench = new LongMemEvalBenchmark()
await bench.load()
const q = bench.getQuestions().find((x) => x.questionId === QID)!
const sessions = bench.getHaystackSessions(QID)

const provider = new SupermemoryProvider()
await provider.initialize(getProviderConfig("supermemory"))

const containerTag = `${QID}-smoke-local`
const t0 = Date.now()
const res = await provider.ingest(sessions, { containerTag })
console.log(`ingested ${sessions.length} sessions -> ${res.documentIds.length} docs in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
await provider.awaitIndexing(res, containerTag)
console.log(`indexed in ${((Date.now() - t0) / 1000).toFixed(0)}s total`)

const results = await provider.search(q.question, { containerTag })
console.log(`\nQ: ${q.question}`)
console.log(`search hits: ${results.length}`)
console.log(JSON.stringify(results.slice(0, 2), null, 2).slice(0, 1200))
console.log("\nDONE")
