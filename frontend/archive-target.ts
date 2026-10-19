/**
 * Which agent the UI should show after archiving one (#archive).
 *
 * The handler used to pick `rest[0]` — the first remaining row. That can be a 👻 ghost
 * (its workspace directory is gone), so tidying up dumped the operator onto a dead
 * session: they archive something to clean up and immediately land somewhere that
 * cannot run. Reported as "archiveするとghostなセッションに移動してしまう".
 *
 * Kept as a pure function because the rule is a small ordering decision that is easy to
 * get wrong and impossible to see in a component test.
 */

export interface ArchivableAgent {
  id: string;
  workspaceMissing?: boolean;
}

/**
 * The agent to select after archiving, or null when nothing usable remains.
 *
 * Preference order:
 *   1. a live-looking agent (workspace present) — in the order given;
 *   2. any remaining agent, ghost or not, rather than showing nothing;
 *   3. null when the list is empty (the caller clears the timeline).
 *
 * A ghost is still better than a blank screen when it is all that is left, which is why
 * step 2 exists — the complaint is about being sent to one when a real one was
 * available, not about ghosts existing.
 */
export function pickAfterArchive(
  remaining: readonly ArchivableAgent[],
  removed: ReadonlySet<string>,
): ArchivableAgent | null {
  const rest = remaining.filter((a) => !removed.has(a.id));
  return rest.find((a) => !a.workspaceMissing) ?? rest[0] ?? null;
}
