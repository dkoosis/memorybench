import { describe, test, expect } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { containerTagFor, groupBy } from "./haystack"
import { runIngestPhase } from "./phases/ingest"
import { runIndexingPhase } from "./phases/indexing"
import { CheckpointManager } from "./checkpoint"
import type { Benchmark } from "../types/benchmark"
import type { Provider, IngestResult } from "../types/provider"
import type { UnifiedQuestion, UnifiedSession } from "../types/unified"

describe("containerTagFor", () => {
  test("a question that names a haystack shares that haystack's container", () => {
    expect(containerTagFor({ questionId: "q1", haystackId: "conv-1" }, "run")).toBe("conv-1-run")
    expect(containerTagFor({ questionId: "q2", haystackId: "conv-1" }, "run")).toBe("conv-1-run")
  })
  test("a question without one is its own haystack, as before", () => {
    expect(containerTagFor({ questionId: "q1" }, "run")).toBe("q1-run")
  })
})

describe("groupBy", () => {
  test("keeps first-seen order of keys and of members", () => {
    const g = groupBy(
      [
        { k: "b", n: 1 },
        { k: "a", n: 2 },
        { k: "b", n: 3 },
      ],
      (x) => x.k
    )
    expect([...g.keys()]).toEqual(["b", "a"])
    expect(g.get("b")!.map((x) => x.n)).toEqual([1, 3])
  })
})

/** Two conversations, three questions each; every question of a
 * conversation names the same haystack of two sessions. */
function fakeBenchmark(): Benchmark {
  const sessionsOf = (h: string): UnifiedSession[] => [
    { sessionId: `${h}-s1`, messages: [{ role: "user", content: "hi" }] },
    { sessionId: `${h}-s2`, messages: [{ role: "user", content: "again" }] },
  ]
  const questions: UnifiedQuestion[] = []
  for (const h of ["conv-1", "conv-2"]) {
    for (let i = 1; i <= 3; i++) {
      questions.push({
        questionId: `${h}-q${i}`,
        question: `q${i}?`,
        questionType: "t",
        groundTruth: "a",
        haystackSessionIds: sessionsOf(h).map((s) => s.sessionId),
        haystackId: h,
      })
    }
  }
  return {
    name: "fake",
    async load() {},
    getQuestions: () => questions,
    getHaystackSessions: (qid) => sessionsOf(qid.replace(/-q\d$/, "")),
    getGroundTruth: () => "a",
    getQuestionTypes: () => ({}),
  }
}

function countingProvider() {
  const ingested: string[] = []
  const indexed: string[] = []
  const provider: Provider = {
    name: "counting",
    async initialize() {},
    async ingest(sessions, opts): Promise<IngestResult> {
      for (const s of sessions) ingested.push(`${opts.containerTag}/${s.sessionId}`)
      return { documentIds: sessions.map((s) => `doc-${s.sessionId}`) }
    },
    async awaitIndexing(result, containerTag, onProgress) {
      indexed.push(containerTag)
      onProgress?.({
        completedIds: result.documentIds,
        failedIds: [],
        total: result.documentIds.length,
      })
    },
    async search() {
      return []
    },
    async clear() {},
  }
  return { provider, ingested, indexed }
}

describe("shared haystacks through ingest and indexing", () => {
  test("each session is ingested once per haystack and every sharing question is marked complete", async () => {
    const base = await mkdtemp(join(tmpdir(), "mb-haystack-"))
    const cm = new CheckpointManager(base)
    const bench = fakeBenchmark()
    const cp = cm.create("run", "counting", "fake", "judge", "answerer", {})
    for (const q of bench.getQuestions()) {
      cm.initQuestion(cp, q.questionId, containerTagFor(q, cp.dataSourceRunId), {
        question: q.question,
        groundTruth: q.groundTruth,
        questionType: q.questionType,
      })
    }
    const { provider, ingested, indexed } = countingProvider()

    await runIngestPhase(provider, bench, cp, cm)

    expect(ingested.sort()).toEqual([
      "conv-1-run/conv-1-s1",
      "conv-1-run/conv-1-s2",
      "conv-2-run/conv-2-s1",
      "conv-2-run/conv-2-s2",
    ])
    for (const q of bench.getQuestions()) {
      const ph = cp.questions[q.questionId].phases.ingest
      expect(ph.status).toBe("completed")
      expect(ph.ingestResult?.documentIds.length).toBe(2)
      expect(ph.completedSessions.length).toBe(2)
    }

    await runIndexingPhase(provider, cp, cm)

    expect(indexed.sort()).toEqual(["conv-1-run", "conv-2-run"])
    for (const q of bench.getQuestions()) {
      expect(cp.questions[q.questionId].phases.indexing.status).toBe("completed")
    }
  })
})
