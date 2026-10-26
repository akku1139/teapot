
export interface ArchivableAgent {
  id: string;
  workspaceMissing?: boolean;
}

export function pickAfterArchive(
  remaining: readonly ArchivableAgent[],
  removed: ReadonlySet<string>,
): ArchivableAgent | null {
  const rest = remaining.filter((a) => !removed.has(a.id));
  return rest.find((a) => !a.workspaceMissing) ?? rest[0] ?? null;
}
