#!/usr/bin/env bun
/**
 * pooled-mcnemar.ts — pooled exact-McNemar analysis for MemoryBench replicate pairs.
 *
 * Read-only over data/runs/<runId>/report.json. No writes, no deps beyond bun + node stdlib.
 *
 * Usage:
 *   bun run pooled-mcnemar.ts --ctl <ctlRun[,ctlRun...]> --trt <trtRun[,trtRun...]>
 *
 * Example (3 replicate pairs):
 *   bun run pooled-mcnemar.ts \
 *     --ctl trixi123-rep1-ctl,trixi125-rep2-ctl,trixi127-rep3-ctl \
 *     --trt trixi124-rep1-w08,trixi126-rep2-w08,trixi128-rep3-w08
 *
 * Single pair (validation):
 *   bun run pooled-mcnemar.ts --ctl trixi120-det-ctl --trt trixi121-det-w08
 *
 * Verdict source: report.json.evaluations[] — each item has questionId, questionType,
 * and score (1=correct, 0=incorrect; identical to label==="correct"). Categories are the
 * six questionType values. Abstention questions carry an _abs suffix on questionId only;
 * their questionType is the base category (they are NOT a separate category).
 */

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const RUNS_DIR = join(import.meta.dir, "..", "data", "runs")

// ---- arg parsing ----------------------------------------------------------

function parseArgs(argv: string[]): { ctl: string[]; trt: string[] } {
  let ctl: string[] = []
  let trt: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ctl") ctl = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    else if (argv[i] === "--trt") trt = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  }
  return { ctl, trt }
}

// ---- data loading ---------------------------------------------------------

type Verdict = { correct: boolean; questionType: string }
type RunData = { runId: string; byQid: Map<string, Verdict> }

function loadRun(runId: string): RunData {
  const p = join(RUNS_DIR, runId, "report.json")
  if (!existsSync(p)) {
    console.error(`ERROR: report.json not found for run "${runId}" (${p})`)
    console.error(`  (run may still be executing, or the id is wrong)`)
    process.exit(1)
  }
  const report = JSON.parse(readFileSync(p, "utf8"))
  const evals = report.evaluations
  if (!Array.isArray(evals)) {
    console.error(`ERROR: run "${runId}" report.json has no evaluations[] array`)
    process.exit(1)
  }
  const byQid = new Map<string, Verdict>()
  for (const e of evals) {
    byQid.set(e.questionId, { correct: e.score === 1, questionType: e.questionType })
  }
  return { runId, byQid }
}

// ---- exact two-sided McNemar (binomial on discordants) --------------------

// log C(n,k) via lgamma, to stay exact-ish for n up to a few hundred.
function lgamma(x: number): number {
  // Lanczos approximation
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  x -= 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

function logChoose(n: number, k: number): number {
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1)
}

/** Exact two-sided McNemar p: binomial test that discordants split 50/50.
 *  p = min(1, 2 * P(X <= min(b,c))) where X ~ Binomial(b+c, 0.5). */
function exactMcNemarP(b: number, c: number): number {
  const n = b + c
  if (n === 0) return 1
  const m = Math.min(b, c)
  const ln2 = Math.log(2)
  let tailLog = -Infinity // log of sum_{i=0}^{m} C(n,i)
  for (let i = 0; i <= m; i++) {
    const term = logChoose(n, i)
    tailLog = logSumExp(tailLog, term)
  }
  // P(X <= m) = exp(tailLog) * 0.5^n ; two-sided doubles it, capped at 1.
  const logP = Math.log(2) + tailLog - n * ln2
  return Math.min(1, Math.exp(logP))
}

function logSumExp(a: number, b: number): number {
  if (a === -Infinity) return b
  if (b === -Infinity) return a
  const m = Math.max(a, b)
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m))
}

// ---- pairwise analysis ----------------------------------------------------

type PairStat = {
  ctlRun: string
  trtRun: string
  nCtl: number // ctl correct
  nTrt: number // trt correct
  delta: number
  b: number // ctl right, trt wrong  (a "down" flip for treatment)
  c: number // ctl wrong, trt right  (an "up" flip for treatment)
  p: number
  total: number
}

// direction of a discordant qid within one pair: "up" (trt gains), "down" (trt loses)
type FlipDir = "up" | "down"

