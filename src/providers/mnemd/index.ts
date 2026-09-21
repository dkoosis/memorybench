import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { createOpenAI } from "@ai-sdk/openai"
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { extractMemories } from "../../prompts/extraction"
import { MNEMD_PROMPTS } from "./prompts"
import { formulateQuery } from "./formulate"

const BASE_DIR = join(process.cwd(), "data", "providers", "mnemd")
const MNEMD_BIN = process.env.MNEMD_BIN || "mnemd"

/** One container is one mnemd nugbase directory. mnemd has no default
 * nugbase at all — every verb refuses without `--nugbase` or `$MNEMD_NUGBASE`
 * (mnemd --help) — which is a stronger guarantee than itzy's (itzy falls back
 * to dk's real vault when its env var is unset). This provider still sets the
 * env explicitly on every spawn, never relying on that refusal as the only
 * guard. */
function nugbasePath(containerTag: string): string {
  return join(BASE_DIR, sanitizePath(containerTag), "nugbase")
}

interface AtomicMemory {
  body: string
}

/** Split MEMORY.md-style extraction output ("## Section" headers + "- "
 * bullets) into self-contained atomic memories — the same split the itzy and
 * trixi providers perform, and deliberately so: extraction and granularity
 * are held constant across providers so a leaderboard difference is the
 * storage/retrieval engine, not the prompt that fed it.
 *
 * Body carries the session date and nothing else structural — mnemd's own
 * recall is lexical over the stored text (a plain word match, not a ranked
 * embedding), so a repeated section label would be noise in the scored
 * channel exactly as it is for itzy. */
