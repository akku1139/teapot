/**
 * Where a timeline should be positioned after a session switch.
 *
 * There is always an answer. The old code had a third one — "say nothing and leave the feed where it is" — and
 * that is the bug: after a switch the feed sits at `scrollTop = 0`, the OLDEST message in the window, reported as
 * "セッション遷移したときに遥か昔のメッセージに飛ばされることがある". It was intermittent because it needed a saved
 * anchor whose row no longer existed (compaction, an evicted page, a different window), which is exactly when
 * nobody looks.
 */
export type RestoreTarget = "anchor" | "tail";

export function restoreTarget(
  saved: { eid: string } | null | undefined,
  anchorRowFound: boolean,
): RestoreTarget {
  if (!saved) return "tail"; // first visit in this tab
  if (!anchorRowFound) return "tail"; // the row is gone: land where a timeline starts, not at the top
  return "anchor";
}