function analyzePair(
  ctl: RunData,
  trt: RunData,
  filter?: (qt: string) => boolean
): { stat: PairStat; flips: Map<string, { dir: FlipDir; qt: string }> } {
  let nCtl = 0
  let nTrt = 0
  let b = 0
  let c = 0
  let total = 0
  const flips = new Map<string, { dir: FlipDir; qt: string }>()
  // iterate over the intersection of qids (both runs judged the same 300)
  for (const [qid, cv] of ctl.byQid) {
    const tv = trt.byQid.get(qid)
    if (!tv) continue
    if (filter && !filter(cv.questionType)) continue
    total++
    if (cv.correct) nCtl++
    if (tv.correct) nTrt++
    if (cv.correct && !tv.correct) {
      b++
      flips.set(qid, { dir: "down", qt: cv.questionType })
    } else if (!cv.correct && tv.correct) {
      c++
      flips.set(qid, { dir: "up", qt: cv.questionType })
    }
  }
  const stat: PairStat = {
    ctlRun: ctl.runId,
    trtRun: trt.runId,
    nCtl,
    nTrt,
    delta: nTrt - nCtl,
    b,
    c,
    p: exactMcNemarP(b, c),
    total,
  }
  return { stat, flips }
}

// ---- stats helpers --------------------------------------------------------

function mean(xs: number[]): number {
  return xs.reduce((a, x) => a + x, 0) / xs.length
}
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}
function fmtP(p: number): string {
  return p.toFixed(4)
}
function pad(s: string | number, w: number): string {
  return String(s).padStart(w)
}

// ---- reporting ------------------------------------------------------------

const CATEGORIES = [
  "multi-session",
  "temporal-reasoning",
  "knowledge-update",
  "single-session-user",
  "single-session-assistant",
  "single-session-preference",
]

function reportScope(
  title: string,
  ctlRuns: RunData[],
  trtRuns: RunData[],
  filter?: (qt: string) => boolean
) {
  const nPairs = ctlRuns.length
  const perPair: PairStat[] = []
  // flipsPerPair[i] : Map<qid, {dir, qt}>  for consistency table
  const flipsPerPair: Map<string, { dir: FlipDir; qt: string }>[] = []

  for (let i = 0; i < nPairs; i++) {
    const { stat, flips } = analyzePair(ctlRuns[i], trtRuns[i], filter)
    perPair.push(stat)
    flipsPerPair.push(flips)
  }

  console.log(`\n${"=".repeat(78)}`)
  console.log(title)
  console.log("=".repeat(78))

  // per-replicate-pair table
  console.log(
    `\n  ${"pair".padEnd(nPairs > 1 ? 26 : 40)} ${pad("ctl", 4)} ${pad("trt", 4)} ${pad("Δ", 4)}  ${pad("b↓", 4)} ${pad("c↑", 4)}  ${pad("exact p", 8)}`
  )
  console.log(`  ${"-".repeat(nPairs > 1 ? 26 : 40)} ---- ---- ----  ---- ----  --------`)
  for (const s of perPair) {
    const label = nPairs > 1 ? `${s.ctlRun} v ${s.trtRun}` : `${s.ctlRun} v ${s.trtRun}`
    const w = nPairs > 1 ? 26 : 40
    console.log(
      `  ${label.slice(0, w).padEnd(w)} ${pad(s.nCtl, 4)} ${pad(s.nTrt, 4)} ${pad(fmtDelta(s.delta), 4)}  ${pad(s.b, 4)} ${pad(s.c, 4)}  ${pad(fmtP(s.p), 8)}`
    )
  }

  // pooled
  const B = perPair.reduce((a, s) => a + s.b, 0)
  const C = perPair.reduce((a, s) => a + s.c, 0)
  const pooledP = exactMcNemarP(B, C)
  const deltas = perPair.map((s) => s.delta)
  const meanDelta = mean(deltas)
  const sdDelta = stddev(deltas)

  console.log(`\n  POOLED across ${nPairs} pair(s):`)
  console.log(`    discordants: b↓ (ctl right / trt wrong) = ${B}, c↑ (ctl wrong / trt right) = ${C}`)
  console.log(`    net flips (c - b) = ${fmtDelta(C - B)}   exact two-sided McNemar p = ${fmtP(pooledP)}`)
  if (nPairs > 1) {
    console.log(
      `    delta per 300: mean = ${meanDelta.toFixed(2)}  (per-pair Δ: ${deltas.map(fmtDelta).join(", ")})`
    )
    console.log(
      `    CI: across-replicate mean Δ ± sample SD = ${meanDelta.toFixed(2)} ± ${sdDelta.toFixed(2)}  [${(meanDelta - sdDelta).toFixed(2)}, ${(meanDelta + sdDelta).toFixed(2)}]`
    )
  } else {
    console.log(`    delta per 300 = ${fmtDelta(meanDelta)}  (single pair — no across-replicate CI)`)
  }

  return { perPair, flipsPerPair, pooled: { B, C, p: pooledP, meanDelta, sdDelta } }
}

function fmtDelta(d: number): string {
  const r = Math.round(d * 100) / 100
  return (r > 0 ? "+" : "") + (Number.isInteger(r) ? String(r) : r.toFixed(2))
}

