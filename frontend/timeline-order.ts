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
  const placed = echoes.map((e, i) => ({ ...e, seq: maxSeq + 1 + i }));
  return [...visible, ...placed].sort((a, b) => a.seq - b.seq);
}

/**
 * Re-sequence a DELIVERED prompt's log row down to its delivery note, so it sits
 * where the model received it rather than where it was typed.
 */
export function resequenceToDelivery<T extends SeqRow>(row: T, noteSeq: number | undefined): T {
  if (noteSeq === undefined || noteSeq <= row.seq) return row;
  return { ...row, seq: noteSeq };
}

/** Where a not-yet-delivered message lands: after everything the log holds now. */
export function pendingFloor(visible: SeqRow[]): number {
  return visible.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
}
