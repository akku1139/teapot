
export interface QuestionEvent {
  type: string;
  seq: number;
  data?: {
    callId?: unknown;
    source?: unknown;
    event?: unknown;
  };
}

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
  if (lastQuestionAt >= 0 && lastUserPromptAt > lastQuestionAt) {
    for (const e of events)
      if (e.type === "question" && e.seq <= lastUserPromptAt)
        set.add(String(e.data?.callId ?? ""));
  }
  for (const id of locallyAnswered) set.add(id);
  return set;
}
