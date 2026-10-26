
export interface MergeableTheme {
  id: string;
}

export function mergeThemes<T extends MergeableTheme>(local: readonly T[], remote: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const t of local) byId.set(t.id, t);
  for (const t of remote) byId.set(t.id, t);
  return [...byId.values()];
}
