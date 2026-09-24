import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { Beam128kBenchmark, BEAM_ABILITIES, groundTruthFor } from "./index"
import { createBenchmark } from "../index"

/** A two-conversation slice in the exact shape BEAM's repo ships under
 * chats/100K/<n>/: chat.json (batches → turns → messages, a user turn opener
 * carrying `->-> b,t` and sometimes a time_anchor) and
 * probing_questions/probing_questions.json (ability → questions). */
function probing(conv: number) {
  const q = (s: string) => `${s} (conversation ${conv})`
  return {
    abstention: [
      {
        question: q("What did I say about my sister?"),
        ideal_response: "Based on the provided chat, there is no information about your sister.",
        rubric: ["states there is no information"],
      },
      { question: q("Where did I go to school?"), ideal_response: "No information.", rubric: [] },
    ],
    contradiction_resolution: [
      {
        question: q("Have I used Flask?"),
        ideal_answer: "Contradictory: never vs homepage.",
        rubric: ["notes the contradiction"],
      },
      { question: q("Do I own a car?"), ideal_answer: "Contradictory.", rubric: [] },
    ],
    event_ordering: [
      { question: q("Order the milestones."), answer: "Plan, build, launch.", rubric: [] },
      { question: q("What came first?"), answer: "The plan.", rubric: [] },
    ],
    information_extraction: [
      { question: q("What is my name?"), answer: "Craig", rubric: ["Craig"] },
      { question: q("What framework?"), answer: "Flask", rubric: [] },
    ],
    instruction_following: [
      {
        question: q("Suggest a library."),
        expected_compliance: "Recommends lightweight libraries.",
        compliance_indicators: ["lightweight"],
        rubric: ["lightweight"],
      },
      {
        question: q("Write a note."),
        expected_compliance: "Under 50 words.",
        compliance_indicators: [],
        rubric: [],
      },
    ],
    knowledge_update: [
      { question: q("What is the deadline now?"), answer: "April 15, 2024", rubric: [] },
      { question: q("Which DB?"), answer: "Postgres", rubric: [] },
    ],
    multi_session_reasoning: [
      { question: q("How long between plan and launch?"), answer: "One month.", rubric: [] },
      { question: q("Total spend?"), answer: "$300", rubric: [] },
    ],
    preference_following: [
      {
        question: q("Which tools?"),
        expected_compliance: "Minimal dependencies.",
        compliance_indicators: ["suggests lightweight libraries"],
        rubric: ["lightweight"],
      },
      {
        question: q("Which editor?"),
        expected_compliance: "Vim.",
        compliance_indicators: [],
        rubric: [],
      },
    ],
    summarization: [
      {
        question: q("Summarize the project."),
        ideal_summary: "A Flask budget tracker.",
        rubric: [],
      },
      { question: q("Summarize security."), ideal_summary: "Hashing and tokens.", rubric: [] },
    ],
    temporal_reasoning: [
      { question: q("How many days until launch?"), answer: "31 days", rubric: [] },
      { question: q("What month?"), answer: "March", rubric: [] },
    ],
  }
}

function chat() {
  return [
    {
      batch_number: 1,
      time_anchor: null,
      turns: [
        [
          {
            role: "user",
            id: 0,
            time_anchor: "March-15-2024",
            index: "1,1",
            question_type: "main_question",
            content: "I'm Craig and I'm building a budget tracker with Flask. ->-> 1,1",
          },
          { role: "assistant", id: 1, content: "Great, Craig. Flask is a fine choice." },
          { role: "user", id: 2, question_type: "follow_up", content: "Which database?" },
          { role: "assistant", id: 3, content: "Start with SQLite." },
        ],
        [
          {
            role: "user",
            id: 4,
            time_anchor: null,
            index: "1,2",
            question_type: "main_question",
            content: "Let's plan the milestones. ->-> 1,2",
          },
          { role: "assistant", id: 5, content: "Plan, build, launch." },
        ],
      ],
    },
    {
      batch_number: 2,
      time_anchor: null,
      turns: [
        [
          {
            role: "user",
            id: 6,
            time_anchor: "April-05-2024",
            index: "2,1",
            question_type: "main_question",
            content: "I switched to Postgres. ->-> 2,1",
          },
          { role: "assistant", id: 7, content: "Noted: Postgres." },
        ],
      ],
    },
  ]
}

let dataPath: string

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "beam128k-"))
  for (const conv of [1, 2]) {
    const dir = join(root, String(conv))
    await mkdir(join(dir, "probing_questions"), { recursive: true })
    await writeFile(join(dir, "chat.json"), JSON.stringify(chat()))
    await writeFile(
      join(dir, "probing_questions", "probing_questions.json"),
      JSON.stringify(probing(conv))
    )
  }
  // load() joins dataPath onto process.cwd(), as the longmemeval loader does.
  dataPath = relative(process.cwd(), root)
})

async function loaded(): Promise<Beam128kBenchmark> {
  const b = new Beam128kBenchmark()
  await b.load({ dataPath })
  return b
}

