// mn-cw8: reuse mnemd-lme-50's on-disk containers for the formulated-query
// run — copy its checkpoint to a new runId, resetting only search/answer/
// evaluate. Never re-ingests (Rules on mn-cw8).
import { CheckpointManager } from "../src/orchestrator/checkpoint"

const SOURCE_RUN_ID = "mnemd-lme-50"
const NEW_RUN_ID = "mnemd-lme-50-fq"

const manager = new CheckpointManager()

if (manager.exists(NEW_RUN_ID)) {
  console.log(`${NEW_RUN_ID} already exists, not overwriting`)
  process.exit(0)
}

manager.copyCheckpoint(SOURCE_RUN_ID, NEW_RUN_ID, "search", {
  judge: "gpt-4o",
  answeringModel: "gpt-4o",
})
manager.flush(NEW_RUN_ID)

console.log(`Copied ${SOURCE_RUN_ID} -> ${NEW_RUN_ID} from phase 'search'`)
