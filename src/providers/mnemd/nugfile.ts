import { randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * mn-qgk: write nug files the way `mnemd capture` writes them, without
 * spawning mnemd once per atom. A LongMemEval haystack is ~45 sessions and
 * several hundred atoms; one spawn per atom, each re-noting the inbox for the
 * cache, is the cost that made a 500-question run a 17-hour job. Files are the
 * truth (mnemd ADR 0009) and `mnemd index` is mnemd's one bulk door, so the
 * provider writes files and asks for one index build per container
 * (MnemdProvider.awaitIndexing).
 *
 * Everything here mirrors mnemd's own writer, read from the mnemd repo:
 * internal/nug/nug.go (MintID, Slug, headNode's key order and quoting) and
 * internal/nugbase/nugbase.go (CaptureAs's naming and exclusive create). The
 * shape was confirmed by diffing a file `mnemd capture` wrote against
 * renderNug's output for the same text.
 */

/** Twelve hex characters, random — nug.IDLen; a foreign minter may mint
 * (mnemd ADR 0003). */
export function mintId(): string {
  return randomBytes(6).toString("hex")
}

const SLUG_MAX_LEN = 60

const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

/** Port of nug.Slug: lower-kebab, every non-[a-z0-9] run collapses to one
 * dash, leading/trailing dashes trimmed, at most 60 characters, and a
 * Windows device name gets "-nug". "" means the caller names the file by id. */
export function slug(text: string): string {
  let out = ""
  let lastDash = true
  for (const ch of text.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch
      lastDash = false
    } else if (!lastDash) {
      out += "-"
      lastDash = true
    }
    if (out.length >= SLUG_MAX_LEN) break
  }
  const s = out.replace(/^-+|-+$/g, "")
  return WINDOWS_RESERVED.has(s) ? `${s}-nug` : s
}

export interface NugHead {
  id: string
  kind?: string
  /** RFC 3339 UTC, second precision, e.g. 2026-09-23T01:42:22Z. */
  created: string
  generator: string
}

/** The file bytes: frontmatter in mnemd's order (id, kind, created,
 * generator), each value single-quoted (the id must be — ~5.6% of random hex
 * ids read as a number otherwise, ADR 0003), a blank line, the body, one
 * trailing newline. */
export function renderNug(head: NugHead, body: string): string {
  const lines = ["---", `id: '${head.id}'`]
  if (head.kind) lines.push(`kind: '${head.kind}'`)
  lines.push(`created: '${head.created}'`, `generator: '${head.generator}'`, "---", "", body, "")
  return lines.join("\n")
}

export interface WriteNugsOptions {
  generator: string
  kind?: string
}

/** Same name mnemd's inbox uses. */
export const INBOX_DIR = "inbox"

const NAME_ATTEMPTS = 8

/** Write one nug file per non-empty body under <nugbase>/inbox and return
 * the ids minted, in body order. Names follow CaptureAs: the plain slug
 * first; a taken name gets a fresh id appended; a body with no slug is named
 * by its id alone. Every write is an exclusive create ("wx"), so nothing is
 * ever overwritten. Nothing is indexed here — the caller runs `mnemd index`
 * once when the batch is complete. */
export async function writeNugs(
  nugbase: string,
  bodies: string[],
  options: WriteNugsOptions
): Promise<string[]> {
  const inbox = join(nugbase, INBOX_DIR)
  await mkdir(inbox, { recursive: true })
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
  const ids: string[] = []
  for (const raw of bodies) {
    const body = raw.trim()
    if (!body) continue
    const stem = slug(body)
    let landed = false
    for (let attempt = 0; attempt < NAME_ATTEMPTS && !landed; attempt++) {
      const id = mintId()
      const name = stem === "" ? `${id}.md` : attempt === 0 ? `${stem}.md` : `${stem}-${id}.md`
      const text = renderNug(
        { id, kind: options.kind, created, generator: options.generator },
        body
      )
      try {
        await writeFile(join(inbox, name), text, { flag: "wx" })
        ids.push(id)
        landed = true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
      }
    }
    if (!landed) {
      throw new Error(
        `mnemd: no free name in ${inbox} after ${NAME_ATTEMPTS} attempts for "${stem}"`
      )
    }
  }
  return ids
}
