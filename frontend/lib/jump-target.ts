/**
 * May a "scroll to this event" jump use the row it found?
 *
 * `data-eid` is a per-session counter (`e1`, `e2`…), so a lookup performed while the feed still renders the PREVIOUS
 * session finds that session's row with the same id. Reported from a session switch: the timeline flew to
 * `<div class="msg withdrawn" data-eid="e90468" data-session="teapot-10-16854917">` — a row belonging to the session
 * that had just been left.
 *
 * A row without the attribute is trusted (logs from before it existed); a row that names a DIFFERENT session is not.
 */
export function jumpTargetMatches(rowSession: string | undefined, currentTimeline: string): boolean {
  const row = String(rowSession ?? "").trim();
  if (!row) return true;
  if (!currentTimeline) return true;
  return row === currentTimeline;
}
