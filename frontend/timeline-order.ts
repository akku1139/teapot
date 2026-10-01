/**
 * Timeline ordering for queued (pending) user messages.
 *
 * #37: "pending messages should appear at the BOTTOM of the timeline, because
 * they are sent to the LLM after the messages already on the timeline."
 *
 * A pending message has NOT been delivered to the model yet — it is queued
 * behind whatever the agent is doing. The timeline read it as if it had already
 * happened (its log row carries the seq it was TYPED at), so the operator saw
 * their queued message sitting above agent output that came after it.
 *
 * The UI already re-sequences a DELIVERED prompt down to its
 * prompt-delivered note for the same reason ("read in true context order").
 * Undelivered echoes need the same treatment: they belong after everything the
 * log already contains.
 *
 * Pure and dependency-free so it is unit-testable under `node --test`.
 */

export interface SeqRow {
  seq: number;
}

/**
 * Place echoes (pending, undelivered user messages) below every settled row,
 * preserving their own send order.
 *
 * `visible` rows keep their seq. Each echo is given a seq above the log's
 * maximum, in send order, so the block reads top-down the way the operator
 * typed it. The input rows are NOT mutated — callers hand us rows they still
 * own, and mutating them here would corrupt the event cache.
 */
export function placeEchoesBelow<T extends SeqRow>(visible: T[], echoes: T[]): T[] {
  if (!echoes.length) return visible;
  const maxSeq = visible.reduce((m, e) => Math.max(m, e.seq), 0);
  const placed = echoes.map((e, i) => ({ ...e, seq: maxSeq + 1 + i }));
  return [...visible, ...placed];
}

/**
 * Re-sequence a DELIVERED user prompt's log row down to its delivery note, so
 * it sits where the model actually received it rather than where it was typed.
 */
export function resequenceToDelivery<T extends SeqRow>(row: T, noteSeq: number | undefined): T {
  if (noteSeq === undefined || noteSeq <= row.seq) return row;
  return { ...row, seq: noteSeq };
}

/**
 * Where a not-yet-delivered message will eventually land: after everything the
 * log holds now. Used by the UI to keep the echo pinned below the last row
 * without needing the log's max seq directly.
 */
export function pendingFloor(visible: SeqRow[]): number {
  return visible.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
}