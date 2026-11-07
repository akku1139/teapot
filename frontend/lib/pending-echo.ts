export type PendingEcho = {
  id: string;
  text: string;
  at: number;
  promptId?: string;
  sent?: boolean;
  images?: string[];
  source?: string;
  /**
   * Was the agent BUSY when this was sent?
   *
   * "idle状態でプロンプトを送っても一瞬queuedになる問題" — the optimistic echo rendered as queued for every send, because
   * `pending` only meant "the server has not confirmed it yet". A prompt sent to an idle agent is not queued at all; it
   * is simply being delivered, and showing "queued…" for a frame or two is a lie the operator notices.
   */
  queued?: boolean;
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

export type QueuedPrompt = { id?: string; text?: string; at?: number; images?: { url: string }[]; source?: string };

/**
 * Merge the server's queue into the local echoes WITHOUT letting either one own the order.
 *
 * Reported: "さっき、メッセージ1 → メッセージ2 の順で送った結果、タイムライン上では上から 2 → 1 の順に並んでる".
 *
 * Two owners wrote the same list. The send path APPENDED the operator's echo; a separate effect PREPENDED whatever
 * the server's `pendingPromptQueue` reported as missing. Between the POST returning and the echo being labelled with
 * its `promptId` the server's copy of the SAME prompt looks "missing", so it was prepended in front of the echo that
 * already represented it — and with two prompts in flight the two owners interleaved into a reversed order.
 *
 * The rule now: the local echoes keep their order (they are in send order by construction), and a queue entry is only
 * added when it is genuinely unknown — not by id, and not by text against an echo that has no id yet. New entries go
 * at the END, because an unknown queued prompt is one this client did not type.
 */
export function mergeQueued(mine: PendingEcho[], queue: readonly QueuedPrompt[]): PendingEcho[] {
  const known = new Set(mine.map((p) => p.promptId).filter((v): v is string => !!v));
  const unlabelled = mine.filter((p) => !p.promptId).map((p) => p.text);
  const added: PendingEcho[] = [];
  for (const q of queue) {
    const id = typeof q.id === "string" ? q.id : "";
    if (!id || known.has(id)) continue;
    const sameText = unlabelled.indexOf(String(q.text ?? ""));
    if (sameText !== -1) {
      // it IS one of our unlabelled echoes — the promptId is on its way, do not duplicate the row
      unlabelled.splice(sameText, 1);
      continue;
    }
    added.push({
      id: `p${id}`,
      text: String(q.text ?? ""),
      at: Number(q.at) || Date.now(),
      promptId: id,
      images: q.images?.map((i) => i.url),
      ...(q.source ? { source: q.source } : {}),
    });
  }
  if (!added.length) return mine;
  return [...mine, ...added];
}

/**
 * Should a just-sent prompt be labelled "queued"?
 *
 * The rule is "something is ahead of it", not "the agent looks busy". The status the client holds can be one snapshot
 * stale, and deciding from it produced exactly the flicker the operator recorded — the row appeared un-queued, then
 * flipped to queued a frame later, re-ordering the list under them ("非queuedで、queuedより先に挿入 -> queuedになって
 * オーダーが直る", "queuedが無いときも一瞬queuedになってない状態がある").
 *
 * Counting what is already waiting is a local fact that does not change while the row exists:
 *   - nothing waiting → this prompt starts the agent, so it is never queued;
 *   - something waiting → it queues behind that from the first frame.
 */
export function queuedOnSend(pendingPrompts: number | undefined, alreadyPending: number): boolean {
  return (pendingPrompts ?? 0) > 0 || alreadyPending > 0;
}
