
export interface SeqRow {
  seq: number;
}

export function placeEchoesBelow<T extends SeqRow>(visible: T[], echoes: T[]): T[] {
  if (!echoes.length) return [...visible].sort((a, b) => a.seq - b.seq);
  const maxSeq = visible.reduce((m, e) => Math.max(m, e.seq), 0);
  const placed = echoes.map((e, i) =>
    e.seq > maxSeq ? e : { ...e, seq: maxSeq + 1 + i },
  );
  return [...visible, ...placed].sort((a, b) => a.seq - b.seq);
}

export function resequenceToDelivery<T extends SeqRow>(row: T, noteSeq: number | undefined): T {
  if (noteSeq === undefined || noteSeq <= row.seq) return row;
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

const resequenceCache = new WeakMap<object, Map<number, object>>();

export function pendingFloor(visible: SeqRow[], own?: number): number {
  if (own !== undefined) return own;
  return visible.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
}
