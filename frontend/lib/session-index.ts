export function resolveTimelineSession(
  owned: readonly string[] | undefined,
  bound: string | null | undefined,
  requested?: string | null,
): string | null {
  const mine = owned ?? [];
  if (requested && mine.includes(requested)) return requested;
  if (bound && mine.includes(bound)) return bound;
  if (!requested && bound && mine.length === 0) return bound;
  return mine[0] ?? null;
}

export function linkableSessionId(
  handle: string | null | undefined,
  known: ReadonlyMap<string, string>,
  agentIds: readonly string[],
): string | null {
  if (!handle) return null;
  if (!known.has(handle) && agentIds.includes(handle)) return null;
  return handle;
}
