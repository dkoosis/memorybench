export interface BeamRubricJudgeResult {
  score: number
  reason: string
}

function parseJsonResponse(response: string): Record<string, unknown> {
  const trimmed = response.trim()

  if (trimmed.startsWith("```")) {
    const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (codeFenceMatch?.[1]) {
      return JSON.parse(codeFenceMatch[1])
    }
  }

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0])
  }

  return JSON.parse(trimmed)
}

export function buildBeamRubricJudgePrompt(
  question: string,
  rubricItem: string,
  llmResponse: string
): string {
  return `You are an expert evaluator tasked with judging whether the LLM's response demonstrates compliance with the specified RUBRIC CRITERION.

## EVALUATION INPUTS
- QUESTION (what the user asked): ${question}
- RUBRIC CRITERION (what to check): ${rubricItem}
- RESPONSE TO EVALUATE: ${llmResponse}

## EVALUATION RUBRIC:
The rubric defines a specific requirement, constraint, or expected behavior that the LLM response should demonstrate.

**IMPORTANT**: Pay careful attention to whether the rubric specifies:
- **Positive requirements** (things the response SHOULD include/do)
- **Negative constraints** (things the response SHOULD NOT include/do, often indicated by "no", "not", "avoid", "absent")

## RESPONSIVENESS REQUIREMENT (anchored to the QUESTION)
A compliant response must be **on-topic with respect to the QUESTION** and attempt to answer it.
- If the response does not address the QUESTION, score **0.0** and stop.
- For negative constraints, both must hold: (a) the response is responsive to the QUESTION, and (b) the prohibited element is absent.

## SEMANTIC TOLERANCE RULES:
Judge by meaning, not exact wording.
- Accept paraphrases and synonyms that preserve intent.
- Case/punctuation/whitespace differences must be ignored.
- Numbers/currencies/dates may appear in equivalent forms when numerically equivalent.
- If the rubric expects a number or duration, prefer normalized comparison over string matching.

## STYLE NEUTRALITY:
Ignore tone, politeness, length, and flourish unless the rubric explicitly requires a format/structure.
- Do not penalize hedging, voice, or verbosity if content satisfies the rubric.
- Only evaluate format when the rubric explicitly mandates it.

## SCORING SCALE:
- 1.0 (Complete Compliance): Fully complies with the rubric criterion.
- 0.5 (Partial Compliance): Partially complies.
- 0.0 (No Compliance): Fails to comply.

## OUTPUT FORMAT:
Return your evaluation in JSON format with two fields:
{
  "score": [your score: 1.0, 0.5, or 0.0],
  "reason": "[detailed explanation of whether the rubric criterion was satisfied and why]"
}

NOTE: ONLY output the JSON object, without any explanation before or after that`
}

export function parseBeamRubricJudgeResponse(response: string): BeamRubricJudgeResult {
  try {
    const parsed = parseJsonResponse(response)
    const score = typeof parsed.score === "number" ? parsed.score : Number(parsed.score)
    return {
      score: Number.isFinite(score) ? score : 0,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    }
  } catch {
    return {
      score: 0,
      reason: "Failed to parse judge response",
    }
  }
}
