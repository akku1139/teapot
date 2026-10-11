/**
 * Reconciling optimistic echoes against the live queue (#87).
 *
 * Extracted from App.tsx so the rule is tested against the code that runs — an
 * inline copy is a mirror, and a mirror passes by construction.
 */

/**
 * One optimistic echo of a queued prompt.
 *
 * `source` matters: a HARNESS prompt (a goal/todo save, or a sub-agent report)
 * has no composer draft to return it to and no user text to fork from, so it must
 * not grow a ✕/✎ that could only fail (#122).
 */
export type PendingEcho = {
  id: string;
  text: string;
  at: number;
  promptId?: string;
  sent?: boolean;
  images?: string[];
  /** "user" for an operator prompt, "harness" for one the system injected */
  source?: string;
};

/**
 * Reconcile the local echoes against the live queue (#78).
 *
 * Matching is by IDENTITY. The old `filter(!!promptId).slice(0, queued)` kept the
 * first N by POSITION, so whenever the server's count dipped below the real queue
 * (a mid-queue cancel, or the gap before `drainPendingPrompts()` settles) the
 * NEWEST still-queued echoes were dropped — and since `stillPendingIds` derives
 * from this list, their log rows reappeared as settled "sent" rows (#19).
 */
export const reconcilePending = (
  list: PendingEcho[],
  queued: number,
  liveIds: readonly string[] | undefined,
): PendingEcho[] => {
  if (queued >= list.length) return list;
  if (liveIds?.length) {
    const live = new Set(liveIds);
    const matched = list.filter((p) => p.promptId && live.has(p.promptId));
    if (matched.length) {
      // echoes with no id (pre-tracking, or pre-reload) have nothing to match on:
      // keep them only if the ids cannot account for the queue, so they are never
      // silently dropped
      const unidentifiable = list.filter((p) => !p.promptId);
      return unidentifiable.length ? [...matched, ...unidentifiable].slice(0, queued) : matched;
    }
  }
  // no ids at all (older server): the head is correct for a front-to-back drain
  return list.slice(0, queued);
};
