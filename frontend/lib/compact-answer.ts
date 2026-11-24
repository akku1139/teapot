/**
 * What `/compact` tells the operator, from the server's three answers.
 *
 * The endpoint distinguishes "it ran", "it is queued until the next turn boundary" and "the history has not grown since
 * the last compaction". The client only knew `ran`, so asking for a compaction while the agent was working — which is
 * when an operator most wants one — reported "nothing to compact yet" about a history that had not been examined.
 */
export type CompactAnswer = { ran?: unknown; queued?: unknown } | null | undefined;

export function compactHint(answer: CompactAnswer): string {
  if (answer?.ran) return "context compacted";
  if (answer?.queued) return "compaction queued — runs at the next turn boundary";
  return "nothing to compact yet";
}