// per-question consistent-flip table (pooled discordants stable across ALL pairs)
function reportConsistentFlips(
  flipsPerPair: Map<string, { dir: FlipDir; qt: string }>[],
  nPairs: number
) {
  console.log(`\n${"=".repeat(78)}`)
  console.log("CONSISTENT PER-QUESTION FLIPS (discordant, same direction across ALL pairs)")
  console.log("=".repeat(78))

  // collect every qid that was discordant in any pair
  const all = new Map<string, { dirs: (FlipDir | null)[]; qt: string }>()
  for (let i = 0; i < nPairs; i++) {
    for (const [qid, info] of flipsPerPair[i]) {
      if (!all.has(qid)) all.set(qid, { dirs: new Array(nPairs).fill(null), qt: info.qt })
      all.get(qid)!.dirs[i] = info.dir
    }
  }

  // stable = discordant in EVERY pair, same direction in all
  const stable: { qid: string; qt: string; dir: FlipDir }[] = []
  const noisy: { qid: string; qt: string; dirs: (FlipDir | null)[] }[] = []
  for (const [qid, info] of all) {
    const present = info.dirs.filter((d) => d !== null) as FlipDir[]
    const allPresent = present.length === nPairs
    const sameDir = present.every((d) => d === present[0])
    if (allPresent && sameDir) stable.push({ qid, qt: info.qt, dir: present[0] })
    else noisy.push({ qid, qt: info.qt, dirs: info.dirs })
  }

  stable.sort((a, b) => (a.dir === b.dir ? a.qt.localeCompare(b.qt) : a.dir.localeCompare(b.dir)))

  if (nPairs === 1) {
    console.log("\n  (single pair — every discordant is trivially 'consistent')")
  }
  console.log(`\n  ${stable.length} stable flip(s) [discordant + same direction in all ${nPairs} pair(s)]:`)
  console.log(`\n  ${"qid".padEnd(20)} ${"dir".padEnd(6)} category`)
  console.log(`  ${"-".repeat(20)} ${"-".repeat(6)} ${"-".repeat(28)}`)
  for (const f of stable) {
    const arrow = f.dir === "up" ? "up ↑" : "down↓"
    console.log(`  ${f.qid.padEnd(20)} ${arrow.padEnd(6)} ${f.qt}`)
  }
  const upN = stable.filter((f) => f.dir === "up").length
  const downN = stable.filter((f) => f.dir === "down").length
  console.log(`\n  stable summary: ${upN} up↑ (trt gains), ${downN} down↓ (trt loses), net ${fmtDelta(upN - downN)}`)

  if (nPairs > 1 && noisy.length) {
    console.log(`\n  ${noisy.length} noisy flip(s) [discordant in some but not all pairs, or direction disagrees]:`)
    console.log(`\n  ${"qid".padEnd(20)} ${"per-pair dir".padEnd(20)} category`)
    console.log(`  ${"-".repeat(20)} ${"-".repeat(20)} ${"-".repeat(28)}`)
    noisy.sort((a, b) => a.qt.localeCompare(b.qt))
    for (const f of noisy) {
      const dirs = f.dirs.map((d) => (d === "up" ? "↑" : d === "down" ? "↓" : "·")).join(" ")
      console.log(`  ${f.qid.padEnd(20)} ${dirs.padEnd(20)} ${f.qt}`)
    }
  }
}

// ---- main -----------------------------------------------------------------

function main() {
  const { ctl, trt } = parseArgs(process.argv.slice(2))
  if (ctl.length === 0 || trt.length === 0) {
    console.error("Usage: bun run pooled-mcnemar.ts --ctl <run[,run...]> --trt <run[,run...]>")
    process.exit(2)
  }
  if (ctl.length !== trt.length) {
    console.error(
      `ERROR: replicate-pair mismatch — ${ctl.length} ctl runs vs ${trt.length} trt runs. Pairs are positional; supply equal counts.`
    )
    process.exit(2)
  }

  const ctlRuns = ctl.map(loadRun)
  const trtRuns = trt.map(loadRun)

  console.log(`\nPooled exact-McNemar analysis — ${ctl.length} replicate pair(s)`)
  console.log(`  control  : ${ctl.join(", ")}`)
  console.log(`  treatment: ${trt.join(", ")}`)
  console.log(`  convention: b↓ = ctl right / trt wrong ; c↑ = ctl wrong / trt right ; Δ = trt − ctl correct`)

  // overall
  const overall = reportScope("OVERALL (all categories)", ctlRuns, trtRuns)

  // per-category
  for (const cat of CATEGORIES) {
    reportScope(`CATEGORY: ${cat}`, ctlRuns, trtRuns, (qt) => qt === cat)
  }

  // consistent per-question flips (overall, pooled)
  reportConsistentFlips(overall.flipsPerPair, ctlRuns.length)

  console.log("")
}

main()
