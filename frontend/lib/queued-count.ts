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

export const queuedBadgeCount = (opts: {
  sameSession: boolean;
  agent: QueueViews | undefined | null;
  echoCount: number;
}): number => {
  const fromServer = opts.sameSession ? serverQueuedCount(opts.agent) : 0;
  return Math.max(fromServer, opts.echoCount);
};
