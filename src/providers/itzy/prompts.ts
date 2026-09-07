import type { ProviderPrompts } from "../../types/prompts"
import { buildTrixiAnswerPrompt } from "../trixi/prompts"

/** ‡ THE ANSWER PROMPT IS SHARED WITH TRIXI ON PURPOSE, BY IMPORT AND NOT BY
 * COPY. The point of running itzy on this bench is to price its storage and
 * retrieval against trixi's on the same corpus; a divergent answer prompt
 * would move the number for a reason that has nothing to do with either
 * engine. The two providers also emit atoms in the same body shape —
 * "(date): fact" — which is what that prompt's date extraction and timeline
 * section read, so it applies to itzy's results unchanged.
 *
 * A copy would have read as independence while drifting silently on the next
 * prompt iteration; the import makes the shared dependency a thing you can
 * see. If itzy ever needs a prompt of its own, that is a deliberate fork with
 * its own before/after number, not an edit here. */
export const ITZY_PROMPTS: ProviderPrompts = {
  answerPrompt: buildTrixiAnswerPrompt,
}

export default ITZY_PROMPTS
