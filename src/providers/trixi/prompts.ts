import type { ProviderPrompts } from "../../types/prompts"

interface TrixiResult {
  id: string
  name: string
  body: string
}

function buildTrixiContext(context: unknown[]): string {
  const results = context as TrixiResult[]

  if (results.length === 0) {
    return "No relevant nugs were found."
  }

  return results
    .map((result, i) => `=== Nug ${i + 1}: ${result.name} (${result.id}) ===\n${result.body}`)
    .join("\n\n---\n\n")
}

export function buildTrixiAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const retrievedContext = buildTrixiContext(context)

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

**How to answer:**
1. Scan nug names for relevance; read the bodies of relevant nugs carefully.
2. Synthesize across multiple nugs when the answer spans sessions.
3. Think through the problem step by step, showing date arithmetic explicitly for temporal questions.
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
