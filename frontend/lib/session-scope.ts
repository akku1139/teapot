
export function timelineAcceptsSession(
  frameSession: string | null | undefined,
  shown: string | null | undefined,
  agentId: string | null | undefined,
): boolean {
  if (!shown) return true; 
  if (agentId && shown === agentId) return true; 
  if (typeof frameSession !== "string") return false;
  return frameSession === shown;
}

export function eventBelongsOnTimeline(
  ev: { agent?: string; session?: string } | null | undefined,
  selectedAgent: string | null,
  timelineSession: string | null,
): boolean {
  if (!ev || !selectedAgent) return false;
  if (ev.agent !== selectedAgent) return false;
  return timelineAcceptsSession(ev.session, timelineSession, selectedAgent);
}

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

export function timelineIsLive(
  agent: { id: string; session?: string } | null | undefined,
  shown: string | null | undefined,
  agentLive: boolean,
): boolean {
  if (!agentLive) return false;
  if (!agent || !shown) return true;
  if (shown === agent.id) return true; 
  if (!agent.session) return true;
  return agent.session === shown;
}
