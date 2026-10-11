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
  // #37: a DELIVERED prompt's seq is rewritten to its delivery note (see
  // `resequenceToDelivery`), and echoes get seqs above the log's max. Either way
  // the caller has handed us rows whose order is no longer the array order, so
  // the result must be SORTED.
  //
  // This used to return `visible` unchanged when there were no echoes, which
  // looked like a harmless shortcut and was not: the resequenced prompt kept its
  // original slot, so a message sent while the agent was working rendered ABOVE
  // the agent output that preceded its delivery instead of below it. Reproduced
  // from a real log — prompt e3228 (delivery note e3234) rendered before e3230.
  if (!echoes.length) return [...visible].sort((a, b) => a.seq - b.seq);
  const maxSeq = visible.reduce((m, e) => Math.max(m, e.seq), 0);
  const placed = echoes.map((e, i) => ({ ...e, seq: maxSeq + 1 + i }));
  return [...visible, ...placed].sort((a, b) => a.seq - b.seq);
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