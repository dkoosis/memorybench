// mn-qgk acceptance: (1) one LongMemEval haystack's mnemd-side ingest —
// nug files + one `mnemd index` — under 10 s; (2) recall answers after batch
// ingest equal those after per-atom `mnemd capture` on a 5-question sample.
//
// Atoms are extracted once per question (the LLM step is shared by both
// paths and held constant), then written into two fresh nugbases: A by one
// `mnemd capture` per atom, B by nugfile.writeNugs + one `mnemd index`. The
// same formulated query is recalled from both and the ordered hit bodies are
// compared.
//
// Usage: OPENAI_API_KEY in .env; bun run bench-harness/mnemd-batch-vs-capture.ts [n=5]
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpenAI } from "@ai-sdk/openai"
import LongMemEvalBenchmark from "../src/benchmarks/longmemeval/index"
import { extractMemories } from "../src/prompts/extraction"
import { splitAtomicMemories, parseRecallOutput } from "../src/providers/mnemd/index"
import { formulateQuery } from "../src/providers/mnemd/formulate"
import { writeNugs } from "../src/providers/mnemd/nugfile"

const MNEMD_BIN = process.env.MNEMD_BIN || "mnemd"
const n = parseInt(process.argv[2] || "5", 10)

async function mnemd(nugbase: string, args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, MNEMD_NUGBASE: nugbase }
  delete env.MNEMD_PROJECTS
  delete env.MNEMD_INGEST_CLAUDE_MEMORY
  const proc = Bun.spawn([MNEMD_BIN, ...args], { stdout: "pipe", stderr: "pipe", env })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`mnemd ${args[0]} exit ${code}: ${stderr || stdout}`)
  return stdout.trim()
}

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })
const bench = new LongMemEvalBenchmark()
await bench.load()
const questions = bench.getQuestions().slice(0, n)

const rows: Record<string, unknown>[] = []
for (const q of questions) {
  const sessions = bench.getHaystackSessions(q.questionId)
  const t0 = performance.now()
  // Extraction with concurrency 10 (the harness runs it sequentially per
  // question; that is the LLM's time, not mnemd's, and is reported apart).
  const atoms: string[] = []
  for (let i = 0; i < sessions.length; i += 10) {
    const batch = sessions.slice(i, i + 10)
    const extracted = await Promise.all(batch.map((s) => extractMemories(openai, s)))
    extracted.forEach((e, j) => {
      for (const a of splitAtomicMemories(e, batch[j])) if (a.body) atoms.push(a.body)
    })
  }
  const extractMs = Math.round(performance.now() - t0)

  // A: per-atom capture, sequential — the pre-mn-qgk provider's path.
  const baseA = await mkdtemp(join(tmpdir(), "mnemd-A-"))
  const t1 = performance.now()
  for (const body of atoms) await mnemd(baseA, ["capture", "--", body])
  const captureMs = Math.round(performance.now() - t1)

  // B: files, then one index.
  const baseB = await mkdtemp(join(tmpdir(), "mnemd-B-"))
  const t2 = performance.now()
  await writeNugs(baseB, atoms, { generator: "memorybench/mnemd-provider (bench)" })
  const writeMs = Math.round(performance.now() - t2)
  const t3 = performance.now()
  const indexOut = await mnemd(baseB, ["index"])
  const indexMs = Math.round(performance.now() - t3)

  const query = await formulateQuery(openai, q.question)
  const recall = async (base: string) =>
    parseRecallOutput(await mnemd(base, ["recall", "--limit", "10", "--", query])).map(
      (h) => h.body
    )
  const [hitsA, hitsB] = await Promise.all([recall(baseA), recall(baseB)])
  const equal = JSON.stringify(hitsA) === JSON.stringify(hitsB)

  rows.push({
    question: q.questionId,
    sessions: sessions.length,
    atoms: atoms.length,
    extractMs,
    captureMs,
    batchMs: writeMs + indexMs,
    writeMs,
    indexMs,
    indexed: indexOut.split("\n")[0],
    hits: hitsA.length,
    recallEqual: equal,
  })
  console.log(JSON.stringify(rows[rows.length - 1]))
  if (!equal) {
    console.log("  A:", hitsA)
    console.log("  B:", hitsB)
  }
  await Promise.all([
    rm(baseA, { recursive: true, force: true }),
    rm(baseB, { recursive: true, force: true }),
  ])
}
console.table(rows)
