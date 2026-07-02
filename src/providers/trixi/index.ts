import { mkdir, rm, access, writeFile } from "node:fs/promises"
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
import { generateText } from "ai"
import { extractMemories } from "../../prompts/extraction"
import { TRIXI_PROMPTS } from "./prompts"

const BASE_DIR = join(process.cwd(), "data", "providers", "trixi")
const TRIXI_BIN = process.env.TRIXI_BIN || "trixi"

interface ContainerPaths {
  dir: string
  db: string
  kgRoot: string
  configDir: string
}

function containerPaths(containerTag: string): ContainerPaths {
  const dir = join(BASE_DIR, sanitizePath(containerTag))
  return {
    dir,
    db: join(dir, "trixi.db"),
    kgRoot: join(dir, "kg"),
    configDir: join(dir, "config"),
  }
}

/** `trixi --version` reports `git describe` output when built via `make install`
 * (e.g. "bb6bef25" or "v1.2.3-dirty"), else the literal string "dev". Captured
 * once per provider run and stamped into each new container so a run's results
 * are attributable to a specific trixi commit. */
async function getTrixiVersion(): Promise<string> {
  const proc = Bun.spawn([TRIXI_BIN, "--version"], { stdout: "pipe", stderr: "pipe" })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return exitCode === 0 ? stdout.trim() : "unknown"
}

interface AtomicMemory {
  name: string
  body: string
  /** raw bullet text without the section/date prefix — the search query for
   * the update-decision step (prefix tokens like the session date would match
   * every atom from the same session, drowning the real signal) */
  text: string
}

/** Split MEMORY.md-style extraction output ("## Section" headers + "- " bullets)
 * into self-contained atomic memories. Each bullet is one atom: name = bullet
 * text truncated at a word boundary (drives trixi's name-weighted BM25) plus a
 * per-session uniqueness suffix; body = section-prefixed bullet with session
 * date for temporal grounding. */
function splitAtomicMemories(extracted: string, session: UnifiedSession): AtomicMemory[] {
  const date =
    (session.metadata?.formattedDate as string) || (session.metadata?.date as string) || ""
  const safeId = sanitizePath(session.sessionId)
  const atoms: AtomicMemory[] = []
  let section = ""
  for (const line of extracted.split("\n")) {
    const header = line.match(/^##\s+(.*)/)
    if (header) {
      section = header[1].trim()
      continue
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)/)
    if (!bullet || bullet[1].trim().length < 8) continue
    const text = bullet[1].trim()
    let name = text.length > 80 ? text.slice(0, 80).replace(/\s+\S*$/, "") : text
    name = `${name} (${safeId}#${atoms.length})`
    const context = [section, date && `(${date})`].filter(Boolean).join(" ")
    atoms.push({ name, body: context ? `${context}: ${text}` : text, text })
  }
  return atoms
}

interface UpdateDecision {
  action: "ADD" | "SUPERSEDE" | "NOOP"
  supersedes?: string // real nug id of the memory this atom replaces
}

const DECISION_MODEL = "gpt-4o-mini"

/** decideMemoryUpdates asks the LLM, per new atom, whether it is new
 * information (ADD), replaces an existing memory (SUPERSEDE), or is already
 * known (NOOP) — mem0's classic update step (its DEFAULT_UPDATE_MEMORY_PROMPT
 * shape) with trixi's supersede-not-delete twist. Existing memories are
 * presented under integer ids (anti-hallucination: the model can only pick
 * from the enumerated list); the mapping back to real ids happens here.
 * Any parse failure degrades to ADD-everything — ingest must never fail on a
 * malformed decision. */
