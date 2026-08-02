import { CheckpointManager } from "../src/orchestrator"
import { readFileSync } from "fs"
const cm = new CheckpointManager()
const qids = readFileSync("/tmp/all300_qids.txt", "utf8").split("\n").map(s => s.trim()).filter(Boolean)
for (const dst of ["trixi120-det-ctl", "trixi121-det-w08", "trixi122-det-w085"]) {
  const ck = cm.copyCheckpoint("trixi115-dated", dst, "search")
  ck.targetQuestionIds = qids
  cm.save(ck)
  console.log(`created ${dst}: ${qids.length} qids, dataSource=${ck.dataSourceRunId}`)
}
