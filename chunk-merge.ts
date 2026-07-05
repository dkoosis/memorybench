// Merge all sm-clean500-cNN chunk checkpoints into one sm-clean500 checkpoint,
// then the report phase can be run over it for the final 500-question score.
// Usage: bun run chunk-merge.ts <mergedRunId> <chunkPrefix> <nChunks>
import { CheckpointManager } from "./src/orchestrator/checkpoint"
import { existsSync, cpSync } from "fs"

const [mergedId, prefix, nStr] = process.argv.slice(2)
const n = parseInt(nStr, 10)
const cm = new CheckpointManager()

const merged = cm.create(mergedId, "supermemory", "longmemeval", "gpt-4o-mini", "gpt-4o-mini", {
  status: "running",
})

let total = 0
let evaluated = 0
for (let i = 0; i < n; i++) {
  const cid = `${prefix}${i}`
  const ck = cm.load(cid)
  if (!ck) {
    console.warn(`MISSING chunk checkpoint: ${cid}`)
    continue
  }
  for (const [qid, q] of Object.entries(ck.questions)) {
    merged.questions[qid] = q
    total++
    if (q.phases.evaluate?.status === "completed") evaluated++
  }
  // copy per-chunk result files into the merged results dir
  const src = cm.getResultsDir(cid)
  const dst = cm.getResultsDir(mergedId)
  if (existsSync(src)) {
    try {
      cpSync(src, dst, { recursive: true })
    } catch (e) {
      console.warn(`copy results ${cid}: ${e}`)
    }
  }
}
merged.targetQuestionIds = Object.keys(merged.questions)
cm.save(merged)
await cm.flush(mergedId)
console.log(`merged ${mergedId}: ${total} questions (${evaluated} evaluated) from ${n} chunks`)
console.log(`next: bun run src/index.ts run -r ${mergedId} -f report`)
