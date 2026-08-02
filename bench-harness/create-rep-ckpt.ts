import { CheckpointManager } from "../src/orchestrator"
import { readFileSync } from "fs"
const cm = new CheckpointManager()
const qids = readFileSync("/tmp/all300_qids.txt", "utf8").split("\n").map(s => s.trim()).filter(Boolean)
const dsts = [
  "trixi123-rep1-ctl", "trixi124-rep1-w08",
  "trixi125-rep2-ctl", "trixi126-rep2-w08",
  "trixi127-rep3-ctl", "trixi128-rep3-w08",
]
for (const dst of dsts) {
  const ck = cm.copyCheckpoint("trixi115-dated", dst, "search")
  ck.targetQuestionIds = qids
  cm.save(ck)
  console.log(`created ${dst}: ${qids.length} qids, dataSource=${ck.dataSourceRunId}`)
}
