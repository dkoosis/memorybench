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
import { ITZY_PROMPTS } from "./prompts"

const BASE_DIR = join(process.cwd(), "data", "providers", "itzy")
const ITZY_BIN = process.env.ITZY_BIN || "itzy"

/** One container is one itzy vault directory. itzy's store IS the folder of
 * markdown files (ratified: vault files are the authority, `.itzy/` is a
 * rebuildable index), so the directory boundary is the whole of the isolation
 * — there is no container tag to stamp on anything, exactly as the trixi
 * provider found for its per-container SQLite file. */
function vaultPath(containerTag: string): string {
  return join(BASE_DIR, sanitizePath(containerTag), "vault")
}

interface AtomicMemory {
  name: string
  body: string
}

/** Split MEMORY.md-style extraction output ("## Section" headers + "- "
 * bullets) into self-contained atomic memories — the same split the trixi
 * provider performs, and deliberately so: extraction and granularity are held
 * constant across providers so a leaderboard difference is the storage and
 * retrieval engine, not the prompt that fed it.
 *
 * Body carries the session date and nothing else structural. itzy's ranker is
 * lexical over the stored text, so a repeated section label ("Key Facts") on
 * every atom would be pure noise in the scored channel. */
function splitAtomicMemories(extracted: string, session: UnifiedSession): AtomicMemory[] {
  const date =
    (session.metadata?.formattedDate as string) || (session.metadata?.date as string) || ""
  const safeId = sanitizePath(session.sessionId)
  const atoms: AtomicMemory[] = []
  for (const line of extracted.split("\n")) {
    if (/^##\s+/.test(line)) continue
    const bullet = line.match(/^\s*[-*]\s+(.*)/)
    if (!bullet || bullet[1].trim().length < 8) continue
    const text = bullet[1].trim()
    let name = text.length > 80 ? text.slice(0, 80).replace(/\s+\S*$/, "") : text
    name = `${name} (${safeId}#${atoms.length})`
    atoms.push({ name, body: date ? `(${date}): ${text}` : text })
  }
  return atoms
}

interface BatchResult {
  paths?: string[]
  error?: string
}

/** runItzy spawns the binary against one container's vault.
 *
 * HOME is left alone (itzy writes no per-user telemetry the way trixi does),
 * but ITZY_VAULT_PATH is the whole isolation and must be set on every call —
 * an unset one resolves to ~/Projects/kg, i.e. dk's real vault. That is the
 * one mistake in this provider that would be silent and destructive, so the
 * env is built here and never at a call site. */
async function runItzy(
  vault: string,
  args: string[],
  stdin?: string
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  const proc = Bun.spawn([ITZY_BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    env: { ...process.env, ITZY_VAULT_PATH: vault },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trim(), exitCode, stderr: stderr.trim() }
}

/**
 * Itzy Memory Provider
 *
 * Stores each extracted memory as a nug in an isolated itzy vault (one
 * directory per benchmark container) and answers with `itzy ask`.
 *
 * ‡ WRITES GO THROUGH THE PRODUCT'S WRITE DOOR, NOT THROUGH THIS FILE.
 * `itzy nug --batch` runs every record through `memory.Retain`, which is what
 * gives each atom the evidence-keyed filename, the claim marker, the dedupe
 * and the frontmatter a real capture gets. Writing markdown into the vault
 * from TypeScript would have been faster to build and would have measured
 * this provider's file writer instead of itzy's write path.
 *
 * ‡ ONE SPAWN PER SESSION, NOT PER ATOM. Retain lives on an opened KG, so
 * every invocation pays a full cold vault walk; the batch door pays it once
 * for a whole session's atoms. Measured cost of that walk on a container-sized
 * vault (500 nugs) is ~0.28s, which is why one-spawn-per-session is affordable
 * and one-spawn-per-atom is not.
 *
 * ‡ WHAT THIS RUN MEASURES, PRECISELY. itzy's adopted ranker is
 * `NewShadowNoSupersedeFPDemote`, but its situational term is inert on a
 * cold-walked vault: the walk stamps an empty Fingerprint, so every overlap
 * count ties at zero (internal/memory/shadowfp.go:85-92, tracked as iz-1d2.21).
 * Ingest and search are separate processes here, as they are for a human
 * running `itzy recall`, so this benchmark measures the shadow-no-supersede
 * line — which is exactly what the shipped CLI gives today. Re-run after
 * iz-1d2.21 lands to price the situational term.
 */
export class ItzyProvider implements Provider {
  name = "itzy"
  prompts = ITZY_PROMPTS
  /** Matched to trixi's: both shell out to a local binary, so the ceiling is
   * this machine's cores and fsync, not a remote rate limit. */
  concurrency = {
    default: 10,
    ingest: 10,
    indexing: 10,
    search: 10,
  }

  private openai: ReturnType<typeof createOpenAI> | null = null
  private itzyVersion: string | null = null

  async initialize(config: ProviderConfig): Promise<void> {
    if (!config.apiKey || config.apiKey === "none") {
      throw new Error("Itzy provider requires OPENAI_API_KEY for memory extraction")
    }
    this.openai = createOpenAI({ apiKey: config.apiKey })
    // Stamped so a run's results are attributable to a specific itzy build —
    // the binary is version-stamped by `make build`.
    const { stdout, exitCode } = await runItzy(join(BASE_DIR, "_version"), ["--version"])
    this.itzyVersion = exitCode === 0 ? stdout : "unknown"
    // `itzy --version` already prints its own name, so this logs the string
    // verbatim rather than prefixing "itzy" onto "itzy d960951-dirty".
    logger.info(`Initialized Itzy memory provider (vault store, ${this.itzyVersion})`)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.openai) throw new Error("Provider not initialized")
    const vault = vaultPath(options.containerTag)
    await mkdir(vault, { recursive: true })

    const documentIds: string[] = []
    for (const session of sessions) {
      const extracted = await extractMemories(this.openai, session)
      const atoms = splitAtomicMemories(extracted, session)
      // ‡ ATOMS ONLY — no session-summary record, which is where this provider
      // parts company with trixi's, deliberately and for two measured reasons.
      // itzy ranks lexically, so a whole-session summary carries many times an
      // atom's matching terms and outranks the atom that actually answers the
      // question: the first smoke run retrieved the summary at rank 1 for
      // "how long have I been collecting vintage cameras" and the dated atom
      // not at all. And `itzy ask` caps an inline excerpt at 1200 bytes
      // (internal/kg/envelope.go:75), which a summary exceeds — so it arrived
      // truncated mid-sentence, and its bullets carry no per-fact date for the
      // answer prompt's timeline to read. Storing it cost retrieval quality
      // and delivered a partial record. Extraction stays shared; granularity
      // is provider policy, and itzy's is the atom.
      const records = atoms.map((a) => a.body).filter((c) => c.length > 0)
      if (records.length === 0) continue

      const jsonl = records.map((content) => JSON.stringify({ content })).join("\n") + "\n"
      const { stdout, exitCode, stderr } = await runItzy(vault, ["nug", "--batch"], jsonl)

      // Exit 1 means SOME record failed, never that none landed — the good
      // ones are on disk and named in the output. Parsing the results is how
      // this provider learns which, so it parses before it judges the code.
      const results: BatchResult[] = stdout
        ? stdout
            .split("\n")
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l) as BatchResult)
        : []
      const failed = results.filter((r) => r.error)
      if (failed.length > 0) {
        logger.warn(
          `itzy batch: ${failed.length}/${results.length} record(s) failed for ${session.sessionId}: ${failed[0].error}`
        )
      }
      if (results.length === 0 && exitCode !== 0) {
        throw new Error(
          `itzy nug --batch failed for ${session.sessionId}: ${stderr || "no output"}`
        )
      }
      // A deduped write names the file an earlier record wrote, so the same
      // path can appear twice; the id set is what the harness counts.
      for (const r of results) for (const p of r.paths ?? []) documentIds.push(p)
      logger.debug(
        `itzy retained ${results.length - failed.length}/${records.length} record(s) for session ${session.sessionId}`
      )
    }

    return { documentIds }
  }

  /** Nothing to wait for: `itzy nug --batch` returns once every record is
   * durable, and the index a query builds is built cold from those files. The
   * callback still fires so the harness's progress tracker completes. */
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

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const vault = vaultPath(options.containerTag)
    // Limit 10, matching the harness's retrieval_k and trixi's tuned value —
    // itzy's own CLI default is already 10 for the same reason (recall.go).
    const limit = options.limit || 10
    const { stdout, exitCode, stderr } = await runItzy(vault, [
      "ask",
      query,
      "--nugs",
      "--full",
      "--json",
      "--limit",
      String(limit),
    ])
    if (exitCode !== 0) {
      throw new Error(`itzy ask failed (exit ${exitCode}): ${stderr || stdout}`)
    }
    const parsed = stdout
      ? (JSON.parse(stdout) as {
          results: Array<{ source: string; id: string; name: string; excerpt?: string }>
        })
      : { results: [] }
    return (parsed.results ?? [])
      .filter((hit) => hit.source === "nug")
      .map((hit) => ({ id: hit.id, name: hit.name, body: hit.excerpt ?? "" }))
  }

  async clear(containerTag: string): Promise<void> {
    const dir = join(BASE_DIR, sanitizePath(containerTag))
    try {
      await rm(dir, { recursive: true, force: true })
      logger.info(`Cleared itzy data for: ${containerTag}`)
    } catch (e) {
      logger.warn(`Failed to clear itzy data: ${e}`)
    }
  }
}

/** Sanitize a string for safe use as a filesystem path component. */
function sanitizePath(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

export default ItzyProvider
