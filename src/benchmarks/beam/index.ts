import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"
import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type {
  QuestionTypeRegistry,
  UnifiedMessage,
  UnifiedQuestion,
  UnifiedSession,
} from "../../types/unified"
import { logger } from "../../utils/logger"
import type { BeamBatch, BeamChatFile, BeamProbingQuestionsFile, BeamScale } from "./types"

const DEFAULT_DATA_PATH = "./data/benchmarks/beam/chats"

export const BEAM_QUESTION_TYPES: QuestionTypeRegistry = {
  abstention: {
    id: "abstention",
    alias: "abstain",
    description: "Withhold answers when evidence is missing",
  },
  contradiction_resolution: {
    id: "contradiction_resolution",
    alias: "contradict",
    description: "Detect and reconcile inconsistent statements",
  },
  event_ordering: {
    id: "event_ordering",
    alias: "order",
    description: "Reconstruct event or information order",
  },
  information_extraction: {
    id: "information_extraction",
    alias: "extract",
    description: "Recall entities and factual details",
  },
  instruction_following: {
    id: "instruction_following",
    alias: "instruction",
    description: "Follow sustained user instructions",
  },
  knowledge_update: {
    id: "knowledge_update",
    alias: "update",
    description: "Retain updated facts over stale facts",
  },
  multi_session_reasoning: {
    id: "multi_session_reasoning",
    alias: "multi",
    description: "Reason across non-adjacent dialogue segments",
  },
  preference_following: {
    id: "preference_following",
    alias: "preference",
    description: "Adapt to evolving user preferences",
  },
  summarization: {
    id: "summarization",
    alias: "summary",
    description: "Summarize dialogue content",
  },
  temporal_reasoning: {
    id: "temporal_reasoning",
    alias: "temporal",
    description: "Reason about explicit and implicit time relations",
  },
}

function flattenChatFile(chatFile: BeamChatFile): BeamBatch[] {
  if (Array.isArray(chatFile)) {
    return chatFile.flatMap((entry) => {
      if (isBeamBatch(entry)) return [entry]
      return flattenChatFile(entry)
    })
  }

  return Object.keys(chatFile)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .flatMap((key) => chatFile[key] || [])
}

function isBeamBatch(value: unknown): value is BeamBatch {
  return (
    typeof value === "object" &&
    value !== null &&
    "batch_number" in value &&
    "turns" in value &&
    Array.isArray((value as BeamBatch).turns)
  )
}

function createGroundTruth(question: unknown): string {
  if (typeof question === "object" && question !== null) {
    const record = question as Record<string, unknown>
    const answer = getQuestionAnswer(record)
    return answer || JSON.stringify(question)
  }

  return JSON.stringify(question)
}

function getQuestionAnswer(question: Record<string, unknown>): string | undefined {
  const answer =
    question.answer || question.ideal_answer || question.ideal_response || question.ideal_summary
  return typeof answer === "string" ? answer : undefined
}

export class BeamBenchmark implements Benchmark {
  name: string
  private scales: BeamScale[]
  private questions: UnifiedQuestion[] = []
  private sessionsMap: Map<string, UnifiedSession[]> = new Map()
  private ingestionGroupMap: Map<string, string> = new Map()
  private dataPath: string = ""

  constructor(scales: BeamScale[] = ["1M", "10M"], name = "beam") {
    this.scales = scales
    this.name = name
  }

  async load(config?: BenchmarkConfig): Promise<void> {
    this.dataPath = config?.dataPath || DEFAULT_DATA_PATH
    const fullPath = join(process.cwd(), this.dataPath)

    if (!existsSync(fullPath)) {
      throw new Error(
        `BEAM dataset not found at ${fullPath}. Expected chats under ${DEFAULT_DATA_PATH}/{1M,10M}.`
      )
    }

    for (const scale of this.scales) {
      this.loadScale(fullPath, scale)
    }

    logger.info(
      `Loaded ${this.questions.length} questions from BEAM (${this.scales.join(", ")})`
    )
  }

  private loadScale(basePath: string, scale: BeamScale): void {
    const scalePath = join(basePath, scale)
    if (!existsSync(scalePath)) {
      throw new Error(`BEAM ${scale} dataset not found at ${scalePath}`)
    }

    const chatDirs = readdirSync(scalePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(a) - Number(b))

    for (const chatId of chatDirs) {
      this.loadChat(scalePath, scale, chatId)
    }
  }

