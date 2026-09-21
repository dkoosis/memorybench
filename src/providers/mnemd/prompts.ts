import type { ProviderPrompts } from "../../types/prompts"
import { buildTrixiAnswerPrompt } from "../trixi/prompts"

/** ‡ THE ANSWER PROMPT IS SHARED WITH TRIXI AND ITZY ON PURPOSE, BY IMPORT AND
 * NOT BY COPY — same reasoning as itzy/prompts.ts. This provider exists to
 * price mnemd's capture/recall against the other nug-shaped stores on the
 * same corpus; a divergent answer prompt would move the number for a reason
 * that has nothing to do with the engine under test. mnemd's atoms are
 * emitted in the same "(date): fact" body shape the shared prompt's date
 * extraction and timeline section read, so it applies unchanged. */
export const MNEMD_PROMPTS: ProviderPrompts = {
  answerPrompt: buildTrixiAnswerPrompt,
}

export default MNEMD_PROMPTS
