// Seed a per-chunk checkpoint for the sm-clean500 chunked run.
// Usage: bun run chunk-seed.ts <runId> <start> <count>
// Creates the checkpoint AND initializes its questions (the resume path in the
// orchestrator does NOT init questions — only the new-run path does — so we do it here).
import { CheckpointManager } from "./src/orchestrator/checkpoint"
import LongMemEvalBenchmark from "./src/benchmarks/longmemeval/index"

const [runId, startStr, countStr] = process.argv.slice(2)
if (!runId || startStr === undefined || countStr === undefined) {
  console.error("usage: bun run chunk-seed.ts <runId> <start> <count>")
  process.exit(1)
}
const start = parseInt(startStr, 10)
const count = parseInt(countStr, 10)

const bench = new LongMemEvalBenchmark()
await bench.load()
const all = bench.getQuestions()
const chunk = all.slice(start, start + count)
const qids = chunk.map((q) => q.questionId)

const cm = new CheckpointManager()
const ck = cm.create(runId, "supermemory", "longmemeval", "gpt-4o-mini", "gpt-4o-mini", {
  targetQuestionIds: qids,
  status: "initializing",
})
for (const q of chunk) {
  const containerTag = `${q.questionId}-${ck.dataSourceRunId}`
  cm.initQuestion(ck, q.questionId, containerTag, {
    question: q.question,
    groundTruth: q.groundTruth,
    questionType: q.questionType,
    questionDate: q.metadata?.questionDate as string | undefined,
  })
}
cm.save(ck)
await cm.flush(runId)
console.log(`seeded ${runId}: ${qids.length} qids [${start}..${start + count})`)
