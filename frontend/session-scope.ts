/**
 * Which timeline does a socket frame belong to? (#146, #54)
 *
 * The timeline is per SESSION while `select()` also sets the agent, so a PAST
 * session of the same agent can be displayed — an `agentId` alone cannot place a
 * frame.
 *
 * THE FALLBACK VIEW is what makes this subtle: `timelineId()` is the AGENT ID
 * until the session index lands (`latestSessionOf(id) ?? id`), and an event's
 * `session` is always a real session id. A plain `ev.session === timelineId()`
 * comparison therefore matched NOTHING in that window, so the socket went silent
 * and only REST moved the feed (#54: "all bash stays running unless reloaded via
 * the API").
 *
 * All four predicates below share `timelineAcceptsSession()`. Three separate
 * copies of that decision is how they drifted apart in the first place.
 */

/**
 * Does a frame's session belong to the displayed timeline?
 *
 * @param shown   the displayed handle: a session id, or the agent id while no
 *                session is resolved (the fallback view)
 * @param agentId whose timeline it is — needed because the agent id is NOT a
 *                session and must never be compared as one
 */
export function timelineAcceptsSession(
  frameSession: string | null | undefined,
  shown: string | null | undefined,
  agentId: string | null | undefined,
): boolean {
  if (!shown) return true; // nothing resolved: no other session to confuse it with
  if (agentId && shown === agentId) return true; // fallback view — refusing this is #54
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
 * A frame without a `sessionId` is shown on NO timeline: it cannot be attributed,
 * and guessing is the bug. (The fallback exemption deliberately does not apply —
 * it would render another session's text as this one's.)
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
 * Is the DISPLAYED timeline the one that is live? (#120, #133)
 *
 * The snapshot carries the session the agent is on; when that equals what we are
 * showing, the agent-wide live flag is the right answer.
 */
export function timelineIsLive(
  agent: { id: string; session?: string } | null | undefined,
  shown: string | null | undefined,
  agentLive: boolean,
): boolean {
  if (!agentLive) return false;
  if (!agent || !shown) return true;
  if (shown === agent.id) return true; // fallback view, same rule as the frame gates
  if (!agent.session) return true;
  return agent.session === shown;
}
