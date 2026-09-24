import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type {
  UnifiedQuestion,
  UnifiedSession,
  UnifiedMessage,
  QuestionTypeRegistry,
} from "../../types/unified"
import type { BeamBatch, BeamProbingQuestion, BeamProbingQuestions } from "./types"
import { logger } from "../../utils/logger"

/** BEAM (arXiv:2510.27246) ships its chats in the repo; the 128K tier is the
 * directory the authors named 100K. 20 conversations, 10 abilities × 2
 * probing questions each. The larger tiers (500K–10M) test context windows,
 * not retrieval, and are not loaded here. */
const DEFAULT_DATA_PATH = "./data/benchmarks/beam/128K"
const RAW_BASE = "https://raw.githubusercontent.com/mohammadtavakoli78/BEAM/main/chats/100K"
export const BEAM_128K_CONVERSATIONS = 20

/** BEAM's ten memory abilities, keyed exactly as probing_questions.json keys them. */
export const BEAM_ABILITIES: QuestionTypeRegistry = {
  abstention: {
    id: "abstention",
    alias: "abstain",
    description: "Withholds when evidence is missing",
  },
  contradiction_resolution: {
    id: "contradiction_resolution",
    alias: "contra",
    description: "Detects and reconciles inconsistent statements",
  },
  event_ordering: {
    id: "event_ordering",
    alias: "order",
    description: "Reconstructs the sequence of events",
  },
  information_extraction: {
    id: "information_extraction",
    alias: "extract",
    description: "Recalls entities and facts",
  },
  instruction_following: {
    id: "instruction_following",
    alias: "instruct",
    description: "Sustains user-specified constraints",
  },
  knowledge_update: {
    id: "knowledge_update",
    alias: "update",
    description: "Revises facts as new ones appear",
  },
  multi_session_reasoning: {
    id: "multi_session_reasoning",
    alias: "multi",
    description: "Integrates evidence across non-adjacent segments",
  },
  preference_following: {
    id: "preference_following",
    alias: "pref",
    description: "Adapts to evolving preferences",
  },
  summarization: {
    id: "summarization",
    alias: "summ",
    description: "Abstracts and compresses dialogue",
  },
  temporal_reasoning: {
    id: "temporal_reasoning",
    alias: "temporal",
    description: "Reasons about time relations",
  },
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** "March-15-2024" → ISO midnight UTC and the day-month-year phrase the
 * extraction prompt dates memories with. */
export function parseTimeAnchor(anchor: string): { iso: string; formatted: string } | null {
  const m = anchor.match(/^([A-Za-z]+)-(\d{1,2})-(\d{4})$/)
  if (!m) return null
  const month = MONTHS.findIndex((name) => name.toLowerCase() === m[1].toLowerCase())
  if (month < 0) return null
  const day = parseInt(m[2], 10)
  const year = parseInt(m[3], 10)
  const date = new Date(Date.UTC(year, month, day))
  return { iso: date.toISOString(), formatted: `${day} ${MONTHS[month]}, ${year}` }
}

/** Every user turn opener ends in " ->-> b,t", BEAM's plan pointer; it is
 * not something the user said. */
function stripMarker(content: string): string {
  return content.replace(/\s*->->\s*\d+,\d+\s*$/, "").trim()
}

/** The reference answer plus what BEAM grades on. Preference and
 * instruction questions have no answer: they are graded on compliance. */
export function groundTruthFor(ability: string, q: BeamProbingQuestion): string {
  const answer =
    q.answer ?? q.ideal_response ?? q.ideal_answer ?? q.ideal_summary ?? q.expected_compliance ?? ""
  const lines = [answer]
  if (q.expected_compliance && q.compliance_indicators?.length) {
    lines.push("Compliance indicators:", ...q.compliance_indicators.map((s) => `- ${s}`))
  } else if (q.rubric?.length) {
    lines.push("Rubric:", ...q.rubric.map((s) => `- ${s}`))
  }
  return lines.join("\n")
}

export class Beam128kBenchmark implements Benchmark {
  name = "beam128k"
  private questions: UnifiedQuestion[] = []
  private sessionsByHaystack: Map<string, UnifiedSession[]> = new Map()

  async load(config?: BenchmarkConfig): Promise<void> {
    const fullPath = join(process.cwd(), config?.dataPath || DEFAULT_DATA_PATH)
    const conversations = existsSync(fullPath)
      ? listConversationDirs(fullPath)
      : await this.download(fullPath)

    this.questions = []
    this.sessionsByHaystack.clear()
    for (const conv of conversations) {
      const dir = join(fullPath, String(conv))
      const haystackId = `beam128k-${conv}`
      const chat: BeamBatch[] = JSON.parse(readFileSync(join(dir, "chat.json"), "utf8"))
      const probing: BeamProbingQuestions = JSON.parse(
        readFileSync(join(dir, "probing_questions", "probing_questions.json"), "utf8")
      )
      const sessions = this.extractSessions(haystackId, chat)
      this.sessionsByHaystack.set(haystackId, sessions)
      const sessionIds = sessions.map((s) => s.sessionId)

      for (const ability of Object.keys(BEAM_ABILITIES)) {
        const qs = probing[ability] ?? []
        qs.forEach((q, i) => {
          this.questions.push({
            questionId: `${haystackId}-${ability}-${i + 1}`,
            question: q.question,
            questionType: ability,
            groundTruth: groundTruthFor(ability, q),
            haystackSessionIds: sessionIds,
            haystackId,
            metadata: { difficulty: q.difficulty, conversation: conv },
          })
        })
      }
    }
    logger.info(
      `Loaded ${this.questions.length} questions across ${conversations.length} BEAM 128K conversations`
    )
  }

  /** Fetches chat.json and probing_questions.json for each of the 20
   * conversations straight from the BEAM repo (CC-BY-SA data). */
  private async download(fullPath: string): Promise<number[]> {
    logger.info(
      `Downloading BEAM 128K tier (${BEAM_128K_CONVERSATIONS} conversations) from GitHub...`
    )
    const convs: number[] = []
    for (let n = 1; n <= BEAM_128K_CONVERSATIONS; n++) {
      const dir = join(fullPath, String(n))
      mkdirSync(join(dir, "probing_questions"), { recursive: true })
      for (const rel of ["chat.json", "probing_questions/probing_questions.json"]) {
        const url = `${RAW_BASE}/${n}/${rel}`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`)
        writeFileSync(join(dir, rel), await res.text())
      }
      logger.progress(n, BEAM_128K_CONVERSATIONS, `Downloaded conversation ${n}`)
      convs.push(n)
    }
    logger.success(`Downloaded BEAM 128K tier to ${fullPath}`)
    return convs
  }

  /** One session per dialogue turn (a user opener and everything up to the
   * next opener). The time anchor a turn names becomes the session date and
   * carries forward until the next anchor: BEAM anchors a few turns per
   * batch and means the rest to sit at that date. */
  private extractSessions(haystackId: string, chat: BeamBatch[]): UnifiedSession[] {
    const sessions: UnifiedSession[] = []
    let current: { iso: string; formatted: string } | null = null
    let turnNo = 0
    for (const batch of chat) {
      for (const turn of batch.turns) {
        turnNo++
        for (const m of turn) {
          if (m.time_anchor) current = parseTimeAnchor(m.time_anchor) ?? current
        }
        const messages: UnifiedMessage[] = turn.map((m) => ({
          role: m.role,
          content: m.role === "user" ? stripMarker(m.content) : m.content,
        }))
        sessions.push({
          sessionId: `${haystackId}-t${turnNo}`,
          messages,
          metadata: {
            date: current?.iso,
            formattedDate: current?.formatted,
            batch: batch.batch_number,
            speakerA: "User",
            speakerB: "Assistant",
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
    if (filter?.offset) result = result.slice(filter.offset)
    if (filter?.limit) result = result.slice(0, filter.limit)
    return result
  }

  getHaystackSessions(questionId: string): UnifiedSession[] {
    const q = this.questions.find((x) => x.questionId === questionId)
    return (q?.haystackId && this.sessionsByHaystack.get(q.haystackId)) || []
  }

  getGroundTruth(questionId: string): string {
    return this.questions.find((q) => q.questionId === questionId)?.groundTruth || ""
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return BEAM_ABILITIES
  }
}

function listConversationDirs(fullPath: string): number[] {
  return readdirSync(fullPath)
    .filter((d) => /^\d+$/.test(d) && existsSync(join(fullPath, d, "chat.json")))
    .map((d) => parseInt(d, 10))
    .sort((a, b) => a - b)
}

export default Beam128kBenchmark
