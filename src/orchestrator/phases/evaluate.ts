import type { Judge } from "../../types/judge"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { Provider } from "../../types/provider"
import { generateText } from "ai"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"
import { calculateRetrievalMetrics } from "./retrieval-eval"
import { buildBeamRubricJudgePrompt, parseBeamRubricJudgeResponse } from "../../prompts/beam"

interface BeamRubricItemResult {
  rubricItem: string
  score: number
  reason: string
}

function getBeamRubric(question: { metadata?: Record<string, unknown> }): string[] | null {
  const rubric = question.metadata?.rubric
  if (!Array.isArray(rubric) || rubric.some((item) => typeof item !== "string")) {
    return null
  }

  return rubric
}

async function evaluateBeamRubricQuestion(
  judge: Judge,
  question: { question: string; metadata?: Record<string, unknown> },
  hypothesis: string
): Promise<{ score: number; label: "correct" | "incorrect"; explanation: string; details: Record<string, unknown> }> {
  const rubric = getBeamRubric(question)
  if (!rubric) {
    return {
      score: 0,
      label: "incorrect",
      explanation: "Missing BEAM rubric metadata",
      details: {},
    }
  }

  const model = judge.getModel()
  const results: BeamRubricItemResult[] = []

  for (const rubricItem of rubric) {
    const prompt = buildBeamRubricJudgePrompt(question.question, rubricItem, hypothesis)
    const { text } = await generateText({
      model,
      prompt,
      maxOutputTokens: 512,
      temperature: 0,
    })
    const parsed = parseBeamRubricJudgeResponse(text)
    results.push({
      rubricItem,
      score: parsed.score,
      reason: parsed.reason,
    })
  }

  const averageScore =
    results.length > 0 ? results.reduce((sum, item) => sum + item.score, 0) / results.length : 0

  return {
    score: averageScore,
    label: averageScore >= 1 ? "correct" : "incorrect",
    explanation: `BEAM rubric average score: ${averageScore.toFixed(2)}`,
    details: {
      rubricResults: results,
      rubricAverageScore: averageScore,
    },
  }
}

export async function runEvaluatePhase(
  judge: Judge,
  benchmark: Benchmark,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager,
  questionIds?: string[],
  provider?: Provider
): Promise<void> {
  const questions = benchmark.getQuestions()
  const targetQuestions = questionIds
    ? questions.filter((q) => questionIds.includes(q.questionId))
    : questions

  const pendingQuestions = targetQuestions.filter((q) => {
    const status = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "evaluate")
    const answerStatus = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "answer")
    const hypothesis = checkpoint.questions[q.questionId]?.phases.answer.hypothesis
    return status !== "completed" && answerStatus === "completed" && hypothesis
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending evaluation")
    return
  }

  const concurrency = resolveConcurrency("evaluate", checkpoint.concurrency, provider?.concurrency)

  logger.info(
    `Evaluating ${pendingQuestions.length} questions with ${judge.name} (concurrency: ${concurrency})...`
  )

  await ConcurrentExecutor.execute(
    pendingQuestions,
    concurrency,
    checkpoint.runId,
    "evaluate",
    async ({ item: question, index, total }) => {
      const hypothesis = checkpoint.questions[question.questionId].phases.answer.hypothesis!

      const startTime = Date.now()
      checkpointManager.updatePhase(checkpoint, question.questionId, "evaluate", {
        status: "in_progress",
        startedAt: new Date().toISOString(),
      })

      try {
        const searchResults = checkpoint.questions[question.questionId].phases.search.results || []
        const rubric = getBeamRubric(question)

        const [result, retrievalMetrics] = await Promise.all([
          rubric
            ? evaluateBeamRubricQuestion(judge, question, hypothesis)
            : judge.evaluate({
                question: question.question,
                questionType: question.questionType,
                groundTruth: question.groundTruth,
                hypothesis,
                providerPrompts: provider?.prompts,
              }),
          calculateRetrievalMetrics(
            judge.getModel(),
            question.question,
            question.groundTruth,
            searchResults
          ),
        ])

        const durationMs = Date.now() - startTime
        checkpointManager.updatePhase(checkpoint, question.questionId, "evaluate", {
          status: "completed",
          score: result.score,
          label: result.label,
          explanation: result.explanation,
          details: result.details,
          retrievalMetrics,
          completedAt: new Date().toISOString(),
          durationMs,
        })

        const retrievalInfo = retrievalMetrics
          ? ` | Hit@${retrievalMetrics.k}=${retrievalMetrics.hitAtK}, MRR=${retrievalMetrics.mrr.toFixed(2)}`
          : ""
        logger.progress(
          index + 1,
          total,
          `Evaluated ${question.questionId}: ${result.label}${retrievalInfo} (${durationMs}ms)`
        )

        return { questionId: question.questionId, durationMs, label: result.label }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        checkpointManager.updatePhase(checkpoint, question.questionId, "evaluate", {
          status: "failed",
          error,
        })
        logger.error(`Failed to evaluate ${question.questionId}: ${error}`)
        throw new Error(
          `Evaluate failed at ${question.questionId}: ${error}. Fix the issue and resume with the same run ID.`
        )
      }
    }
  )

  logger.success("Evaluate phase complete")
}
