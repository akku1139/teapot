/**
 * Reconcile the themes this browser has with the themes the config file holds.
 *
 * #themes-merge: the sync added in v0.36.0 said "a server with themes wins, because they are the
 * durable copy". That is wrong in the direction that LOSES data, and it shipped: a config holding
 * one stale light theme replaced seven themes in the browser, so the appearance panel then offered
 * only light themes — reported as "follow the system がオフなのにライトテーマ(システムのテーマ)の
 * 選択肢しかでない".
 *
 * Neither side is authoritative. A theme can be made on a phone and not yet synced; the config can
 * hold themes from before this browser existed. So the resolved list is the UNION by id, with the
 * server's copy winning for an id both know (it is the durable one).
 *
 * Pure and dependency-free so it is unit-testable under `node --test`.
 */

/**
 * Structurally typed rather than importing `CustomTheme`: a sibling import needs an explicit `.ts`
 * extension under the scripts tsconfig while the frontend build rejects one, and the only thing this
 * function touches is `id`.
 */
export interface MergeableTheme {
  id: string;
}

export function mergeThemes<T extends MergeableTheme>(local: readonly T[], remote: readonly T[]): T[] {
  const byId = new Map<string, T>();
  // local first, then the server's copy overrides a shared id
  for (const t of local) byId.set(t.id, t);
  for (const t of remote) byId.set(t.id, t);
  return [...byId.values()];
}
