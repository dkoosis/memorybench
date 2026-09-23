import { describe, test, expect } from "bun:test"
import { mkdtemp, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mintId, slug, renderNug, writeNugs } from "./nugfile"

describe("mintId", () => {
  test("is twelve lowercase hex characters, like mnemd's own ids", () => {
    const id = mintId()
    expect(id).toMatch(/^[0-9a-f]{12}$/)
    expect(mintId()).not.toBe(id)
  })
})

describe("slug", () => {
  test("lower-kebabs text the way mnemd names a captured nug", () => {
    expect(slug("Alice adopted a kitten named Milo")).toBe("alice-adopted-a-kitten-named-milo")
    expect(slug("(2026-01-02): Bob works as a marine biologist")).toBe(
      "2026-01-02-bob-works-as-a-marine-biologist"
    )
  })

  test("collapses runs of non-alphanumerics and trims the ends", () => {
    expect(slug("--seed accepts: whole numbers!! only")).toBe("seed-accepts-whole-numbers-only")
    expect(slug("***")).toBe("")
  })

  test("caps at 60 characters", () => {
    expect(slug("a".repeat(100)).length).toBe(60)
  })

  test("suffixes a Windows-reserved stem", () => {
    expect(slug("CON")).toBe("con-nug")
  })
})

describe("renderNug", () => {
  test("writes the frontmatter mnemd capture writes: id, created, generator, single-quoted", () => {
    const text = renderNug(
      { id: "c2257607f53d", created: "2026-09-23T01:42:22Z", generator: "memorybench/mnemd 1.0" },
      "Alice adopted a kitten named Milo"
    )
    expect(text).toBe(
      [
        "---",
        "id: 'c2257607f53d'",
        "created: '2026-09-23T01:42:22Z'",
        "generator: 'memorybench/mnemd 1.0'",
        "---",
        "",
        "Alice adopted a kitten named Milo",
        "",
      ].join("\n")
    )
  })

  test("carries a kind when given one, between id and created", () => {
    const text = renderNug(
      {
        id: "0c2050313815",
        kind: "raw/capture",
        created: "2026-09-23T01:42:22Z",
        generator: "g",
      },
      "body"
    )
    expect(text.split("\n").slice(0, 5)).toEqual([
      "---",
      "id: '0c2050313815'",
      "kind: 'raw/capture'",
      "created: '2026-09-23T01:42:22Z'",
      "generator: 'g'",
    ])
  })
})

describe("writeNugs", () => {
  test("writes one file per body under inbox/ and returns their ids", async () => {
    const nugbase = await mkdtemp(join(tmpdir(), "mnemd-nugfile-"))
    const ids = await writeNugs(nugbase, ["Alice adopted a kitten named Milo", "Bob likes tea"], {
      generator: "test",
    })
    expect(ids).toHaveLength(2)
    const files = (await readdir(join(nugbase, "inbox"))).sort()
    expect(files).toEqual(["alice-adopted-a-kitten-named-milo.md", "bob-likes-tea.md"])
    const text = await readFile(join(nugbase, "inbox", "bob-likes-tea.md"), "utf8")
    expect(text).toContain(`id: '${ids[1]}'`)
    expect(text.endsWith("\n\nBob likes tea\n")).toBe(true)
  })

  test("a taken name gets the id appended, never overwritten", async () => {
    const nugbase = await mkdtemp(join(tmpdir(), "mnemd-nugfile-"))
    const first = await writeNugs(nugbase, ["Same words"], { generator: "test" })
    const second = await writeNugs(nugbase, ["Same words"], { generator: "test" })
    const files = (await readdir(join(nugbase, "inbox"))).sort()
    expect(files).toEqual(["same-words.md", `same-words-${second[0]}.md`].sort())
    const kept = await readFile(join(nugbase, "inbox", "same-words.md"), "utf8")
    expect(kept).toContain(`id: '${first[0]}'`)
  })

  test("a body with no slug is named by its id", async () => {
    const nugbase = await mkdtemp(join(tmpdir(), "mnemd-nugfile-"))
    const [id] = await writeNugs(nugbase, ["***"], { generator: "test" })
    expect(await readdir(join(nugbase, "inbox"))).toEqual([`${id}.md`])
  })

  test("skips empty bodies", async () => {
    const nugbase = await mkdtemp(join(tmpdir(), "mnemd-nugfile-"))
    const ids = await writeNugs(nugbase, ["", "   ", "kept"], { generator: "test" })
    expect(ids).toHaveLength(1)
  })
})
