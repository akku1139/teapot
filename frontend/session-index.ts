/**
 * Which session's timeline should open for an agent.
 *
 * #58: an EXPLICIT request (a deep link, browser Back/Forward, or the session
 * switcher) is authoritative — it used to be discarded, so `/session/<id>`
 * silently opened whatever session was bound and then REWROTE the URL to match.
 * It is honoured only when the agent really owns that session, so a crafted URL
 * cannot cross into another agent's timeline.
 *
 * #141: extracted from App.tsx. It was a closure, which meant
 * `test/session-switcher.test.ts` had to re-implement it — three tests that
 * asserted a COPY and covered no shipped code at all. The function is pure in its
 * three inputs, so it can be imported and tested directly.
 *
 * `owned` is the agent's session ids, newest first. `bound` is the session the
 * agent is currently attached to.
 */
export function resolveTimelineSession(
  owned: readonly string[] | undefined,
  bound: string | undefined,
  requested?: string | null,
): string | null {
  const mine = owned ?? [];
  if (requested && mine.includes(requested)) return requested;
  if (bound && mine.includes(bound)) return bound;
  // #146: the session INDEX may not have landed yet (a brand-new agent whose
  // first session dir is not scanned): with NO ownership data, the bound
  // session is the best guess — it is the session the agent is attached to.
  // (The alternative is the agent ID, which is NOT a session and will mismatch.)
  // But once ownership data EXISTS, a bound session outside it is STALE — its
  // directory is gone, and opening it yields an empty timeline that looks like
  // lost history (the three session-switcher tests pin this invariant: the
  // result is always one the agent owns, or null).
  if (!requested && bound && mine.length === 0) return bound;
  return mine[0] ?? null;
}
