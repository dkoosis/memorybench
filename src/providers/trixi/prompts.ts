import type { ProviderPrompts } from "../../types/prompts"

interface TrixiResult {
  id: string
  name: string
  body: string
}

// parseSessionDate extracts the session date embedded in an atom body's
// scaffold — "Section (10:28 pm on 29 May, 2023): ..." — and returns a Date,
// or null when no parseable date is present. E4c Arm A: the date must be a
// first-class, machine-clean line beside each fact (Zep's lever: the answerer
// does the temporal reasoning, but only if it can SEE clean dates), and the
// timeline section needs a sort key.
function parseSessionDate(body: string): Date | null {
  const m = body.match(/\(([^)]*?(\d{1,2}\s+\w+,?\s+\d{4}))\)/)
  if (!m) return null
  const t = Date.parse(m[2].replace(",", ""))
  if (Number.isNaN(t)) return null
  // Fold in the time-of-day when present ("10:28 pm on 29 May, 2023").
  const tm = m[1].match(/(\d{1,2}):(\d{2})\s*(am|pm)/i)
  const d = new Date(t)
  if (tm) {
    let h = parseInt(tm[1], 10) % 12
    if (tm[3].toLowerCase() === "pm") h += 12
    d.setHours(h, parseInt(tm[2], 10))
  }
  return d
}

// fmtNaive renders the date with the same wall-clock fields it was parsed
// with — no timezone conversion. The bench dates are timezone-less; a UTC
// render would shift late-evening sessions to the next day and corrupt the
// answerer's date arithmetic by one.
function fmtNaive(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

// temporalCue reports whether the question reads temporal — the TIMELINE
// section helps those (+9.6 temporal, D-036) but fragments multi-hop
// synthesis on non-temporal questions (-7.7 multi-session, replicated at
// both scales). Gate it instead of paying the trade everywhere (E4c gated).
function temporalCue(question: string): boolean {
  return /\b(when|how long|how many (days|weeks|months|years)|before|after|first time|last time|ago|earlier|latest|recent|still|anymore|date|day|month|year|since|until|between)\b/i.test(
    question
  )
}

function buildTrixiContext(context: unknown[], includeTimeline: boolean): string {
  const results = context as TrixiResult[]

  if (results.length === 0) {
    return "No relevant nugs were found."
  }

  const dated = results.map((result, i) => ({
    result,
    i,
    date: parseSessionDate(result.body),
  }))

  const nugList = dated
    .map(({ result, i, date }) => {
      const dateLine = date ? `Date: ${fmtNaive(date)}` : "Date: unknown"
      return `=== Nug ${i + 1}: ${result.name} (${result.id}) ===\n${dateLine}\n${result.body}`
    })
    .join("\n\n---\n\n")

  // Chronological timeline of the same nugs (E4c Arm A, MAGMA's serve-side
  // shape minus the graph): temporal questions need the order and spacing of
  // events, which a relevance-ranked list destroys. Undated nugs are listed
  // in the main list only.
  const timeline = dated
    .filter((d) => d.date !== null)
    .sort((a, b) => a.date!.getTime() - b.date!.getTime())
    .map((d) => `- ${fmtNaive(d.date!)} — [Nug ${d.i + 1}] ${d.result.name}`)
    .join("\n")

  return includeTimeline && timeline.length > 0
    ? `${nugList}\n\n=== TIMELINE (all dated nugs, chronological) ===\n${timeline}`
    : nugList
}

export function buildTrixiAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const isTemporal = temporalCue(question)
  const retrievedContext = buildTrixiContext(context, isTemporal)

  return `You are a question-answering system. You have access to nugs (extracted memory facts) retrieved from a knowledge graph. Based on the retrieved nugs below, answer the question.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Nugs:
${retrievedContext}

**Understanding the nugs:**
- Each nug is one atomic fact extracted from a conversation session. The name is a short summary; the body carries the detail.
- Nug bodies begin with a section label and the SESSION DATE the fact was said, e.g. "Key Facts (10:28 pm on 29 May, 2023): ...". That embedded date is the fact's temporal anchor.

**Temporal rules (time-based questions):**
- Relative terms inside a nug ("today", "yesterday", "last week", "next month") are relative to that nug's embedded session date, NOT the current date and NOT the question date.
- The Question Date above is the temporal perspective of the asker; compute "how long ago"/"how many days" answers against it when the question asks from the asker's now.
- To order events or compute durations, extract the session dates from the relevant nug bodies and work date arithmetic step by step — write the dates out explicitly before subtracting.
- When facts conflict, prefer the nug with the later session date for current-state questions ("what is X now"), but use the full dated sequence for questions about change over time ("when did X change", "what was X before").

**How to answer (structured notes, then synthesize):**
1. NOTES: for each relevant nug, write one line — [Nug N] date | the fact it contributes. Skip irrelevant nugs.
2. ${isTemporal ? "For temporal questions, use the TIMELINE section: it lists every dated nug in chronological order — read event order and spacing from it, then do date arithmetic explicitly, writing the dates out before subtracting." : "Synthesize freely across sessions — trace entities and events through the nugs wherever the question leads."}
3. SYNTHESIZE: combine your notes across sessions into the answer.
4. Base your answer ONLY on the provided nugs.
5. If the nugs do not contain enough information, respond with "I don't know".

Reasoning:
[Your step-by-step reasoning process here]

Answer:
[Your final answer here]`
}

export const TRIXI_PROMPTS: ProviderPrompts = {
  answerPrompt: buildTrixiAnswerPrompt,
}

export default TRIXI_PROMPTS
