/**
 * Reconciling optimistic echoes against the live queue.
 *
 * Extracted so the rule is testable against the code that runs (#87). It lived
 * inline in App.tsx, and the tests mirrored it — a mirror passes by
 * construction, so the copy and the original could drift without anything
 * noticing.
 */

/** an optimistic echo row awaiting its log entry */
/**
 * One optimistic echo of a queued prompt.
 *
 * `source` matters: a HARNESS prompt (the operator's goal/todo save, or a
 * sub-agent report) cannot be cancelled or edited by hand — there is no composer
 * draft to return it to and no user text to fork from (#122). Without carrying the
 * source here, every echo rendered as `source:"user"` and grew a ✕ that would have
 * failed.
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
 * Match on IDENTITY. This used to be `filter(!!promptId).slice(0, queued)`,
 * which keeps the FIRST N by position — so every time the server's count dipped
 * below the real queue (a mid-queue ✕ cancel, or the brief gap before
 * drainPendingPrompts() settles) the NEWEST still-queued echoes were dropped.
 * Because `stillPendingIds` is derived from this list, their undelivered log
 * rows then showed up as settled "sent" rows — re-introducing the #19
 * cancellation bug the block below exists to prevent.
 *
 * Pure, and it writes through `writePending` so the per-session map stays in
 * step with the signal (#87) — updating only the signal would lose the echoes
 * again on the next session switch.
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
      // echoes with no id (predating tracking, or pre-reload) have no identity
      // to match — keep them only if the ids alone cannot account for the
      // queue, so they are never silently dropped
      const unidentifiable = list.filter((p) => !p.promptId);
      return unidentifiable.length ? [...matched, ...unidentifiable].slice(0, queued) : matched;
    }
  }
  // No ids to match on at all (older server, or every echo predates promptId
  // tracking): fall back to keeping the HEAD, which is correct for the plain
  // front-to-back drain case.
  return list.slice(0, queued);
};
