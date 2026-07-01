import { mkdir, rm, access } from "node:fs/promises"
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

  async initialize(config: ProviderConfig): Promise<void> {
    if (!config.apiKey || config.apiKey === "none") {
      throw new Error("Trixi provider requires OPENAI_API_KEY for memory extraction")
    }
    this.openai = createOpenAI({ apiKey: config.apiKey })
    logger.info("Initialized Trixi memory provider (nug store with LLM extraction)")
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
      const id = await runTrixi(paths, [
        "create",
        "reference",
        "--name",
        safeId,
        "--body",
        extractedMemories,
        "--tags",
        sanitizePath(options.containerTag),
      ])
      logger.debug(`Created trixi nug ${id} for session ${session.sessionId}`)
      documentIds.push(id)
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
