/**
 * Live-streaming buffer bookkeeping: ONE in-progress assistant buffer per agent,
 * so several agents can stream at once without clobbering each other.
 */

export interface LiveBuf {
  text: string;
  reasoning: string;
  at: number;
}

/**
 * Apply a streaming delta for one agent, returning the next map. Keyed per
 * agent, so a delta for one never touches another's buffer.
 */
export function applyDelta(
  prev: Map<string, LiveBuf>,
  agentId: string,
  patch: { text?: string; reasoning?: string },
  now = Date.now(),
): Map<string, LiveBuf> {
  const m = new Map(prev);
  m.set(agentId, {
    text: patch.text ?? "",
    reasoning: patch.reasoning ?? "",
    at: now,
  });
  return m;
}

/**
 * Clear one agent's buffer, returning the SAME map when there is nothing to
 * clear. Identity matters: Solid's reference-stabilization skips re-rendering
 * every expression bound to unchanged state, and returning a fresh Map for a
 * no-op would defeat it.
 */
export function clearLive(prev: Map<string, LiveBuf>, agentId: string): Map<string, LiveBuf> {
  if (!prev.has(agentId)) return prev;
  const m = new Map(prev);
  m.delete(agentId);
  return m;
}

/** True when a logged event marks the start of a NEW LLM turn for an agent. */
export function isTurnBoundary(ev: unknown): boolean {
  const e = ev as { type?: string; data?: { detail?: string } } | null;
  return e?.type === "state" && e.data?.detail === "llm turn start";
}

/** "Live" = mid-reply (`running`) or parked on an `ask_user` answer (`waiting`). */
export function isLiveStatus(status: string | undefined): boolean {
  return status === "running" || status === "waiting" || status === "needs_operator";
}

/**
 * What may still be painted from a live buffer, and whether the bubble is warranted at all.
 *
 * The buffer holds two halves that settle INDEPENDENTLY and for different reasons:
 *
 *   - `text` is retired when an assistant message in the log carries exactly that text. Until then
 *     the bubble is the only copy, and dropping it makes the reply VANISH then reappear.
 *   - `reasoning` is never logged as a message, so "is it covered" is the wrong question for it. It
 *     is STALE once the turn has moved past thinking — a tool call started after the last reasoning
 *     delta. The model cannot be thinking and executing at once.
 *
 * Asking both with one boolean is what left a 💭 block on the timeline above the tool row it had
 * already preceded: a reasoning-only buffer has no text to find, so the old function fell back to
 * "is the agent still live?", which stays TRUE through the whole turn including the tool run.
 *
 * Three things keep the bubble alive, and they are listed here rather than folded into the
 * predicates: leftover text, leftover reasoning, and a LIVE agent — an empty bubble is how the UI
 * says "working" before the first chunk arrives.
 */
export interface LiveBufferStatus {
  /** the log holds an assistant message with exactly this text — the text half may go */
  textCovered: boolean;
  /** the thinking stretch that produced this reasoning is over — the reasoning half may go */
  reasoningStale: boolean;
}

export function liveBufferStatus(
  buf: LiveBuf,
  events: { type?: string; ts?: string; data?: { role?: string; content?: string } }[],
  status: string | undefined,
): LiveBufferStatus {
  const text = buf.text.trim();
  const assistant = assistantTexts(events);
  const live = isLiveStatus(status);
  return {
    /**
     * EMPTY text is not "covered text" but there is nothing to lose, so it counts as retired. The
     * settling window is the subtle case: the turn has ended and the log holds NO assistant message
     * yet, so the event simply has not been delivered — that text is not redundant, it is early.
     */
    textCovered: !text || assistant.has(text),
    reasoningStale: !buf.reasoning.trim() || !live || startedToolCallSince(events, buf.at),
  };
}