async function decideMemoryUpdates(
  openai: NonNullable<TrixiProvider["openai"]>,
  existing: ExistingMemory[],
  atoms: AtomicMemory[]
): Promise<UpdateDecision[]> {
  const addAll = atoms.map((): UpdateDecision => ({ action: "ADD" }))
  if (existing.length === 0 || atoms.length === 0) return addAll

  // Bodies, not names: atom names truncate at 80 chars, which routinely cuts
  // the changed value the model must compare ("...league with a record of").
  const existingList = existing.map((m, i) => `${i}: ${m.body}`).join("\n")
  const atomList = atoms.map((a, i) => `${i}: ${a.body}`).join("\n")

  const prompt = `You manage a memory store. Compare each NEW memory against the EXISTING memories and decide, for each new memory:
- "ADD": genuinely new information, no existing memory covers it
- "SUPERSEDE": it updates/contradicts/replaces an existing memory (the old one becomes stale) — include that existing memory's integer id as "supersedes"
- "NOOP": the information is already fully present in an existing memory

EXISTING memories:
${existingList}

NEW memories:
${atomList}

Rules:
- SUPERSEDE only on a real update or contradiction (changed value, new state of the same fact). Merely related topics are ADD.
- "supersedes" must be one of the EXISTING integer ids shown above. Never invent ids.
- When unsure, prefer ADD (losing an update is worse than a duplicate).

Respond with ONLY a JSON array, one object per NEW memory in order:
[{"action":"ADD"},{"action":"SUPERSEDE","supersedes":3},{"action":"NOOP"}, ...]`

  try {
    const { text } = await generateText({
      model: openai(DECISION_MODEL),
      prompt,
      maxTokens: 1500,
      temperature: 0,
    } as Parameters<typeof generateText>[0])
    const cleaned = text.replace(/```json|```/g, "").trim()
    const raw = JSON.parse(cleaned) as Array<{ action?: string; supersedes?: number | string }>
    if (!Array.isArray(raw)) return addAll
    return atoms.map((_, i): UpdateDecision => {
      const d = raw[i]
      if (!d || d.action === "ADD" || (d.action !== "SUPERSEDE" && d.action !== "NOOP")) {
        return { action: "ADD" }
      }
      if (d.action === "NOOP") return { action: "NOOP" }
      const idx = Number(d.supersedes)
      if (!Number.isInteger(idx) || idx < 0 || idx >= existing.length) {
        return { action: "ADD" } // invalid pointer → safest is ADD
      }
      return { action: "SUPERSEDE", supersedes: existing[idx].id }
    })
  } catch (error) {
    logger.warn(`Update decision failed, defaulting to ADD-all: ${error}`)
    return addAll
  }
}

/** Cap on the existing-memories list handed to the decision LLM. */
const MAX_EXISTING = 20

/** Subprocess concurrency for per-atom searches / candidate fetches. Unbounded
 * Promise.all raced schema DDL on a fresh container DB (SQLITE_BUSY). */
const TRIXI_CONCURRENCY = 4

/** mapLimit runs fn over items with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

interface ExistingMemory {
  id: string
  name: string
  body: string
}

/** searchExistingAtoms surfaces existing ATOMS in the container relevant to
 * this session's atoms: one short hybrid search per atom, unioned, bodies
 * fetched for the decision prompt.
 *
 * Per-atom (not one joined query) because a knowledge update often shares few
 * tokens with the fact it replaces ("moved to Chicago" vs "lives in Boston") —
 * a joined multi-topic query dies on trixi's FTS overlap post-filter
 * (ceil(n/2) tokens required) and averages into a mushy single embedding.
 * Short per-atom queries let hybrid search (FTS + semantic fallback) surface
 * the specific stale fact. Semantic works mid-ingest because ingest()
 * syncs+embeds after every session (see below).
 *
 * Scoped to the `atom` tag: session-summary nugs contain every topic, so they
 * dominate any similarity query, and their names ("<sessionId>") give the
 * decision LLM nothing to compare. Bodies are fetched because atom names
 * truncate at 80 chars — often exactly the changed value falls off the end. */
