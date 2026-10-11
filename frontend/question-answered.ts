/**
 * Which `ask_user` questions count as answered.
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
 *
 * #75: extracted from App.tsx so the tests drive the code that runs.
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
  // a logged reply closes every question at or before it
  if (lastQuestionAt >= 0 && lastUserPromptAt > lastQuestionAt) {
    for (const e of events)
      if (e.type === "question" && e.seq <= lastUserPromptAt)
        set.add(String(e.data?.callId ?? ""));
  }
  // …plus this tab's optimistic answers, whose reply is not logged yet
  for (const id of locallyAnswered) set.add(id);
  return set;
}
