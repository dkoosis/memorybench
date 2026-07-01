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

Instructions:
- Base your answer ONLY on the provided nugs
- If the nugs contain enough information, provide a clear, concise answer
- If the nugs do not contain enough information, respond with "I don't know"
- Pay attention to temporal context for time-based questions

Reasoning:
[Your step-by-step reasoning process here]

Answer:
[Your final answer here]`
}

export const TRIXI_PROMPTS: ProviderPrompts = {
  answerPrompt: buildTrixiAnswerPrompt,
}

export default TRIXI_PROMPTS
