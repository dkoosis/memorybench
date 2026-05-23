import type { Provider, IngestResult } from "../../types/provider"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"

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

  const concurrency = resolveConcurrency("ingest", checkpoint.concurrency, provider.concurrency)

  const questionsByGroup = new Map<string, typeof pendingQuestions>()
  for (const question of pendingQuestions) {
    const groupId = benchmark.getIngestionGroupId?.(question.questionId) || question.questionId
    const questions = questionsByGroup.get(groupId) || []
    questions.push(question)
    questionsByGroup.set(groupId, questions)
  }

  const ingestionGroups = Array.from(questionsByGroup.entries()).map(([groupId, questions]) => ({
    groupId,
    questions,
    representative: questions[0],
  }))

  logger.info(
    `Ingesting ${pendingQuestions.length} questions across ${ingestionGroups.length} containers (concurrency: ${concurrency})...`
  )

  await ConcurrentExecutor.executeBatched({
    items: ingestionGroups,
    concurrency,
    rateLimitMs: RATE_LIMIT_MS,
    runId: checkpoint.runId,
    phaseName: "ingest",
    executeTask: async ({ item: group, index, total }) => {
      const question = group.representative
      const groupQuestionIds = group.questions.map((q) => q.questionId)
      const containerTag = checkpoint.questions[question.questionId].containerTag
      const sessions = benchmark.getHaystackSessions(question.questionId)

      const sessionsMetadata = sessions.map((s) => ({
        sessionId: s.sessionId,
        date: s.metadata?.date as string | undefined,
        messageCount: s.messages.length,
      }))
      for (const questionId of groupQuestionIds) {
        checkpointManager.updateSessions(checkpoint, questionId, sessionsMetadata)
      }

      const startTime = Date.now()
      for (const questionId of groupQuestionIds) {
        checkpointManager.updatePhase(checkpoint, questionId, "ingest", {
          status: "in_progress",
          startedAt: new Date().toISOString(),
        })
      }

      try {
        const completedSessions =
          checkpoint.questions[question.questionId].phases.ingest.completedSessions
        const combinedResult: IngestResult = { documentIds: [], taskIds: [] }

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
          for (const questionId of groupQuestionIds) {
            checkpointManager.updatePhase(checkpoint, questionId, "ingest", {
              completedSessions: [...completedSessions],
            })
          }
        }

        if (combinedResult.taskIds && combinedResult.taskIds.length === 0) {
          delete combinedResult.taskIds
        }

        const existingResult = checkpoint.questions[question.questionId].phases.ingest.ingestResult
        if (existingResult) {
          combinedResult.documentIds = [
            ...existingResult.documentIds,
            ...combinedResult.documentIds,
          ]
          if (existingResult.taskIds || combinedResult.taskIds) {
            combinedResult.taskIds = [
              ...(existingResult.taskIds || []),
              ...(combinedResult.taskIds || []),
            ]
          }
        }

        const durationMs = Date.now() - startTime
        for (const questionId of groupQuestionIds) {
          checkpointManager.updatePhase(checkpoint, questionId, "ingest", {
            status: "completed",
            ingestResult: {
              documentIds: [...combinedResult.documentIds],
              ...(combinedResult.taskIds ? { taskIds: [...combinedResult.taskIds] } : {}),
            },
            completedAt: new Date().toISOString(),
            durationMs,
          })
        }

        logger.progress(index + 1, total, `Ingested ${group.groupId} (${durationMs}ms)`)

        return { questionId: question.questionId, durationMs }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        for (const questionId of groupQuestionIds) {
          checkpointManager.updatePhase(checkpoint, questionId, "ingest", {
            status: "failed",
            error,
          })
        }
        logger.error(`Failed to ingest ${group.groupId}: ${error}`)
        throw new Error(
          `Ingest failed at ${group.groupId}: ${error}. Fix the issue and resume with the same run ID.`
        )
      }
    },
  })

  logger.success("Ingest phase complete")
}
