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

/**
 * Drop the echoes the SERVER says are no longer queued — by ID, never by count.
 *
 * It used to trim the list to the snapshot's `pendingPrompts` count. That number is a snapshot taken a moment earlier, so
 * with two prompts in flight it could read 1 and cut the OLDER echo: its row disappeared, and the log row for the same
 * prompt (already in `events()`) took its place as if it had settled. MEASURED in a real browser: send two prompts while
 * the agent is running and the FIRST shows a timestamp while the second correctly shows "queued…" — "queuedが連なってるとき
 * の1つ目にqueuedじゃなくて黄色文字の時刻が出る".
 *
 * The client proposes the prompt id now, so every echo is nameable and the server's list is authoritative:
 * an id in `liveIds` stays, everything else is gone. With no list at all, nothing is trimmed — a missing snapshot is not
 * evidence that a prompt was delivered.
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
  /**
   * `promptId ?? id`: a locally echoed prompt is nameable before the POST returns, because the client proposes the id
   * (`clientId`). Matching only on `promptId` left a window of a few frames where the server's copy of the SAME prompt
   * looked unknown — the text fallback then had to rescue it, and any difference in whitespace made a duplicate row.
   */
  const idOf = (p: PendingEcho) => p.promptId ?? p.id;
  const known = new Set(mine.map(idOf).filter((v): v is string => !!v));
  // an echo with no `promptId` may still be the server's prompt under a different id (a send from another tab), so the
  // text comparison stays as the fallback for exactly those
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
      // it came from the server's queue, so it IS queued — otherwise its row would lose its ✕ cancel
      queued: true,
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
/**
 * The PROVISIONAL "queued" flag for a row that does not exist server-side yet.
 *
 * Only one thing is knowable before the request leaves: a turn is running, so this prompt cannot start immediately. The
 * server's `ahead` (from `POST /prompt`) replaces this value a moment later, and it is the only one that decides.
 *
 * Everything else was tried and MEASURED wrong: the snapshot's `pendingPrompts` lags (a stale non-zero count labelled a
 * prompt sent to an idle agent "queued…"), and counting this client's leftover echoes did the same.
 */
export const queuedOnSend = (agentBusy = false): boolean => agentBusy;

