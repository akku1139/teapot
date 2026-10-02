/**
 * Live-streaming buffer bookkeeping.
 *
 * The UI keeps ONE in-progress assistant buffer per agent, so several agents
 * can stream at once without clobbering each other. What goes wrong is not the
 * keying — it is WHEN a buffer is dropped.
 *
 * #40: an agent's `status` does not change between tool calls within one round,
 * so a finished reply's buffer was never cleared. The feed refresh only drops
 * it once a persisted assistant message matches its text, and the
 * `status !== "running"` short-circuit kept it alive until then — leaving the
 * previous turn's text on screen under the streaming…/writing… chrome.
 *
 * These helpers are pure and dependency-free so they can be unit-tested under
 * `node --test` without pulling in solid-js.
 */

export interface LiveBuf {
  text: string;
  reasoning: string;
  at: number;
}

/**
 * Apply a streaming delta for one agent, returning the next map.
 *
 * A delta never touches another agent's buffer — that per-agent isolation is
 * the whole point of the map (an earlier single-slot design made every session
 * switch clobber the visible reply).
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

/**
 * Should the live bubble be dropped because the log now covers what it shows?
 *
 * `status !== "running"` means the agent is no longer mid-reply, so the buffer
 * is definitionally stale. Otherwise the log must contain an assistant message
 * whose text is exactly what the bubble is showing.
 */
export function isCoveredByLog(
  buf: LiveBuf | null | undefined,
  events: { type?: string; data?: { role?: string; content?: string } }[],
  status: string | undefined,
): boolean {
  if (!buf) return false;
  if (!buf.text) return status !== "running";
  if (status !== "running") return true;
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
 * The timeline marked every row live based on the selected agent's status
 * alone, so a row could wear another actor's "writing…" / "running…" chrome.
 *
 * Two kinds of row can do that, and both are real:
 *
 *  1. MIRRORED SUB-AGENT ACTIVITY. The master appends a child's events into
 *     the parent's own log as `sub` rows, which the feed expands into
 *     normal-looking rows tagged with `actor` (see the expansion in App.tsx).
 *     Those rows are the CHILD's work: they belong in the parent's feed for
 *     context, but the parent going `running` says nothing about whether the
 *     child is still going, so painting them as the parent's live work is
 *     simply wrong.
 *  2. A TOOL CALL whose result never arrived. A row with no result and a live
 *     agent reads as "in flight"; once the agent is idle it is simply stale,
 *     and the existing `staleDone` guard in ToolRow already covers that.
 *
 * A row with an `actor` is therefore never the selected agent's own work.
 * Everything else — the parent's own messages, tool calls and results — is.
 */
export function isOwnLiveWork(row: { data?: { actor?: unknown } } | null | undefined): boolean {
  if (!row) return false;
  const actor = row.data?.actor;
  return !(typeof actor === "string" && actor.length > 0);
}