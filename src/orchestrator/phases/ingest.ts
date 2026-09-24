import type { Provider, IngestResult } from "../../types/provider"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { UnifiedQuestion } from "../../types/unified"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"
import { containerTagFor, groupBy } from "../haystack"

const RATE_LIMIT_MS = 1000

export async function runIngestPhase(
  provider: Provider,
  benchmark: Benchmark,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager,
  questionIds?: string[]
): Promise<void> {
  const questions = benchmark.getQuestions()
  const targetQuestions = questionIds
    ? questions.filter((q) => questionIds.includes(q.questionId))
    : questions

  const pendingQuestions = targetQuestions.filter((q) => {
    const status = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "ingest")
    return status !== "completed"
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending ingestion")
    return
  }

  // One ingest per container: questions that share a haystack (UnifiedQuestion.haystackId)
  // are ingested together, and each is marked complete with the same result.
  const groups = [
    ...groupBy(pendingQuestions, (q) => containerTagFor(q, checkpoint.dataSourceRunId)).entries(),
  ].map(([containerTag, members]) => ({ containerTag, members }))

  const concurrency = resolveConcurrency("ingest", checkpoint.concurrency, provider.concurrency)

  logger.info(
    `Ingesting ${pendingQuestions.length} questions in ${groups.length} haystack(s) (concurrency: ${concurrency})...`
  )

  await ConcurrentExecutor.executeBatched({
    items: groups,
    concurrency,
    rateLimitMs: RATE_LIMIT_MS,
    runId: checkpoint.runId,
    phaseName: "ingest",
    executeTask: async ({ item: group, index, total }) => {
      const { containerTag, members } = group
      const lead: UnifiedQuestion = members[0]
      const sessions = benchmark.getHaystackSessions(lead.questionId)

      const sessionsMetadata = sessions.map((s) => ({
        sessionId: s.sessionId,
        date: s.metadata?.date as string | undefined,
        messageCount: s.messages.length,
      }))
      const startTime = Date.now()
      for (const q of members) {
        checkpointManager.updateSessions(checkpoint, q.questionId, sessionsMetadata)
        checkpointManager.updatePhase(checkpoint, q.questionId, "ingest", {
          status: "in_progress",
          startedAt: new Date().toISOString(),
        })
      }

      // A session any sharing question already finished (an earlier, resumed run)
      // is not ingested again; its result is carried over.
      const completedSessions: string[] = []
      const combinedResult: IngestResult = { documentIds: [], taskIds: [] }
      for (const q of members) {
        const ph = checkpoint.questions[q.questionId].phases.ingest
        for (const sid of ph.completedSessions) {
          if (!completedSessions.includes(sid)) completedSessions.push(sid)
        }
        // Every sharing question carries the same snapshot, so ids are merged once.
        for (const id of ph.ingestResult?.documentIds ?? []) {
          if (!combinedResult.documentIds.includes(id)) combinedResult.documentIds.push(id)
        }
        for (const id of ph.ingestResult?.taskIds ?? []) {
          if (!combinedResult.taskIds!.includes(id)) combinedResult.taskIds!.push(id)
        }
      }

      const markAll = (patch: Record<string, unknown>) => {
        for (const q of members) {
          checkpointManager.updatePhase(checkpoint, q.questionId, "ingest", patch)
        }
      }

      try {
        for (const session of sessions) {
          if (completedSessions.includes(session.sessionId)) {
            continue
          }

          const result = await provider.ingest([session], { containerTag })

          combinedResult.documentIds.push(...result.documentIds)
          if (result.taskIds) {
            combinedResult.taskIds!.push(...result.taskIds)
          }

          completedSessions.push(session.sessionId)
          // The snapshot rides with the session list, so a crash before the
          // haystack completes loses no document a resumed run will skip.
          markAll({
            completedSessions: [...completedSessions],
            ingestResult: {
              documentIds: [...combinedResult.documentIds],
              ...(combinedResult.taskIds?.length ? { taskIds: [...combinedResult.taskIds] } : {}),
            },
          })
        }

        if (combinedResult.taskIds && combinedResult.taskIds.length === 0) {
          delete combinedResult.taskIds
        }

        const durationMs = Date.now() - startTime
        markAll({
          status: "completed",
          ingestResult: combinedResult,
          completedAt: new Date().toISOString(),
          durationMs,
        })

        logger.progress(
          index + 1,
          total,
          `Ingested ${containerTag} for ${members.length} question(s) (${durationMs}ms)`
        )

        return { questionId: lead.questionId, durationMs }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        markAll({ status: "failed", error })
        // Continue the run: one bad haystack must not abort a multi-hour benchmark.
        // The checkpoint carries the failure — indexing only picks up questions whose
        // ingest completed, so failed ones are skipped downstream, and resume (which
        // filters on status !== "completed") retries them under the same run ID.
        logger.error(`Failed to ingest ${containerTag}: ${error} (skipping, run continues)`)
        return { questionId: lead.questionId, durationMs: Date.now() - startTime }
      }
    },
  })

  logger.success("Ingest phase complete")
}
