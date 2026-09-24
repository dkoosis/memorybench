import type { Provider, IndexingProgress } from "../../types/provider"
import type { RunCheckpoint, QuestionCheckpoint } from "../../types/checkpoint"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"
import { groupBy } from "../haystack"

function getEpisodeCount(question: QuestionCheckpoint): number {
  const ingestResult = question.phases.ingest.ingestResult
  if (!ingestResult) return 0
  return (ingestResult.documentIds?.length || 0) + (ingestResult.taskIds?.length || 0)
}

class IndexingProgressTracker {
  // Progress is per container: questions sharing a haystack share its episodes,
  // so whichever of them reports, the one row moves.
  private progressByContainer: Map<string, { completed: number; failed: number; total: number }> =
    new Map()
  private containerOf: Map<string, string> = new Map()
  private totalEpisodes: number = 0
  private lastDisplayed: string = ""

  constructor(questions: QuestionCheckpoint[]) {
    for (const q of questions) {
      this.containerOf.set(q.questionId, q.containerTag)
      if (this.progressByContainer.has(q.containerTag)) continue
      const count = getEpisodeCount(q)
      this.totalEpisodes += count
      this.progressByContainer.set(q.containerTag, { completed: 0, failed: 0, total: count })
    }
  }

  private rowFor(questionId: string) {
    const tag = this.containerOf.get(questionId)
    return tag === undefined ? undefined : { tag, row: this.progressByContainer.get(tag) }
  }

  update(questionId: string, progress: IndexingProgress): void {
    const r = this.rowFor(questionId)
    if (r?.row) {
      this.progressByContainer.set(r.tag, {
        completed: progress.completedIds.length,
        failed: progress.failedIds.length,
        total: progress.total,
      })
    }
    this.display()
  }

  markQuestionDone(questionId: string): void {
    const r = this.rowFor(questionId)
    if (r?.row) {
      this.progressByContainer.set(r.tag, {
        completed: r.row.total,
        failed: r.row.failed,
        total: r.row.total,
      })
    }
  }

  getAggregated(): { completed: number; failed: number; total: number } {
    let completed = 0
    let failed = 0
    for (const p of this.progressByContainer.values()) {
      completed += p.completed
      failed += p.failed
    }
    return { completed, failed, total: this.totalEpisodes }
  }

  display(): void {
    const agg = this.getAggregated()
    const displayStr = `${agg.completed}/${agg.total}`
    if (displayStr !== this.lastDisplayed) {
      this.lastDisplayed = displayStr
      const percent = agg.total > 0 ? Math.round((agg.completed / agg.total) * 100) : 0
      const bar = "█".repeat(Math.floor(percent / 5)) + "░".repeat(20 - Math.floor(percent / 5))
      const failedStr = agg.failed > 0 ? ` (${agg.failed} failed)` : ""
      process.stdout.write(
        `\r\x1b[36m[${bar}]\x1b[0m ${percent}% Indexing: ${agg.completed}/${agg.total} episodes${failedStr}`
      )
    }
  }

  finish(): void {
    const agg = this.getAggregated()
    const failedStr = agg.failed > 0 ? ` (${agg.failed} failed)` : ""
    process.stdout.write(
      `\r\x1b[36m[${"█".repeat(20)}]\x1b[0m 100% Indexing: ${agg.completed}/${agg.total} episodes${failedStr}\n`
    )
  }

  getTotalEpisodes(): number {
    return this.totalEpisodes
  }
}

export async function runIndexingPhase(
  provider: Provider,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager,
  questionIds?: string[]
): Promise<void> {
  const allQuestions = Object.values(checkpoint.questions)
  const targetQuestions = questionIds
    ? allQuestions.filter((q) => questionIds.includes(q.questionId))
    : allQuestions

  const toIndex = targetQuestions.filter(
    (q) => q.phases.ingest.status === "completed" && q.phases.indexing.status !== "completed"
  )

  if (toIndex.length === 0) {
    logger.info("No questions pending indexing")
    return
  }

  const concurrency = resolveConcurrency("indexing", checkpoint.concurrency, provider.concurrency)

  const tracker = new IndexingProgressTracker(toIndex)
  const totalEpisodes = tracker.getTotalEpisodes()

  logger.info(
    `Awaiting indexing for ${toIndex.length} questions, ${totalEpisodes} episodes (concurrency: ${concurrency})...`
  )

  tracker.display()

  // One awaitIndexing per container: questions sharing a haystack were ingested
  // into one container and carry the same ingestResult (see phases/ingest.ts).
  const groups = [...groupBy(toIndex, (q) => q.containerTag).entries()].map(
    ([containerTag, members]) => ({ containerTag, members })
  )

  await ConcurrentExecutor.execute(
    groups,
    concurrency,
    checkpoint.runId,
    "indexing",
    async ({ item: group }) => {
      const { containerTag, members } = group
      const question = members[0]
      const ingestResult = question.phases.ingest.ingestResult
      const episodeCount = getEpisodeCount(question)

      const markAll = (patch: Record<string, unknown>) => {
        for (const q of members) {
          checkpointManager.updatePhase(checkpoint, q.questionId, "indexing", patch)
        }
      }

      if (!ingestResult || episodeCount === 0) {
        markAll({
          status: "completed",
          completedIds: [],
          failedIds: [],
          completedAt: new Date().toISOString(),
          durationMs: 0,
        })
        for (const q of members) tracker.markQuestionDone(q.questionId)
        return { questionId: question.questionId, durationMs: 0 }
      }

      const startTime = Date.now()
      markAll({
        status: "in_progress",
        completedIds: [],
        failedIds: [],
        startedAt: new Date().toISOString(),
      })

      try {
        let lastProgress: IndexingProgress = {
          completedIds: [],
          failedIds: [],
          total: episodeCount,
        }

        await provider.awaitIndexing(ingestResult, containerTag, (progress) => {
          lastProgress = progress
          for (const q of members) tracker.update(q.questionId, progress)

          markAll({
            status: "in_progress",
            completedIds: progress.completedIds,
            failedIds: progress.failedIds,
          })
        })

        const durationMs = Date.now() - startTime
        markAll({
          status: "completed",
          completedIds: lastProgress.completedIds,
          failedIds: lastProgress.failedIds,
          completedAt: new Date().toISOString(),
          durationMs,
        })

        return { questionId: question.questionId, durationMs }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        markAll({ status: "failed", error })
        logger.error(`\nFailed to index ${containerTag}: ${error}`)
        throw new Error(
          `Indexing failed at ${containerTag}: ${error}. Fix the issue and resume with the same run ID.`
        )
      }
    }
  )

  tracker.finish()
  logger.success("Indexing phase complete")
}