  private loadChat(scalePath: string, scale: BeamScale, chatId: string): void {
    const chatDir = join(scalePath, chatId)
    const truncatedPath = join(chatDir, "chat_trunecated.json")
    const fullChatPath = join(chatDir, "chat.json")
    const chatPath = existsSync(truncatedPath) ? truncatedPath : fullChatPath
    const probingPath = join(chatDir, "probing_questions", "probing_questions.json")

    if (!existsSync(chatPath) || !existsSync(probingPath)) {
      logger.warn(`Skipping BEAM ${scale}/${chatId}: missing chat or probing questions`)
      return
    }

    const batches = flattenChatFile(JSON.parse(readFileSync(chatPath, "utf8")) as BeamChatFile)
    const sessions = this.extractSessions(scale, chatId, batches)
    const probingQuestions = JSON.parse(
      readFileSync(probingPath, "utf8")
    ) as BeamProbingQuestionsFile
    const sessionIds = sessions.map((session) => session.sessionId)
    const ingestionGroupId = `beam-${scale}-${chatId}`

    for (const questionType of Object.keys(probingQuestions)) {
      const questionsForType = probingQuestions[questionType] || []

      for (let i = 0; i < questionsForType.length; i++) {
        const probingQuestion = questionsForType[i]
        const questionId = `${ingestionGroupId}-${questionType}-${i}`
        const answer = getQuestionAnswer(probingQuestion)

        this.questions.push({
          questionId,
          question: probingQuestion.question,
          questionType,
          groundTruth: createGroundTruth(probingQuestion),
          haystackSessionIds: sessionIds,
          metadata: {
            scale,
            chatId,
            ingestionGroupId,
            rubric: probingQuestion.rubric,
            difficulty: probingQuestion.difficulty,
            answer,
          },
        })

        this.sessionsMap.set(questionId, sessions)
        this.ingestionGroupMap.set(questionId, ingestionGroupId)
      }
    }
  }

  private extractSessions(scale: BeamScale, chatId: string, batches: BeamBatch[]): UnifiedSession[] {
    const sessions: UnifiedSession[] = []

    for (const batch of batches) {
      for (let turnIndex = 0; turnIndex < batch.turns.length; turnIndex++) {
        const turn = batch.turns[turnIndex]
        const messages = turn
          .filter((message) => message.content)
          .map(
            (message): UnifiedMessage => ({
              role: message.role,
              content: message.content,
              speaker: message.role,
              timestamp: message.time_anchor,
            })
          )

        if (messages.length === 0) continue

        sessions.push({
          sessionId: `beam-${scale}-${chatId}-batch-${batch.batch_number}-turn-${turnIndex + 1}`,
          messages,
          metadata: {
            scale,
            chatId,
            batchNumber: batch.batch_number,
            turnIndex: turnIndex + 1,
            timeAnchor: batch.time_anchor,
          },
        })
      }
    }

    return sessions
  }

  getQuestions(filter?: QuestionFilter): UnifiedQuestion[] {
    let result = [...this.questions]

    if (filter?.questionTypes?.length) {
      result = result.filter((q) => filter.questionTypes!.includes(q.questionType))
    }

    if (filter?.offset) {
      result = result.slice(filter.offset)
    }

    if (filter?.limit) {
      result = result.slice(0, filter.limit)
    }

    return result
  }

  getHaystackSessions(questionId: string): UnifiedSession[] {
    return this.sessionsMap.get(questionId) || []
  }

  getGroundTruth(questionId: string): string {
    const question = this.questions.find((q) => q.questionId === questionId)
    return question?.groundTruth || ""
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return BEAM_QUESTION_TYPES
  }

  getIngestionGroupId(questionId: string): string {
    return this.ingestionGroupMap.get(questionId) || questionId
  }
}

export class Beam1MBenchmark extends BeamBenchmark {
  constructor() {
    super(["1M"], "beam-1m")
  }
}

export class Beam10MBenchmark extends BeamBenchmark {
  constructor() {
    super(["10M"], "beam-10m")
  }
}

export default BeamBenchmark
