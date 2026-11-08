export type QueueViews = {
  pendingPromptQueue?: readonly unknown[];
  pendingPromptIds?: readonly unknown[];
  pendingPrompts?: number;
};

export const serverQueuedCount = (a: QueueViews | undefined | null): number => {
  if (!a) return 0;
  return Math.max(
    a.pendingPromptQueue?.length ?? 0,
    a.pendingPromptIds?.length ?? 0,
    a.pendingPrompts ?? 0,
  );
};

/**
 * The badge counts rows that SAY "queued…", and nothing else.
 *
 * It used to take the max of the server's `pendingPrompts` (everything enqueued, including the prompt the agent is about
 * to pick up) and the number of local echoes. Both are non-zero for a few milliseconds on an IDLE send, which is the
 * flash the operator kept reporting — with the client and the server both correctly idle.
 *
 * Prompts queued by another client are drawn as queue rows too, so the timeline is the whole story; the server's raw
 * count is deliberately unused here (`serverQueuedCount` stays for callers that need the raw number).
 */
export const queuedBadgeCount = (opts: { sameSession: boolean; echoCount: number }): number => {
  void opts.sameSession;
  return opts.echoCount;
};
