/**
 * Keep a background-job row's identity across snapshots.
 *
 * A snapshot is rebuilt on every `agent-update`, and `<For>` keys on item identity — so handing it the fresh array would
 * dispose and recreate every card, losing an expanded `<details>` and any inner scroll. A job's FIELDS decide; its elapsed
 * time is rendered from `startedAt` and is not part of the snapshot, so a running job is not "changed" merely by existing.
 */
export interface BgJobLike {
  id: string;
  cmd: string;
  running: boolean;
  detached?: boolean | undefined;
  pid?: number | null | undefined;
  code?: number | null | undefined;
  startedAt: number;
  tail: string;
  truncated?: boolean | undefined;
}

function sameJob(a: BgJobLike, b: BgJobLike): boolean {
  return (
    a.cmd === b.cmd &&
    a.running === b.running &&
    a.detached === b.detached &&
    a.pid === b.pid &&
    a.code === b.code &&
    a.startedAt === b.startedAt &&
    a.tail === b.tail &&
    a.truncated === b.truncated
  );
}

export function mergeBgJobs<T extends BgJobLike>(prev: readonly T[], next: readonly T[]): readonly T[] {
  const before = new Map(prev.map((j) => [j.id, j]));
  let same = prev.length === next.length;
  const merged = next.map((j): T => {
    const old = before.get(j.id);
    if (old && sameJob(old, j)) return old as T;
    same = false;
    return j;
  });
  return same ? prev : merged;
}
