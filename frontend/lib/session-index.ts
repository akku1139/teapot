/**
 * Which session a timeline shows, and which session id may be written into the URL.
 *
 * Both answers come from SESSION data only — the agent's owned sessions, the session it is bound to, or a
 * session explicitly requested by the caller. Nothing here can return an AGENT id, and that is the invariant
 * the URL depends on: an agent id resolves to "that agent's latest session", so two tabs deep-linked to two
 * agent ids both collapsed onto one session (#routing).
 *
 * The guarantee used to be enforced at the WRITE site instead, by refusing ids that looked like agent ids.
 * That needs the agent list at write time, and a freshly created agent is not in it yet — so a new session
 * was written as its agent id ("新しくセッションを作ったときに…URLがエージェント間メッセージ用の短縮名に
 * なる"). Deciding at the source removes the failure mode rather than detecting it.
 */
export function resolveTimelineSession(
  owned: readonly string[] | undefined,
  bound: string | null | undefined,
  requested?: string | null,
): string | null {
  const mine = owned ?? [];
  if (requested && mine.includes(requested)) return requested;
  if (bound && mine.includes(bound)) return bound;
  // the index knows nothing about this agent (a session created a moment ago, or a scan that has not landed):
  // whatever the agent is bound to is the only truth available, and it is a session id either way
  if (bound && mine.length === 0) return bound;
  return mine[0] ?? null;
}
