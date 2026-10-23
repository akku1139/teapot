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

/**
 * Should this handle be written into `/session/<id>`?
 *
 * The URL is the SHARED state between tabs, so a wrong handle there is a cross-tab bug. Two tabs
 * deep-linked to different sessions both turned into `/session/<agentId>` after a restart, because
 * `tid` fell back to the agent id when the session index had not landed — and an agent id resolves
 * to that agent's LATEST session, so both tabs opened the same one.
 *
 * @param handle  what the caller wants to put in the URL
 * @param known   the session index (internal session id → agent id); empty means "not loaded"
 * @param agentIds every configured agent id
 */
export function linkableSessionId(
  handle: string | null | undefined,
  known: ReadonlyMap<string, string>,
  agentIds: readonly string[],
): string | null {
  if (!handle) return null;
  /**
   * An agent id is not a session id — refuse it whether or not the index has landed.
   *
   * That single check is the fix for the two-tabs bug: `/session/<agentId>` later resolves through
   * `latestSessionOf` to that agent's LATEST session, so every tab that deep-linked an agent id
   * converged on one session. Nothing else needs guarding.
   *
   * A session id the index cannot confirm YET (a directory not scanned, or the index still empty)
   * is still written: it is the handle the server answers `?session=<id>` for, and blanking the URL
   * instead would lose a deep link the operator just opened.
   */
  if (!known.has(handle) && agentIds.includes(handle)) return null;
  return handle;
}
