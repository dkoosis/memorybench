// Seed trixi129-w08-full500: reuse the 300 ingested containers (copy from
// trixi115-dated, search-onward reset) and add the 200 questions never ingested
// for trixi. New binary (trixi-9c30cc86) defaults session_diversity_weight 0.8,
// so search across all 500 exercises the adopted knob with no YAML overrides.
import { CheckpointManager } from "../src/orchestrator"
import LongMemEvalBenchmark from "../src/benchmarks/longmemeval/index"

const RUN_ID = "trixi129-w08-full500"
const cm = new CheckpointManager()
const ck = cm.copyCheckpoint("trixi115-dated", RUN_ID, "search")

const bench = new LongMemEvalBenchmark()
await bench.load()
const all = bench.getQuestions()
const have = new Set(Object.keys(ck.questions))
const missing = all.filter((q) => !have.has(q.questionId))

for (const q of missing) {
  const containerTag = `${q.questionId}-${ck.dataSourceRunId}`
  cm.initQuestion(ck, q.questionId, containerTag, {
    question: q.question,
    groundTruth: q.groundTruth,
    questionType: q.questionType,
    questionDate: q.metadata?.questionDate as string | undefined,
  })
}
ck.targetQuestionIds = all.map((q) => q.questionId)
cm.save(ck)
await cm.flush(RUN_ID)
console.log(
  `seeded ${RUN_ID}: ${Object.keys(ck.questions).length} questions ` +
    `(${have.size} reused ingest from ${ck.dataSourceRunId}, ${missing.length} to ingest), ` +
    `judge=${ck.judge}, answer=${ck.answeringModel}`
)
