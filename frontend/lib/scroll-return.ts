/**
 * Returning to the place the operator was reading when they left a session (#205).
 *
 * This was tried once and removed three times over, because it kept landing people "遥か昔のメッセージ" — the saved
 * position silently came from a stale frame, or pointed at an event that the new timeline did not contain, and the
 * restore wrote a `scrollTop` that meant something else in the new content. The lesson recorded then was blunt: a
 * remembered position is not a preference, and restoring one is only safe when the anchor can be PROVEN present.
 *
 * So the shape here is different from that attempt in one essential way: everything is keyed by a row that must be
 * found in the new timeline, including its session. Nothing is restored by number alone.
 */
export type SavedSpot = {
  /**
   * The TIMELINE id the spot belongs to.
   *
   * It used to be the session recorded on the row (`data-session`), which is the name in the LOG — that differs from
   * the timeline id whenever the session has been copied or renamed, and then the capture and the restore disagreed
   * about the key and the spot was never found (MEASURED: saved under `mediapad-…`, looked up as `sw-A`).
   */
  session: string;
  /** the event id of the row that was at the top of the viewport */
  eid: string;
  /** how far into that row the viewport started, in px (0 = the row's own top) */
  offset: number;
};

export type RowGeom = { eid: string; session: string; top: number; height: number };

/**
 * Which row was at the top of the viewport, and how deep into it the reader was.
 *
 * `top` values are whatever the caller measured (getBoundingClientRect), because they must be internally consistent:
 * the difference between the feed's top and a row's top is the only thing used later.
 */
export function spotFromRows(
  rows: readonly RowGeom[],
  feedTop: number,
  session: string,
): SavedSpot | null {
  if (!session) return null;
  /**
   * The first row whose BOTTOM edge is below the feed's top edge — no session filtering.
   *
   * The rows on screen ARE the timeline being left (that is why the capture reads the live feed), and a mirrored
   * sub-agent row belongs to that timeline too. Filtering by the row's own session only re-introduced the key mismatch
   * above.
   */
  const row = rows.find((r) => r.top + r.height > feedTop + 0.5);
  if (!row) return null;
  const offset = Math.min(Math.max(0, Math.round(feedTop - row.top)), Math.max(0, Math.round(row.height)));
  return { session, eid: row.eid, offset };
}

/**
 * Where to put `scrollTop` when the operator comes back — or `null` to leave it at the tail.
 *
 * Every rejection below is a bug this feature has already caused at least once:
 *   - the anchor row is not in the loaded window → restoring would guess, so fall back to the tail;
 *   - the row belongs to a different session → the id is ambiguous, so fall back;
 *   - the result is (within a pixel) the tail → the tail path already does that, and doing it here would pin a
 *     reader who had actually been at the bottom;
 *   - the caller says the feed was at the tail when it was saved → nothing to restore.
 */
export function restoreTop(
  spot: SavedSpot | null | undefined,
  rows: readonly RowGeom[],
  maxTop: number,
): number | null {
  if (!spot) return null;
  const row = rows.find((r) => r.eid === spot.eid);
  if (!row) return null;
  /**
   * `row.top` is measured in the new feed (at its top), so it IS the row's content offset — and the viewer was
   * `spot.offset` px INTO that row, i.e. `scrollTop = contentTop + offset`. The subtraction this first shipped with
   * put the reader one offset ABOVE the row they were reading, which is exactly the "why am I somewhere else" shape.
   */
  const top = Math.max(0, Math.min(maxTop, Math.round(row.top + spot.offset)));
  if (Number.isFinite(maxTop) && top >= maxTop - 1) return null;
  return top;
}
