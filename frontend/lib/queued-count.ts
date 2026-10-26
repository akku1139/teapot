/**
 * How many queued messages the ⏳ badge should show.
 *
 * Extracted so the rule is testable by production import rather than by a mirror — the mirror is the
 * thing that let a `??` bug through (a test asserting the same wrong chain passes by construction).
 *
 * The snapshot carries one fact THREE ways: `pendingPromptQueue` (with text), `pendingPromptIds`
 * (identity) and `pendingPrompts` (a count, the oldest field). This used to be a `??` chain, which
 * falls through only on null/undefined — and the server always sends all three, so an EMPTY ARRAY
 * stopped the chain at 0 and hid a real queue. MEASURED: `{queue: [], ids: [], pendingPrompts: 3}`
 * produced a badge of 0.
 */
export type QueueViews = {
  pendingPromptQueue?: readonly unknown[];
  pendingPromptIds?: readonly unknown[];
  pendingPrompts?: number;
};

/** the largest queue the server's fields can account for */
export const serverQueuedCount = (a: QueueViews | undefined | null): number => {
  if (!a) return 0;
  return Math.max(
    a.pendingPromptQueue?.length ?? 0,
    a.pendingPromptIds?.length ?? 0,
    a.pendingPrompts ?? 0,
  );
};

/**
 * What the badge shows: the server's queue, or the echoes the feed is drawing, whichever is larger.
 *
 * Both sides describe the SAME feed. `echoCount` comes from the pipeline (`pendingCount`), which
 * consults the log; the server count covers the case the client cannot see (opened in another tab,
 * or sent before a reload). Taking the maximum means neither can hide the other.
 */
export const queuedBadgeCount = (opts: {
  /** does the selected agent's session match the timeline on screen? */
  sameSession: boolean;
  agent: QueueViews | undefined | null;
  echoCount: number;
}): number => {
  const fromServer = opts.sameSession ? serverQueuedCount(opts.agent) : 0;
  return Math.max(fromServer, opts.echoCount);
};