/** The halves that may still be painted, after retiring whatever the log has caught up with. */
export function liveBufferRemainder(
  buf: LiveBuf,
  events: { type?: string; ts?: string; data?: { role?: string; content?: string } }[],
  status: string | undefined,
): { text: string; reasoning: string; live: boolean; empty: boolean } {
  const st = liveBufferStatus(buf, events, status);
  const text = st.textCovered ? "" : buf.text;
  const reasoning = st.reasoningStale ? "" : buf.reasoning;
  const live = isLiveStatus(status);
  /**
   * A LIVE agent keeps its bubble only while it still has something to show, or while it has shown
   * NOTHING yet.
   *
   * `sawContent` is the "nothing yet" case: before the first delta an empty bubble is how the UI
   * says "working", so it must survive. Once the buffer HAS carried content and both halves have
   * been retired, the bubble is spent — an agent running a tool is still `running`, and keeping the
   * bubble for that reason is what left a 💭 block over the tool row it preceded.
   */
  const nothingPending = !text.trim() && !reasoning.trim();
  const sawContent = !!buf.text.trim() || !!buf.reasoning.trim();
  return { text, reasoning, live, empty: nothingPending && (!live || sawContent) };
}

/**
 * Is the WHOLE live bubble redundant?
 *
 * Redundant only when it has nothing left to paint AND the agent is no longer working — a live
 * agent's empty bubble is the "working" indicator, not a leftover.
 */
export function isCoveredByLog(
  buf: LiveBuf | null | undefined,
  events: { type?: string; ts?: string; data?: { role?: string; content?: string } }[],
  status: string | undefined,
): boolean {
  // defensive: with no buffer there is no bubble, and the caller only asks when one exists
  if (!buf) return false;
  return liveBufferRemainder(buf, events, status).empty;
}

/**
 * Did a tool call START after this buffer's last delta?
 *
 * Reasoning for a turn arrives, then the model emits a tool call and stops thinking. An event later
 * than the last delta is proof the thinking stretch is over; deltas arriving after it push `at`
 * forward again, so a LATER stretch is not cleared by an earlier call.
 */
function startedToolCallSince(
  events: { type?: string; ts?: string }[],
  at: number,
): boolean {
  if (!at) return false;
  return events.some((e) => {
    /**
     * `tool_call`, NOT `tool_start`.
     *
     * `tool_start` does not exist — `EventType` declares `tool_call` (`data:{callId,name,args}`) and
     * `tool_result`. The check looked for a type nothing ever wrote, so it was ALWAYS false and the
     * stale-reasoning guard never fired: a 💭 block stayed on the timeline after the tool row it had
     * already preceded, again. MEASURED in a real session: the live bubble carried the exact
     * reasoning text of the settled assistant turn above it, with the tool row already drawn.
     *
     * The tests did not catch it because they built their fixtures with the same wrong string — a
     * fixture is only evidence when it matches what the system actually emits.
     */
    if (e.type !== "tool_call") return false;
    const t = Date.parse(String(e.ts ?? ""));
    return Number.isFinite(t) && t > at;
  });
}

/** the trimmed text of every assistant message the log currently holds */
function assistantTexts(events: { type?: string; data?: { role?: string; content?: string } }[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.type === "message" && e.data?.role === "assistant") out.add(String(e.data.content ?? "").trim());
  }
  return out;
}


/**
 * Is this row the SELECTED agent's own in-flight work?
 *
 * #40 — "agent2's message is agent1's content, with a writing cursor on it."
 * Marking a row live from the SELECTED agent's status alone paints rows that are
 * not its work. Two kinds exist:
 *
 *  1. MIRRORED SUB-AGENT ACTIVITY. The master appends a child's events into the
 *     parent's own log as `sub` rows, which the feed expands into
 *     normal-looking rows tagged with `actor` (see the expansion in App.tsx).
 *     Those rows are the CHILD's work: the parent going `running` says nothing
 *     about whether the child is still going.
 *  2. A TOOL CALL whose result never arrived — covered by ToolRow's `staleDone`
 *     guard once the agent is idle.
 *
 * A row with an `actor` is therefore never the selected agent's own work.
 */
export function isOwnLiveWork(row: { data?: { actor?: unknown } } | null | undefined): boolean {
  if (!row) return false;
  const actor = row.data?.actor;
  return !(typeof actor === "string" && actor.length > 0);
}

/**
 * Drop live buffers whose agent is no longer running or waiting (#40).
 *
 * The sweep must cover EVERY agent: nothing replays missed events on reconnect,
 * so an agent whose turn-boundary event was lost would keep its text on screen
 * — under a writing cursor — until a reload, because the buffers are memory-only.
 *
 * An agent with no reported status is LEFT ALONE rather than treated as idle:
 * absence of evidence is not evidence of completion, and the boundary event is
 * still its other clearing path.
 */
