
export interface KeyPoolState {
  keys: string[];
  current: number;
}

export function makeKeyPool(keys: readonly string[]): KeyPoolState {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const k of keys) {
    const t = typeof k === "string" ? k.trim() : "";
    if (!t || seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
  }
  return { keys: unique, current: 0 };
}

export function currentKey(pool: KeyPoolState | null | undefined): string | null {
  if (!pool) return null;
  return pool.keys[pool.current] ?? null;
}

export function nextKey(pool: KeyPoolState): string | null {
  const next = pool.current + 1;
  if (next >= pool.keys.length) return null;
  pool.current = next;
  return pool.keys[next]!;
}

export function resetPool(pool: KeyPoolState): void {
  pool.current = 0;
}

export function poolSize(pool: KeyPoolState): number {
  return pool.keys.length;
}

export function isRateLimitStatus(status: number | undefined): boolean {
  return status === 429 || status === 402 || status === 403;
}
