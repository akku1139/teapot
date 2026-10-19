/**
 * Multiple API keys per provider (#170) — "複数鍵登録しといて、規定のリトライ回数を超えたら
 * 次の鍵にローテ / 全キーを回ってもまだレートリミットだったらエラーで停止".
 *
 * ## The algorithm, deliberately small
 *
 * A request is made with the current key. The HTTP client already retries a rate limit
 * a fixed number of times on that key (its own backoff ladder). When those retries are
 * spent and the failure is STILL a rate limit, the pool moves to the next key and the
 * whole ladder runs again on it. When the last key is exhausted too, the error is
 * raised and the turn stops.
 *
 * That is the entire policy:
 *
 *     key1 [retry × N]  ->  key2 [retry × N]  ->  …  ->  raise
 *
 * ## What this intentionally does NOT do
 *
 * An earlier version of this file tracked per-key "recovered at" timestamps, parsed
 * provider reset hints, classified a 429 as transient-vs-exhausted, and persisted spent
 * accounts to disk. None of that was asked for, none of it was generic (the hint
 * formats are provider-specific), and the operator's actual ask is the loop above. A
 * simpler rule is also easier to reason about when it goes wrong: with this policy the
 * only state is "which key am I on", and the only outcome is success or a raised error.
 *
 * ## Provider-agnostic
 *
 * Nothing here knows about any particular endpoint. "Rate limited" is the HTTP 429 that
 * every OpenAI-compatible provider uses; the caller decides which statuses qualify.
 */

/** Which keys a provider has, and which one is in use. That is the whole state. */
export interface KeyPoolState {
  /** unique, non-empty keys, in config order */
  keys: string[];
  /** index of the key currently in use */
  current: number;
}

/** Build a pool from config order, dropping blanks and duplicates. */
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

/** The key in use, or null for an empty pool (or no pool at all). */
export function currentKey(pool: KeyPoolState | null | undefined): string | null {
  // tolerate a missing pool: most callers simply have no `keyPool`, and making every
  // one of them guard first is how a `undefined.keys` crash reaches a 400 (measured)
  if (!pool) return null;
  return pool.keys[pool.current] ?? null;
}

/**
 * Move to the next key, or null when every key has already had its turn.
 *
 * Null is the "全キーを回ってもまだレートリミットだった" signal: the caller stops and raises
 * the last error instead of cycling forever. No wraparound on purpose — wrapping would
 * re-try keys whose retry ladder was just spent, turning a hard limit into an infinite
 * loop.
 */
export function nextKey(pool: KeyPoolState): string | null {
  const next = pool.current + 1;
  if (next >= pool.keys.length) return null;
  pool.current = next;
  return pool.keys[next]!;
}

/** Start over from the first key (a fresh turn gets the full cycle again). */
export function resetPool(pool: KeyPoolState): void {
  pool.current = 0;
}

/** How many keys this pool holds. */
export function poolSize(pool: KeyPoolState): number {
  return pool.keys.length;
}

/**
 * Is this failure a rate limit — the only kind rotating can fix?
 *
 * 429 is the universal spelling. 402 ("payment required") and 403 are included because
 * an exhausted subscription and a quota-blocked key answer that way, and a second
 * account is exactly what resolves them. Everything else (5xx, 400, a network error) is
 * NOT rotated: it would fail identically on every key, so rotating just burns the cycle.
 */
export function isRateLimitStatus(status: number | undefined): boolean {
  return status === 429 || status === 402 || status === 403;
}
