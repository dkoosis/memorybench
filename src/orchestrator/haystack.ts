/** A question's memory container. Questions that name a `haystackId`
 * share one container (BEAM: twenty probes over one conversation); the rest
 * are their own, so LongMemEval / LoCoMo / ConvoMem run unchanged. */
export function containerTagFor(
  q: { questionId: string; haystackId?: string },
  dataSourceRunId: string
): string {
  return `${q.haystackId ?? q.questionId}-${dataSourceRunId}`
}

/** Stable-order grouping: keys and members in first-seen order. */
export function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = keyOf(item)
    const g = groups.get(k)
    if (g) g.push(item)
    else groups.set(k, [item])
  }
  return groups
}
