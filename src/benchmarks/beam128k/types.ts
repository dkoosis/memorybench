/** One message of a BEAM chat.json. A turn opens with a user
 * `main_question` whose content ends in ` ->-> <batch>,<turn>` and which may
 * carry a time_anchor ("March-15-2024"); follow-ups and assistant replies
 * carry neither. */
export interface BeamMessage {
  role: "user" | "assistant"
  id: number
  content: string
  index?: string | null
  question_type?: string | null
  time_anchor?: string | null
}

export interface BeamBatch {
  batch_number: number
  time_anchor: string | null
  turns: BeamMessage[][]
}

/** A probing question. BEAM names the reference answer differently per
 * ability — answer / ideal_response / ideal_answer / ideal_summary /
 * expected_compliance — and grades every one against `rubric`. */
export interface BeamProbingQuestion {
  question: string
  rubric: string[]
  answer?: string
  ideal_response?: string
  ideal_answer?: string
  ideal_summary?: string
  expected_compliance?: string
  compliance_indicators?: string[]
  difficulty?: string
  [extra: string]: unknown
}

/** probing_questions.json: ability label → its questions. */
export type BeamProbingQuestions = Record<string, BeamProbingQuestion[]>