async function searchExistingAtoms(
  paths: ContainerPaths,
  tag: string,
  atoms: AtomicMemory[]
): Promise<ExistingMemory[]> {
  const perAtom = await mapLimit(atoms, TRIXI_CONCURRENCY, async (atom) => {
    const query = atom.text.slice(0, 300)
    if (!query.trim()) return []
    try {
      const stdout = await runTrixi(paths, [
        "search",
        query,
        `--tag=${tag}`,
        "--tag=atom",
        "--json",
        "--limit=3",
      ])
      return stdout ? (JSON.parse(stdout) as Array<{ id: string; name: string }>) : []
    } catch (error) {
      logger.warn(`Existing-atom search failed, treating as empty: ${error}`)
      return []
    }
  })
  const seen = new Map<string, { id: string; name: string }>()
  for (const hit of perAtom.flat()) {
    if (!seen.has(hit.id)) seen.set(hit.id, hit)
    if (seen.size >= MAX_EXISTING) break
  }
  const candidates = [...seen.values()]
  return (
    await mapLimit(candidates, TRIXI_CONCURRENCY, async (c): Promise<ExistingMemory | null> => {
      try {
        const raw = await runTrixi(paths, ["get", c.id, "--json"])
        const nug = JSON.parse(raw) as { body?: string }
        return { ...c, body: (nug.body ?? c.name).slice(0, 300) }
      } catch (error) {
        logger.warn(`Candidate body fetch failed for ${c.id}: ${error}`)
        return { ...c, body: c.name }
      }
    })
  ).filter((c): c is ExistingMemory => c !== null)
}

async function runTrixi(paths: ContainerPaths, args: string[]): Promise<string> {
  const proc = Bun.spawn(
    [TRIXI_BIN, "--db", paths.db, "--kg-root", paths.kgRoot, "--config", paths.configDir, ...args],
    { stdout: "pipe", stderr: "pipe" }
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`trixi ${args[0]} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`)
  }
  return stdout.trim()
}

/**
 * Trixi Memory Provider
 *
 * Stores extracted memories as `reference` nugs in a Trixi knowledge graph
 * (one isolated kg-root + SQLite store per benchmark container), tagged with
 * the containerTag for scoping. Search shells out to `trixi search` (hybrid
 * lexical/semantic via Voyage embeddings) then fetches bodies via `trixi get`.
 *
 * Uses the same LLM extraction step as the filesystem/rag providers so the
 * comparison isolates the storage/retrieval engine, not the extraction prompt.
 */
export class TrixiProvider implements Provider {
  name = "trixi"
  prompts = TRIXI_PROMPTS
  concurrency = {
    default: 10,
    ingest: 10,
    indexing: 10,
    search: 10,
  }

  private openai: ReturnType<typeof createOpenAI> | null = null
  private initialized = new Set<string>()
  private trixiVersion: string | null = null

  async initialize(config: ProviderConfig): Promise<void> {
    if (!config.apiKey || config.apiKey === "none") {
      throw new Error("Trixi provider requires OPENAI_API_KEY for memory extraction")
    }
    this.openai = createOpenAI({ apiKey: config.apiKey })
    this.trixiVersion = await getTrixiVersion()
    logger.info(`Initialized Trixi memory provider (nug store, trixi ${this.trixiVersion})`)
  }

  private async ensureContainer(containerTag: string): Promise<ContainerPaths> {
    const paths = containerPaths(containerTag)
    if (this.initialized.has(containerTag)) return paths

    await mkdir(paths.kgRoot, { recursive: true })
    await mkdir(paths.configDir, { recursive: true })

    const alreadyInitialized = await access(join(paths.kgRoot, "reference"))
      .then(() => true)
      .catch(() => false)
    if (!alreadyInitialized) {
      await runTrixi(paths, ["init"])
      await writeFile(join(paths.dir, "trixi-version.txt"), this.trixiVersion ?? "unknown")
    }
    this.initialized.add(containerTag)
    return paths
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.openai) throw new Error("Provider not initialized")
    const openai = this.openai
    const paths = await this.ensureContainer(options.containerTag)

