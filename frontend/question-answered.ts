/**
 * Which `ask_user` questions count as answered.
 *
 * #75 — this lived inline in App.tsx, so `test/ask-user-answered.test.ts`
 * re-implemented it locally and asserted against its own copy. Removing either
 * half of the real logic — the optimistic mark, or the log-wins rule — left all
 * nine tests passing, because the replica still had both.
 *
 * Extracted so the tests drive the code that runs.
 *
 * Two sources of truth, and they compose:
 *
 *  - the LOG: any user reply after the latest open question closes every earlier
 *    question of that session, because the agent loop resumes on the first
 *    reply. A `prompt-delivered` system note counts as the reply, since it marks
 *    a queued prompt actually reaching the model.
 *  - THIS TAB: a question answered optimistically has no logged reply yet, so
 *    without it the row would stay enabled and could be answered twice.
 *
 * A session switch clears the second set — one session's answers must not follow
 * the operator into another session.
 */

export interface QuestionEvent {
  type: string;
  seq: number;
  data?: {
    callId?: unknown;
    source?: unknown;
    event?: unknown;
  };
}

/**
 * Ids of every question that should render as answered.
 *
 * `locallyAnswered` is this tab's optimistic set; pass an empty set to ask only
 * what the log says.
 */
export function answeredQuestionIdsOf(
  events: readonly QuestionEvent[],
  locallyAnswered: ReadonlySet<string> = new Set(),
): Set<string> {
  const set = new Set<string>();
  let lastQuestionAt = -1;
  let lastUserPromptAt = -1;
  for (const e of events) {
    if (e.type === "question") lastQuestionAt = e.seq;
    else if (e.type === "prompt" && e.data?.source === "user") lastUserPromptAt = e.seq;
    else if (e.type === "system_note" && e.data?.event === "prompt-delivered")
      lastUserPromptAt = Math.max(lastUserPromptAt, e.seq);
  }
  // any user reply after the latest open question closes ALL earlier questions
  // of this session (the loop resumes on the first reply)
  if (lastQuestionAt >= 0 && lastUserPromptAt > lastQuestionAt) {
    for (const e of events)
      if (e.type === "question" && e.seq <= lastUserPromptAt)
        set.add(String(e.data?.callId ?? ""));
  }
  // …plus anything answered in this tab whose reply has not been logged yet
  for (const id of locallyAnswered) set.add(id);
  return set;
}
