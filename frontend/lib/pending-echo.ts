
export type PendingEcho = {
  id: string;
  text: string;
  at: number;
  promptId?: string;
  sent?: boolean;
  images?: string[];
  source?: string;
};

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
      const unidentifiable = list.filter((p) => !p.promptId);
      return unidentifiable.length ? [...matched, ...unidentifiable].slice(0, queued) : matched;
    }
  }
  return list.slice(0, queued);
};
