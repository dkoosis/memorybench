import { CheckpointManager } from "../src/orchestrator"
import { readFileSync } from "fs"
const cm = new CheckpointManager()
const qids = readFileSync("/tmp/screen_qids.txt", "utf8").split("\n").map(s => s.trim()).filter(Boolean)
for (const [src, dst] of [["trixi115-dated", "trixi116-sdiv-ctl-bf"], ["trixi115-dated", "trixi117-sdiv-w08-screen"]]) {
  const ck = cm.copyCheckpoint(src, dst, "search")
  ck.targetQuestionIds = qids
  cm.save(ck)
  console.log(`created ${dst}: ${qids.length} qids, dataSource=${ck.dataSourceRunId}, judge=${ck.judge}, answer=${ck.answeringModel}`)
}