describe("Beam128kBenchmark.load", () => {
  test("yields every probing question with its BEAM ability as the question type", async () => {
    const b = await loaded()
    const qs = b.getQuestions()
    expect(qs.length).toBe(2 * 10 * 2)
    const types = new Set(qs.map((q) => q.questionType))
    expect([...types].sort()).toEqual(Object.keys(BEAM_ABILITIES).sort())
    expect(Object.keys(BEAM_ABILITIES).length).toBe(10)
  })

  test("orders questions conversation-major so -l 20·n selects n whole conversations", async () => {
    const b = await loaded()
    const qs = b.getQuestions()
    expect(qs.slice(0, 20).every((q) => q.haystackId === "beam128k-1")).toBe(true)
    expect(qs.slice(20).every((q) => q.haystackId === "beam128k-2")).toBe(true)
  })

  test("mints stable ids from conversation, ability and ordinal", async () => {
    const b = await loaded()
    const ids = b.getQuestions().map((q) => q.questionId)
    expect(ids).toContain("beam128k-1-abstention-1")
    expect(ids).toContain("beam128k-2-temporal_reasoning-2")
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("every question of a conversation shares its haystack: one ingest, twenty probes", async () => {
    const b = await loaded()
    const conv1 = b.getQuestions().filter((q) => q.haystackId === "beam128k-1")
    const sessionLists = new Set(conv1.map((q) => q.haystackSessionIds.join(",")))
    expect(sessionLists.size).toBe(1)
    expect(conv1[0].haystackSessionIds).toEqual(["beam128k-1-t1", "beam128k-1-t2", "beam128k-1-t3"])
  })

  test("cuts one session per dialogue turn, strips the ->-> marker, carries the time anchor forward", async () => {
    const b = await loaded()
    const sessions = b.getHaystackSessions("beam128k-1-abstention-1")
    expect(sessions.length).toBe(3)

    const [t1, t2, t3] = sessions
    expect(t1.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(t1.messages[0].content).toBe("I'm Craig and I'm building a budget tracker with Flask.")
    expect(t1.metadata?.date).toBe("2024-03-15T00:00:00.000Z")
    expect(t1.metadata?.formattedDate).toBe("15 March, 2024")

    // Turn 2 names no anchor: it inherits turn 1's date.
    expect(t2.metadata?.date).toBe("2024-03-15T00:00:00.000Z")
    // Batch 2 opens with a new anchor.
    expect(t3.metadata?.date).toBe("2024-04-05T00:00:00.000Z")
    expect(t3.messages[0].content).toBe("I switched to Postgres.")
  })

  test("getGroundTruth returns the ability-specific answer field", async () => {
    const b = await loaded()
    expect(b.getGroundTruth("beam128k-1-information_extraction-1")).toStartWith("Craig")
    expect(b.getGroundTruth("beam128k-1-abstention-1")).toStartWith(
      "Based on the provided chat, there is no information about your sister."
    )
    expect(b.getGroundTruth("beam128k-1-contradiction_resolution-1")).toStartWith(
      "Contradictory: never vs homepage."
    )
    expect(b.getGroundTruth("beam128k-1-summarization-1")).toStartWith("A Flask budget tracker.")
    expect(b.getGroundTruth("beam128k-1-preference_following-1")).toStartWith(
      "Minimal dependencies."
    )
  })

  test("getQuestions filters by ability and honours limit/offset", async () => {
    const b = await loaded()
    const abst = b.getQuestions({ questionTypes: ["abstention"] })
    expect(abst.length).toBe(4)
    expect(b.getQuestions({ limit: 3, offset: 1 }).map((q) => q.questionId)).toEqual([
      "beam128k-1-abstention-2",
      "beam128k-1-contradiction_resolution-1",
      "beam128k-1-contradiction_resolution-2",
    ])
  })

  test("getQuestionTypes registers the ten abilities with aliases", async () => {
    const b = await loaded()
    const reg = b.getQuestionTypes()
    expect(reg.abstention.alias).toBe("abstain")
    expect(reg.knowledge_update.alias).toBe("update")
    expect(Object.keys(reg).length).toBe(10)
  })
})

describe("groundTruthFor", () => {
  test("appends the rubric so the judge sees what BEAM grades on", () => {
    const gt = groundTruthFor("information_extraction", {
      question: "q",
      answer: "Craig",
      rubric: ["mentions Craig", "no other name"],
    })
    expect(gt).toBe("Craig\nRubric:\n- mentions Craig\n- no other name")
  })

  test("preference and instruction questions grade on expected compliance", () => {
    const gt = groundTruthFor("preference_following", {
      question: "q",
      expected_compliance: "Minimal dependencies.",
      compliance_indicators: ["lightweight", "few deps"],
      rubric: [],
    })
    expect(gt).toBe("Minimal dependencies.\nCompliance indicators:\n- lightweight\n- few deps")
  })
})

describe("registration", () => {
  test("createBenchmark knows beam128k", () => {
    expect(createBenchmark("beam128k").name).toBe("beam128k")
  })
})
