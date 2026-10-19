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
  return status === "running" || status === "waiting";
}

/**
 * Is the live bubble already covered by the log?
 *
 * Not live -> stale by definition. Still live -> only when the log holds an
 * assistant message with exactly the text the bubble is showing.
 */
export function isCoveredByLog(
  buf: LiveBuf | null | undefined,
  events: { type?: string; data?: { role?: string; content?: string } }[],
  status: string | undefined,
): boolean {
  if (!buf) return false;
  if (!buf.text) return !isLiveStatus(status);
  if (!isLiveStatus(status)) return true;
  const body = buf.text.trim();
  return events.some(
    (e) =>
      e.type === "message" &&
      e.data?.role === "assistant" &&
      String(e.data.content ?? "").trim() === body,
  );
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
  events: { type?: string; data?: { role?: string; content?: string } }[],
  status: string | undefined,
): LiveBuf | null {
  if (!buf) return null;
  if (!isLiveStatus(status)) return null;
  if (isCoveredByLog(buf, events, status)) return null;
  return buf;
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
  if (a?.status === "running" || a?.status === "waiting") return startedAt;
  return 0;
}