    const documentIds: string[] = []
    for (const session of sessions) {
      const extractedMemories = await extractMemories(openai, session)
      const safeId = sanitizePath(session.sessionId)
      const tag = sanitizePath(options.containerTag)

      // Storage granularity is trixi's policy (extraction stays shared across
      // providers for comparability): store each extracted bullet as its own
      // atomic nug so specific facts are individually retrievable — one
      // summary blob per session buries exact dates/counts under one averaged
      // embedding. The full summary is kept too as an aggregation target.
      const atoms = splitAtomicMemories(extractedMemories, session)

      // E4 (tx-2fvm6): update semantics at ingest. Later sessions can update
      // facts from earlier ones ("moved to Chicago" after "lives in Boston");
      // without a decision step both atoms coexist and compete at retrieval.
      // Per-atom candidate searches + one LLM decision per session (mem0's
      // classic ADD/UPDATE step); contradicted memories are SUPERSEDED via
      // `trixi supersede` — invalidate-don't-delete, search decay demotes
      // them below their replacements.
      const existing = await searchExistingAtoms(paths, tag, atoms)
      const decisions = await decideMemoryUpdates(openai, existing, atoms)

      for (let i = 0; i < atoms.length; i++) {
        const atom = atoms[i]
        const decision = decisions[i] ?? { action: "ADD" }
        if (decision.action === "NOOP") continue
        // --flag=value form: extracted bullets can begin with "-"/"--"
        // (e.g. "--seed accepts whole numbers..."), which kong would parse as
        // a flag in the two-token form.
        // `atom` tag distinguishes atomic facts from session summaries so the
        // update-decision search can scope to atoms (summaries contain every
        // topic and would dominate any similarity query).
        const id = await runTrixi(paths, [
          "create",
          "reference",
          `--name=${atom.name}`,
          `--body=${atom.body}`,
          `--tags=${tag},atom`,
        ])
        documentIds.push(id)
        if (decision.action === "SUPERSEDE" && decision.supersedes) {
          try {
            await runTrixi(paths, ["supersede", decision.supersedes, `--by=${id}`])
          } catch (error) {
            logger.warn(`Supersede ${decision.supersedes} by ${id} failed: ${error}`)
          }
        }
      }

      const id = await runTrixi(paths, [
        "create",
        "reference",
        `--name=${safeId}`,
        `--body=${extractedMemories}`,
        `--tags=${tag}`,
      ])
      logger.debug(
        `Created trixi session nug ${id} + ${atoms.length} atoms for session ${session.sessionId}`
      )
      documentIds.push(id)
    }

    // Make this batch's atoms visible to the NEXT session's update-decision
    // search — sync for FTS, embed for the semantic channel (paraphrase
    // updates share almost no tokens with the fact they replace, so FTS alone
    // misses them). embed is incremental (hash-skip on already-embedded nugs),
    // so per-session calls don't re-embed the container; awaitIndexing's final
    // pass becomes a cheap no-op. Best-effort: on failure the decision search
    // degrades to FTS-only rather than failing ingest.
    try {
      await runTrixi(paths, ["sync"])
      await runTrixi(paths, ["embed"])
    } catch (error) {
      logger.warn(`Per-session sync/embed failed (decision search degrades to FTS): ${error}`)
    }

    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    const paths = containerPaths(containerTag)
    await runTrixi(paths, ["sync"])
    await runTrixi(paths, ["embed"])
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const paths = containerPaths(options.containerTag)
    const limit = options.limit || 10

    const stdout = await runTrixi(paths, [
      "search",
      query,
      "--tag",
      sanitizePath(options.containerTag),
      "--json",
      "--limit",
      String(limit),
    ])
    const hits = stdout ? (JSON.parse(stdout) as Array<{ id: string; name: string }>) : []
    if (hits.length === 0) return []

    return Promise.all(
      hits.map(async (hit) => {
        const raw = await runTrixi(paths, ["get", hit.id, "--json"])
        const nug = JSON.parse(raw) as { id: string; name: string; body: string }
        return { id: nug.id, name: nug.name, body: nug.body }
      })
    )
  }

  async clear(containerTag: string): Promise<void> {
    const paths = containerPaths(containerTag)
    try {
      await rm(paths.dir, { recursive: true, force: true })
      this.initialized.delete(containerTag)
      logger.info(`Cleared trixi data for: ${containerTag}`)
    } catch (e) {
      logger.warn(`Failed to clear trixi data: ${e}`)
    }
  }
}

/** Sanitize a string for safe use as a filesystem path component / trixi tag */
function sanitizePath(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

export default TrixiProvider