export function pruneDeadLiveBuffers<T>(
  buffers: ReadonlyMap<string, T>,
  statusOf: (agentId: string) => string | undefined,
): Map<string, T> {
  // Only allocate when something is actually dead: Solid skips re-rendering on
  // referential equality, and this runs on every snapshot the UI receives.
  const doomed: string[] = [];
  for (const id of buffers.keys()) {
    const st = statusOf(id);
    if (st === undefined) continue; // no snapshot: do not guess
    if (isLiveStatus(st)) continue; // one shared definition of "live"
    doomed.push(id);
  }
  if (doomed.length === 0) return buffers as Map<string, T>;
  const out = new Map(buffers);
  for (const id of doomed) out.delete(id);
  return out;
}

/**
 * Reconcile one agent's live buffer against the timeline it is about to show:
 * not live -> drop; already in the log -> drop; otherwise KEEP. The third is
 * what stops this becoming the opposite bug.
 *
 * #40: the sweep above runs only when `agents()` changes, so a buffer could
 * outlive the state that justified it. `select()` clears `events()` but never
 * touched `liveByAgent`, and if the agent was ALREADY idle at the switch the
 * snapshot did not change either — so nothing pruned, and returning to the
 * session re-displayed stale stream text WITH the writing cursor.
 */
export function reconcileLiveBuffer(
  buf: LiveBuf | null | undefined,
  events: { type?: string; ts?: string; data?: { role?: string; content?: string } }[],
  status: string | undefined,
): LiveBuf | null {
  if (!buf) return null;
  /**
   * Retire the halves the log has caught up with and KEEP the rest.
   *
   * Returning `null` for either signal drops content that is still the only copy — the settling
   * frame where a reply vanishes, or a reasoning block still streaming. Returning the buffer
   * unchanged for both is what left a 💭 block on screen after its tool row had already been
   * painted. One buffer, two independently-settling halves, so the result is a buffer with each
   * half cleared on its own evidence.
   */
  const rest = liveBufferRemainder(buf, events, status);
  if (rest.empty) return null;
  if (rest.text === buf.text && rest.reasoning === buf.reasoning) return buf;
  return { text: rest.text, reasoning: rest.reasoning, at: buf.at };
}

/**
 * Should the "💭 thinking" elapsed clock be cleared? (#131)
 *
 * Returns the value the clock should hold: the existing `startedAt` unless the
 * thinking block is no longer on screen, in which case 0 (the "not armed" sentinel).
 *
 * ## Why this is not just `setThinkStartedAt(0)` in the status sweep
 *
 * The original #131 was a session switch leaving `startedAt = 0` while the block was
 * visible, so `now() - 0` rendered as elapsed-since-the-EPOCH ("thinking 497531h").
 * The fix sentinel-guarded the timer, but the CLOCK was still zeroed from a status
 * effect — and a status transition is exactly what happens when thinking ends:
 *
 *     reasoning arrives      -> startedAt = T
 *     the turn's status flips -> effect zeroes it
 *     the block is still rendered -> now() - 0 -> "thinking 497531h 23m"
 *
 * which is the reported "reasoning が終わった瞬間に発生した" (no session switch needed).
 *
 * So the clock may only be cleared when the block it measures is GONE — no live
 * buffer for the displayed session and nothing still streaming. A status change alone
 * must not touch it.
 */
export function clearThinkClockIfDone(
  startedAt: number,
  agents: readonly { id: string; status?: string; session?: string }[],
  selected: string | null | undefined,
  live: { text: string; reasoning: string } | null | undefined,
): number {
  if (!startedAt) return 0; // already idle: nothing to clear
  // the bubble IS the thinking block; while it exists, the clock is meaningful
  if (live) return startedAt;
  if (!selected) return 0;
  const a = agents.find((x) => x.id === selected);
  // the displayed agent is mid-turn: reasoning may arrive again on the next chunk, and
  // re-arming would restart an elapsed time the operator is already reading
  if (a?.status === "running" || a?.status === "waiting" || a?.status === "needs_operator") {
    return startedAt;
  }
  return 0;
}
