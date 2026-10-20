/**
 * Which session's timeline should open for an agent.
 *
 * #58: an EXPLICIT request (a deep link, browser Back/Forward, or the session
 * switcher) is authoritative. It is honoured only when the agent really owns
 * that session, so a crafted URL cannot cross into another agent's timeline.
 *
 * `owned` is the agent's session ids, newest first. `bound` is the session the
 * agent is currently attached to.
 *
 * #141: a pure module on purpose, so App.tsx has ONE implementation to call and
 * the tests cannot re-implement it.
 */
export function resolveTimelineSession(
  owned: readonly string[] | undefined,
  /** `null` is "this agent has no bound session" — the same as `undefined` to the code
   * below (`if (bound && …)`), which is why both are accepted. */
  bound: string | null | undefined,
  requested?: string | null,
): string | null {
  const mine = owned ?? [];
  if (requested && mine.includes(requested)) return requested;
  if (bound && mine.includes(bound)) return bound;
  // #146: the session INDEX may not have landed yet (a brand-new agent whose
  // first session dir is not scanned): with NO ownership data, the bound session
  // is the best guess — it is the session the agent is attached to. Once
  // ownership data EXISTS, a bound session outside it is STALE, and opening it
  // yields an empty timeline that looks like lost history.
  if (!requested && bound && mine.length === 0) return bound;
  return mine[0] ?? null;
}