export function splitAtomicMemories(extracted: string, session: UnifiedSession): AtomicMemory[] {
  const date =
    (session.metadata?.formattedDate as string) || (session.metadata?.date as string) || ""
  const atoms: AtomicMemory[] = []
  for (const line of extracted.split("\n")) {
    if (/^##\s+/.test(line)) continue
    const bullet = line.match(/^\s*[-*]\s+(.*)/)
    if (!bullet || bullet[1].trim().length < 8) continue
    const text = bullet[1].trim()
    atoms.push({ body: date ? `(${date}): ${text}` : text })
  }
  return atoms
}

export interface RecallHit {
  id: string
  path: string
  kind?: string
  body: string
}

/** mnemd has no `--json` on recall (mnemd --help): a hit is four lines —
 * "id  path[  kind]", the body indented two spaces per line, then a blank
 * line — and the whole output ends with an optional un-indented
 * "N more not shown; --limit 0 shows them" line this parser must not mistake
 * for a hit. A miss prints a plain "no nug carries ..." sentence with no
 * double-space header, which the same guard skips.
 *
 * Read cmd/mnemd/main.go's recall() (mnemd repo) for the exact shape this
 * mirrors: id and path are always double-space separated, kind is a third
 * double-space field only a words query ever omits, and every body line is
 * reprinted with its two-space indent intact (never truncated — recall's own
 * comment: "a preview would drop the part dk came back for"). */
export function parseRecallOutput(stdout: string): RecallHit[] {
  const hits: RecallHit[] = []
  const blocks = stdout.split("\n\n")
  for (const block of blocks) {
    const lines = block.split("\n")
    const header = lines[0] ?? ""
    const cols = header.split("  ").filter((c) => c.length > 0)
    if (cols.length < 2) continue
    const [id, path, kind] = cols
    const body = lines
      .slice(1)
      .map((l) => (l.startsWith("  ") ? l.slice(2) : l))
      .join("\n")
      .trim()
    hits.push({ id, path, kind, body })
  }
  return hits
}

async function runMnemd(
  nugbase: string,
  args: string[],
  stdin?: string
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  const proc = Bun.spawn([MNEMD_BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    env: { ...process.env, MNEMD_NUGBASE: nugbase },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trim(), exitCode, stderr: stderr.trim() }
}

/**
 * mnemd Memory Provider
 *
 * Stores each extracted memory as a nug in an isolated mnemd nugbase (one
 * directory per benchmark container) and answers with `mnemd recall`.
 *
 * ‡ WRITES AND READS GO THROUGH THE CLI ONLY (bead mn-a5e, Rules). mnemd has
 * no batch-capture verb the way `itzy nug --batch` does, so ingest pays one
 * spawn per atom rather than one per session — the CLI mnemd ships today has
 * no cheaper door.
 *
 * ‡ ATOMS ONLY, no session-summary nug — mirrors itzy's choice and for the
 * same reason: mnemd's recall is a lexical word match over stored text
 * (mnemd --help: "find nugs whose text carries those words"), so a
 * whole-session summary would carry many times an atom's matching terms and
 * outrank the atom that actually answers the question.
 *
 * ‡ EVERY CAPTURE/RECALL ARGUMENT CROSSES `--` (mnemd --help: "Flags go
 * before the words; -- ends them, so after -- a word may start with a
 * dash."). An extracted bullet routinely starts with "-" (e.g. "--seed
 * accepts whole numbers only", the exact case itzy/trixi's comments call
 * out) and mnemd parses that as an unknown flag without the terminator —
 * confirmed by spawning `mnemd capture` both ways against a scratch nugbase.
 */
export class MnemdProvider implements Provider {
  name = "mnemd"
  prompts = MNEMD_PROMPTS
  /** Matched to itzy's and trixi's: shells out to a local binary, so the
   * ceiling is this machine's cores and fsync, not a remote rate limit. */
  concurrency = {
    default: 10,
    ingest: 10,
    indexing: 10,
    search: 10,
  }

  private openai: ReturnType<typeof createOpenAI> | null = null
  private mnemdVersion: string | null = null

  async initialize(config: ProviderConfig): Promise<void> {
    if (!config.apiKey || config.apiKey === "none") {
      throw new Error("mnemd provider requires OPENAI_API_KEY for memory extraction")
    }
    this.openai = createOpenAI({ apiKey: config.apiKey })
    // `mnemd version` needs no nugbase; a throwaway path is passed only
    // because runMnemd always sets one, never because this call reads it.
    const { stdout, exitCode } = await runMnemd(join(BASE_DIR, "_version"), ["version"])
    this.mnemdVersion = exitCode === 0 ? stdout : "unknown"
    logger.info(`Initialized mnemd memory provider (nugbase store, ${this.mnemdVersion})`)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.openai) throw new Error("Provider not initialized")
    const nugbase = nugbasePath(options.containerTag)
    await mkdir(nugbase, { recursive: true })

    const documentIds: string[] = []
    for (const session of sessions) {
      const extracted = await extractMemories(this.openai, session)
      const atoms = splitAtomicMemories(extracted, session)
      let failed = 0
      for (const atom of atoms) {
        if (!atom.body) continue
        const { stdout, exitCode, stderr } = await runMnemd(nugbase, ["capture", "--", atom.body])
        // capture prints "<id>  <path>" on success, even in the rare
        // held-but-not-durable case (cmd/mnemd/main.go reportCapture), so a
        // parseable line on stdout is success whatever the exit code says.
        const id = stdout.split("  ")[0]?.trim()
        if (id && /^[0-9a-f]+$/.test(id)) {
          documentIds.push(id)
        } else {
          failed++
          logger.warn(
            `mnemd capture failed for an atom of ${session.sessionId} (exit ${exitCode}): ${stderr || stdout}`
          )
        }
      }
      if (failed > 0) {
        logger.warn(
          `mnemd: ${failed}/${atoms.length} atom(s) failed to capture for ${session.sessionId}`
        )
      }
      logger.debug(
        `mnemd captured ${atoms.length - failed}/${atoms.length} record(s) for session ${session.sessionId}`
      )
    }

    return { documentIds }
  }

  /** Nothing to wait for: `mnemd capture` returns once the nug is durable,
   * and recall's cache is rebuilt cold on demand when it has not seen a
   * write (reportFreshness in cmd/mnemd/main.go). The callback still fires
   * so the harness's progress tracker completes. */
  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  /** mn-cw8: formulate before recall. The benchmark hands search() the raw
   * question; a real mnemd caller is an agent that turns dk's intent into
   * query words first (see formulate.ts). Formulation failure falls back to
   * the raw question rather than aborting the search phase. */
  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.openai) throw new Error("Provider not initialized")
    const nugbase = nugbasePath(options.containerTag)
    // Limit 10, matching the harness's retrieval_k and itzy/trixi's tuned
    // value.
    const limit = options.limit || 10
    const formulated = await formulateQuery(this.openai, query)
    const { stdout, exitCode, stderr } = await runMnemd(nugbase, [
      "recall",
      "--limit",
      String(limit),
      "--",
      formulated,
    ])
    if (exitCode !== 0) {
      throw new Error(`mnemd recall failed (exit ${exitCode}): ${stderr || stdout}`)
    }
    return parseRecallOutput(stdout).map((hit) => ({
      id: hit.id,
      name: hit.path,
      body: hit.body,
    }))
  }

  async clear(containerTag: string): Promise<void> {
    const dir = join(BASE_DIR, sanitizePath(containerTag))
    try {
      await rm(dir, { recursive: true, force: true })
      logger.info(`Cleared mnemd data for: ${containerTag}`)
    } catch (e) {
      logger.warn(`Failed to clear mnemd data: ${e}`)
    }
  }
}

/** Sanitize a string for safe use as a filesystem path component. */
export function sanitizePath(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

export default MnemdProvider
