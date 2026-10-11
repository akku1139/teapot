/**
 * Which timeline does a socket frame belong to? (#146, #54)
 *
 * The timeline is per SESSION: `loadEvents` fetches `?session=<timelineId>` and
 * `select()` sets both the agent and the session, so a PAST session of the same
 * agent can be displayed. A frame identified only by `agentId` therefore cannot be
 * placed — and placing it wrongly is #40's report: agent2's message carrying
 * agent1's content, with a writing cursor.
 *
 * THE FALLBACK VIEW. `timelineId()` is the AGENT ID whenever no session has been
 * resolved yet: `select()` does `latestSessionOf(id) ?? id`, and the session index
 * lands asynchronously (it is one request, fetched on mount and on an agent-set
 * change). In that window an event's `session` is a real session id, so a plain
 * `ev.session === timelineId` comparison matches NOTHING.
 *
 * That is #54: the socket became a no-op, only the REST refresh moved the feed,
 * and a tool row whose result arrived over the socket stayed "running…" until an
 * API reload. Reported as "all bash stays running unless reloaded via the API",
 * and as the very first observation on the issue: the API path completes it, so
 * the socket path is what is broken.
 *
 * Measured, in the built bundle under happy-dom: with the fallback timeline in
 * force, an `event` frame carrying `session:"alpha-s1"` never reached the feed,
 * while the identical frame carrying `session:"alpha"` (the agent id) rendered
 * immediately. Both gates were verified independently.
 *
 * So ALL THREE predicates below share ONE `timelineAcceptsSession()` rule. Three
 * copies of this decision is how they drifted apart in the first place — the
 * event gate, the delta gate and `isTimelineLive()` disagreed about the same
 * fallback, and the disagreement was invisible until the socket went silent.
 */

/**
 * Does a frame's session belong to the displayed timeline?
 *
 * `shown` is the displayed timeline handle: a session id, or the agent id while
 * no session is resolved yet (the fallback view). `agentId` is the agent whose
 * timeline it is, so the fallback can be recognised — the agent id is not a
 * session and must never be compared as one.
 */
export function timelineAcceptsSession(
  frameSession: string | null | undefined,
  shown: string | null | undefined,
  agentId: string | null | undefined,
): boolean {
  // No timeline resolved at all: there is no OTHER session to confuse it with.
  if (!shown) return true;
  // The fallback view: the newest tail IS this agent's current session, so live
  // frames belong here. Refusing them is #54.
  if (agentId && shown === agentId) return true;
  if (typeof frameSession !== "string") return false;
  return frameSession === shown;
}

/** a socket `event` frame */
export function eventBelongsOnTimeline(
  ev: { agent?: string; session?: string } | null | undefined,
  selectedAgent: string | null,
  timelineSession: string | null,
): boolean {
  if (!ev || !selectedAgent) return false;
  if (ev.agent !== selectedAgent) return false;
  return timelineAcceptsSession(ev.session, timelineSession, selectedAgent);
}

/**
 * A socket `llm-delta` frame.
 *
 * `sessionId` is REQUIRED by the bus type. A frame without one cannot be
 * attributed, so it is NOT shown on any timeline: attributing it by guesswork is
 * the bug, and the cost of dropping it is one reload.
 *
 * The fallback-view exemption is deliberately NOT applied here: a delta must
 * name its session, or text from another session would render as this one's.
 * `timelineAcceptsSession` returns true for the fallback, but the missing-id
 * check above has already rejected the frame, which is the behaviour the
 * llm-delta contract wants.
 */
export function deltaBelongsToTimeline(
  d: { agentId?: string; sessionId?: string | null } | null | undefined,
  selectedAgent: string | null,
  timelineSession: string | null,
): boolean {
  if (!d || !selectedAgent) return false;
  if (d.agentId !== selectedAgent) return false;
  if (!d.sessionId) return false;
  return timelineAcceptsSession(d.sessionId, timelineSession, selectedAgent);
}

/**
 * Is the DISPLAYED timeline the one that is live?
 *
 * The agent's snapshot carries the session it is currently on; when that equals
 * the timeline being shown, the agent-wide live flag is the right answer.
 */
export function timelineIsLive(
  agent: { id: string; session?: string } | null | undefined,
  shown: string | null | undefined,
  agentLive: boolean,
): boolean {
  if (!agentLive) return false;
  if (!agent || !shown) return true;
  // the fallback view — same rule as the frame gates, so they cannot disagree
  if (shown === agent.id) return true;
  if (!agent.session) return true;
  return agent.session === shown;
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
