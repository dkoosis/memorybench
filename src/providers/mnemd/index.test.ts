import { describe, test, expect } from "bun:test"
import { splitAtomicMemories, parseRecallOutput, sanitizePath } from "./index"
import type { UnifiedSession } from "../../types/unified"

function session(metadata?: Record<string, unknown>): UnifiedSession {
  return { sessionId: "sess-1", messages: [], metadata }
}

describe("splitAtomicMemories", () => {
  test("turns bullets into dated atoms and drops section headers", () => {
    const extracted = [
      "## Key Facts",
      "- Works as a marine biologist",
      "## Events",
      "- Adopted a kitten named Milo",
    ].join("\n")
    const atoms = splitAtomicMemories(extracted, session({ formattedDate: "2026-01-02" }))
    expect(atoms).toEqual([
      { body: "(2026-01-02): Works as a marine biologist" },
      { body: "(2026-01-02): Adopted a kitten named Milo" },
    ])
  })

  test("omits the date prefix when the session carries none", () => {
    const atoms = splitAtomicMemories("- Likes vintage cameras", session())
    expect(atoms).toEqual([{ body: "Likes vintage cameras" }])
  })

  test("drops bullets shorter than 8 characters and non-bullet lines", () => {
    const extracted = ["## Key Facts", "- ok", "Just prose, no bullet marker", "* Has a dog"].join(
      "\n"
    )
    const atoms = splitAtomicMemories(extracted, session())
    expect(atoms).toEqual([{ body: "Has a dog" }])
  })

  test("falls back to session.metadata.date when formattedDate is absent", () => {
    const atoms = splitAtomicMemories("- Started a new job", session({ date: "2026-03-04" }))
    expect(atoms).toEqual([{ body: "(2026-03-04): Started a new job" }])
  })
})

describe("parseRecallOutput", () => {
  test("parses a words query with no kind column", () => {
    const stdout = [
      "e9de50d2cc1c  /vault/inbox/pizza.md",
      "  test fact one about pizza",
      "",
      "ec6657ccb7b5  /vault/inbox/sushi.md",
      "  test fact two about sushi",
      "",
    ].join("\n")
    expect(parseRecallOutput(stdout)).toEqual([
      {
        id: "e9de50d2cc1c",
        path: "/vault/inbox/pizza.md",
        kind: undefined,
        body: "test fact one about pizza",
      },
      {
        id: "ec6657ccb7b5",
        path: "/vault/inbox/sushi.md",
        kind: undefined,
        body: "test fact two about sushi",
      },
    ])
  })

  test("captures the kind column when recall --id prints one", () => {
    const stdout = [
      "48393f8fa0e0  /vault/Reference/decision/48393f8fa0e0-dyno.md  reference/decision",
      "  Ratified: the loop is named dyno.",
      "",
    ].join("\n")
    expect(parseRecallOutput(stdout)).toEqual([
      {
        id: "48393f8fa0e0",
        path: "/vault/Reference/decision/48393f8fa0e0-dyno.md",
        kind: "reference/decision",
        body: "Ratified: the loop is named dyno.",
      },
    ])
  })

  test("skips the trailing 'more not shown' line rather than reading it as a hit", () => {
    const stdout = [
      "e9de50d2cc1c  /vault/inbox/pizza.md",
      "  test fact one about pizza",
      "",
      "5 more not shown; --limit 0 shows them",
    ].join("\n")
    const hits = parseRecallOutput(stdout)
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe("e9de50d2cc1c")
  })

  test("returns no hits for a miss sentence", () => {
    expect(parseRecallOutput('no nug carries "banana"')).toEqual([])
  })

  test("returns no hits for empty output", () => {
    expect(parseRecallOutput("")).toEqual([])
  })

  test("preserves multi-line body text", () => {
    const stdout = ["abc123456789  /vault/inbox/note.md", "  line one", "  line two", ""].join("\n")
    expect(parseRecallOutput(stdout)).toEqual([
      {
        id: "abc123456789",
        path: "/vault/inbox/note.md",
        kind: undefined,
        body: "line one\nline two",
      },
    ])
  })
})

describe("sanitizePath", () => {
  test("keeps alphanumerics, dots, dashes and underscores", () => {
    expect(sanitizePath("locomo-conv-01_v2.json")).toBe("locomo-conv-01_v2.json")
  })

  test("replaces every other character", () => {
    expect(sanitizePath("container tag/with:colons")).toBe("container_tag_with_colons")
  })
})

// One index build per container against the real binary: the files
// nugfile.ts writes are what `mnemd index` takes in, and recall answers from
// them. Skipped where mnemd is not on PATH (CI without the binary).
const MNEMD_BIN = process.env.MNEMD_BIN || "mnemd"
const haveMnemd = Bun.which(MNEMD_BIN) !== null

describe.skipIf(!haveMnemd)("mnemd index takes in the files ingest wrote", () => {
  test("recall finds a batch-written nug after one index", async () => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { writeNugs } = await import("./nugfile")
    const nugbase = await mkdtemp(join(tmpdir(), "mnemd-index-"))
    const [id] = await writeNugs(nugbase, ["Alice adopted a kitten named Milo"], {
      generator: "test",
    })
    const env: Record<string, string | undefined> = { ...process.env, MNEMD_NUGBASE: nugbase }
    delete env.MNEMD_PROJECTS
    delete env.MNEMD_INGEST_CLAUDE_MEMORY
    const run = async (args: string[]) => {
      const proc = Bun.spawn([MNEMD_BIN, ...args], { stdout: "pipe", stderr: "pipe", env })
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return { stdout, code }
    }
    const index = await run(["index"])
    expect(index.code).toBe(0)
    expect(index.stdout).toContain("indexed 1 nug")
    const recall = await run(["recall", "--", "kitten"])
    expect(recall.code).toBe(0)
    const hits = parseRecallOutput(recall.stdout)
    expect(hits.map((h) => h.id)).toEqual([id])
    expect(hits[0].body).toBe("Alice adopted a kitten named Milo")
  })
})
