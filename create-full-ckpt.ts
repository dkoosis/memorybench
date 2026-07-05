import { CheckpointManager } from "./src/orchestrator"
import { readFileSync } from "fs"
const cm = new CheckpointManager()
const qids = readFileSync("/tmp/all300_qids.txt", "utf8").split("\n").map(s => s.trim()).filter(Boolean)
for (const [src, dst] of [["trixi115-dated", "trixi118-sdiv-ctl-full"], ["trixi115-dated", "trixi119-sdiv-w08-full"]]) {
  const ck = cm.copyCheckpoint(src, dst, "search")
  ck.targetQuestionIds = qids
  cm.save(ck)
  console.log(`created ${dst}: ${qids.length} qids, dataSource=${ck.dataSourceRunId}, judge=${ck.judge}, answer=${ck.answeringModel}`)
}
