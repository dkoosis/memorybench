import type { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"

/** Model used for query formulation (fast, cheap — matches extraction's
 * budget-consciousness, EXTRACTION_MODEL in ../../prompts/extraction.ts). */
const FORMULATION_MODEL = "gpt-4o-mini"

/**
 * mn-cw8: the benchmark's raw natural-language question is not the query a
 * real mnemd caller sends. A real caller is an agent that reads dk's intent
 * and chooses query words before calling `recall` (mnemd's own docs: "find
 * nugs whose text carries those words" — a lexical match, not a paraphrase
 * match). Passing the question sentence verbatim lets stray words in its
 * scaffolding ("could have been", "any tips on") outrank the content words
 * that actually name what is being asked about.
 *
 * This step stands in for that agent: given the benchmark question, it
 * returns the handful of content words/phrases an agent would type into
 * `recall`, dropping question-scaffolding and stopwords entirely.
 */
export function buildFormulationPrompt(question: string): string {
  return `You are about to search a personal memory store for facts that answer a question. The store is a lexical keyword search (it matches whole words in stored text) — it is not a paraphrase or semantic search.

Rewrite the question below as a short search query: 3-8 content words or short phrases (names, nouns, topics, specifics) that would appear in a memory carrying the answer. Drop the question's grammar, stopwords, and scaffolding ("any tips on", "could have been", "what did", "how does").

Question: ${question}

Return ONLY the search query words, nothing else.`
}

/**
 * Call the formulation model to turn a benchmark question into a search
 * query. Falls back to the raw question on any failure — a formulation
 * outage should degrade to today's behavior, not fail the search phase.
 */
export async function formulateQuery(
  openai: ReturnType<typeof createOpenAI>,
  question: string
): Promise<string> {
  try {
    const params: Record<string, unknown> = {
      model: openai(FORMULATION_MODEL),
      prompt: buildFormulationPrompt(question),
      maxTokens: 60,
      temperature: 0,
    }
    const { text } = await generateText(params as Parameters<typeof generateText>[0])
    const formulated = text.trim()
    return formulated.length > 0 ? formulated : question
  } catch {
    return question
  }
}
