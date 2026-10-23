/**
 * Timeline ordering for queued (pending) user messages (#37).
 *
 * A pending message has not reached the model yet — it is queued behind whatever
 * the agent is doing — but its log row carries the seq it was TYPED at, so it
 * rendered above agent output that came after it. Echoes therefore sort below
 * everything the log already holds. A DELIVERED prompt is re-sequenced instead to
 * its `prompt-delivered` note, so it reads in true context order.
 */

export interface SeqRow {
  seq: number;
}

/**
 * Place echoes below every settled row, preserving their send order.
 *
 * Rows are not mutated — callers hand us rows they still own. The result is
 * SORTED, because a caller may already have re-sequenced a row (see
 * `resequenceToDelivery`) and the array order no longer reflects the seqs.
 */
export function placeEchoesBelow<T extends SeqRow>(visible: T[], echoes: T[]): T[] {
  if (!echoes.length) return [...visible].sort((a, b) => a.seq - b.seq);
  const maxSeq = visible.reduce((m, e) => Math.max(m, e.seq), 0);
  // An echo keeps the `seq` it was already assigned when its identity is otherwise unchanged:
  // re-deriving `maxSeq + 1 + i` on every rebuild gave every queued echo a new object (and a
  // moving seq), which re-mounted the pending row on each incoming event. An echo that already
  // sits BELOW every settled row keeps its position; only a new one is placed.
  const placed = echoes.map((e, i) =>
    e.seq > maxSeq ? e : { ...e, seq: maxSeq + 1 + i },
  );
  return [...visible, ...placed].sort((a, b) => a.seq - b.seq);
}

/**
 * Re-sequence a DELIVERED prompt's log row down to its delivery note, so it sits
 * where the model received it rather than where it was typed.
 */
export function resequenceToDelivery<T extends SeqRow>(row: T, noteSeq: number | undefined): T {
  if (noteSeq === undefined || noteSeq <= row.seq) return row;
  // Cached against the input row so repeated calls return the SAME object: `<For>` keys on
  // item identity, so spreading on every rebuild disposed and re-created a delivered prompt
  // row each time the timeline re-ran (its `seq` is stable, but the object was not).
  let bySeq = resequenceCache.get(row);
  if (!bySeq) {
    bySeq = new Map();
    resequenceCache.set(row, bySeq);
  }
  const hit = bySeq.get(noteSeq);
  if (hit) return hit as T;
  const moved = { ...row, seq: noteSeq } as T;
  bySeq.set(noteSeq, moved);
  return moved;
}

/** input row → (target seq → the derived row), so a stable input yields a stable output */
const resequenceCache = new WeakMap<object, Map<number, object>>();

/**
 * Where a not-yet-delivered message lands.
 *
 * ## Why this must be STABLE, not "one past the current maximum"
 *
 * It used to return `max(seq) + 1`, which changes the moment ANY new event is logged — so a
 * queued prompt was re-sequenced to a different value on every rebuild, giving it a brand-new
 * object each time. `<For>` keys on identity, so that prompt row was disposed and re-created
 * on every incoming event (measured: 4 of 18 rows replaced per append in the real bundle).
 *
 * Anchoring to the pinned row's OWN sequence keeps the value the same for as long as the row
 * itself is unchanged, which is what identity needs. Ordering still holds: every settled row
 * has `seq` below the floor at the time it was computed, and a prompt's own seq is by
 * definition below anything logged after it.
 */
export function pendingFloor(visible: SeqRow[], own?: number): number {
  if (own !== undefined) return own;
  return visible.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
}
