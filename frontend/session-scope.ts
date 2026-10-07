/**
 * Which timeline does a socket frame belong to? (#146)
 *
 * The timeline is per SESSION: `loadEvents` fetches `?session=<timelineId>` and
 * `select()` sets both the agent and the session, so a PAST session of the same
 * agent can be displayed. A frame identified only by `agentId` therefore cannot be
 * placed — and placing it wrongly is #40's report: agent2's message carrying
 * agent1's content, with a writing cursor.
 *
 * WIRING STATUS (be honest here — a predicate that only the tests import proves
 * nothing about the app, which is precisely how `pruneDeadLiveBuffers` ended up
 * "fully unit-tested" while its wiring was dead code (#40/#75)):
 *
 * - `deltaBelongsToTimeline` IS production-wired (App.tsx llm-delta branch).
 * - `eventBelongsOnTimeline` and `rowIsStillActive` are the REFERENCE
 *   predicates pinned by tests; App.tsx carries the equivalent inline forms.
 *   Known divergence: the inline event gate LETS a session-less event through
 *   where this predicate would drop it — a session-less event cannot be
 *   attributed, and today's events always carry one, so the difference is
 *   deliberate leniency for malformed frames. Do not cite this module as
 *   "wired" without checking App.tsx.
 */
/** a socket `event` frame */
export function eventBelongsOnTimeline(
  ev: { agent?: string; session?: string } | null | undefined,
  selectedAgent: string | null,
  timelineSession: string | null,
): boolean {
  if (!ev || !selectedAgent) return false;
  if (ev.agent !== selectedAgent) return false;
  // With no timeline resolved yet there is no OTHER session to confuse it with, so
  // the agent check alone is right — refusing everything would blank a new timeline.
  if (!timelineSession) return true;
  return ev.session === timelineSession;
}

/**
 * A socket `llm-delta` frame.
 *
 * `sessionId` is REQUIRED by the bus type. A frame without one cannot be
 * attributed, so it is NOT shown on any timeline: attributing it by guesswork is
 * the bug, and the cost of dropping it is one reload.
 */
export function deltaBelongsToTimeline(
  d: { agentId?: string; sessionId?: string | null } | null | undefined,
  selectedAgent: string | null,
  timelineSession: string | null,
): boolean {
  if (!d || !selectedAgent) return false;
  if (d.agentId !== selectedAgent) return false;
  if (!d.sessionId) return false;
  if (!timelineSession) return true;
  return d.sessionId === timelineSession;
}

/**
 * Is a tool row's "still in flight" chrome justified? (#120, #133, #146)
 *
 * `ToolRow` closes a stranded call via `!agentActive && !res`. If `agentActive` is
 * the agent's CURRENT live state, then with S2 running while S1 is displayed,
 * S1's unpaired tool row reads "running…" forever.
 */
export function rowIsStillActive(
  row: { data?: { actor?: unknown } } | null | undefined,
  agentLive: boolean,
  displayedSessionIsLive: boolean,
): boolean {
  if (!agentLive || !displayedSessionIsLive) return false;
  const actor = row?.data?.actor;
  return !(typeof actor === "string" && actor.length > 0);
}
