/**
 * Which `usage` event describes the context a restored agent actually has.
 *
 * The log's `usage` events record what a request cost, and a compaction is written when the NEXT turn starts — so the
 * usual order is `usage(900k) → compaction(24k)`. Taking the last `usage` regardless reported the pre-compaction number
 * after a restore: the meter read 86% while the real context was ~24k.
 *
 * Anything written at or after the newest `compaction` is about the current context. Anything before it is about a
 * context that was summarized away, so it is not evidence about today's size.
 */
export interface UsageEventLike {
  type: string;
  data?: unknown;
}

export function usageAfterLastCompaction<T extends UsageEventLike>(events: T[]): { input: number; output: number; cached?: number } | null {
  const lastCompaction = events.reduce((at, e, i) => (e.type === "compaction" ? i : at), -1);
  for (let i = events.length - 1; i >= lastCompaction && i >= 0; i--) {
    const e = events[i];
    if (!e || e.type !== "usage") continue;
    const u = (e.data ?? {}) as { inputTokens?: unknown; outputTokens?: unknown; cachedInputTokens?: unknown };
    if (typeof u.inputTokens !== "number") continue;
    return {
      input: u.inputTokens,
      output: typeof u.outputTokens === "number" ? u.outputTokens : 0,
      ...(typeof u.cachedInputTokens === "number" && u.cachedInputTokens ? { cached: u.cachedInputTokens } : {}),
    };
  }
  return null;
}
