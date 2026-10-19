/**
 * API-key pooling and rotation (#170) — "1プロバイダに複数のAPIキーを紐付けられるようにして
 * ローテーションとかできるように / レートリミットきたAPIキーを自動ローテ".
 *
 * ## What this is for
 *
 * A provider entry used to hold ONE `apiKey`, so the only way to spread load was to
 * duplicate the whole provider (this config had `openrouter`, `openrouter-minimax`,
 * `openrouter-nemotron-3.5-lightning`, `openrouter-glm-5.2`, `openrouter-union-alpha` —
 * five entries differing only in `model`, all sharing one credential). Nothing could
 * rotate, so a rate-limited key stalled every agent on it at once.
 *
 * ## The rules, and why they are the rules
 *
 * 1. **Round-robin, not random.** Random selection lets the same key be picked twice
 *    in a row while another sits idle; with a small pool that is the difference
 *    between spreading load and not. A cursor per pool makes consecutive picks
 *    distinct.
 *
 * 2. **A rate-limited key goes into COOLDOWN, it is not dropped.** A 429 is a
 *    temporary statement about one key, so discarding it would be wrong and blocking
 *    the whole provider would be worse. It returns to the pool when the cooldown
 *    lapses — no timer, just a timestamp compared on read, because a timer per key
 *    would keep resetting and complicate shutdown.
 *
 * 3. **Never return null while the pool is non-empty.** If every key is cooling down
 *    the LEAST-recently-limited one is used anyway. Refusing to make a request cannot
 *    succeed; making it with the soonest-to-recover key at least tries, and the caller
 *    still has its own retry ladder. This is the property that keeps rotation from
 *    turning a single 429 into a hard failure.
 *
 * 4. **Order is the config's order.** The operator's first key stays first, so
 *    behaviour is predictable and the pool does not reshuffle behind their back.
 *
 * Pure and dependency-free so the rules can be tested directly; the caller owns the
 * pool instance and the clock.
 */

/** How long a rate-limited key is skipped by default. */
export const KEY_COOLDOWN_MS = 60_000;

export interface KeyPoolState {
  /** the keys, in config order; unique, non-empty */
  keys: string[];
  /** index of the next key to hand out (round-robin cursor) */
  cursor: number;
  /** key → epoch-ms until which it should be skipped (rate limited) */
  cooldownUntil: Map<string, number>;
}

/** Build a pool, dropping duplicates and blanks while keeping the config's order. */
export function makeKeyPool(keys: readonly string[]): KeyPoolState {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const k of keys) {
    const t = k.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
  }
  return { keys: unique, cursor: 0, cooldownUntil: new Map() };
}

/**
 * Pick the next key, advancing the cursor.
 *
 * Returns null only when the pool is empty, which the caller treats as "this provider
 * has no credential" rather than as a rotation failure.
 */
export function nextKey(pool: KeyPoolState, now: number): string | null {
  if (pool.keys.length === 0) return null;
  const n = pool.keys.length;
  // try each key at most once, starting from the cursor: the first not cooling down
  for (let i = 0; i < n; i++) {
    const idx = (pool.cursor + i) % n;
    const key = pool.keys[idx]!;
    const until = pool.cooldownUntil.get(key) ?? 0;
    if (until <= now) {
      pool.cursor = (idx + 1) % n;
      return key;
    }
  }
  // EVERY key is cooling down. Refusing to send cannot succeed, so hand out the one
  // that recovers soonest — see rule 3.
  let bestIdx = pool.cursor;
  let bestUntil = Infinity;
  for (let i = 0; i < n; i++) {
    const idx = (pool.cursor + i) % n;
    const until = pool.cooldownUntil.get(pool.keys[idx]!) ?? 0;
    if (until < bestUntil) {
      bestUntil = until;
      bestIdx = idx;
    }
  }
  pool.cursor = (bestIdx + 1) % n;
  return pool.keys[bestIdx]!;
}

/** Mark a key rate-limited: it is skipped for `ms`, then returns to the pool. */
export function coolDown(
  pool: KeyPoolState,
  key: string,
  now: number,
  ms: number = KEY_COOLDOWN_MS,
): void {
  if (!pool.keys.includes(key)) return;
  const until = now + ms;
  // never SHORTEN an existing cooldown: a second 429 while one is pending must not
  // bring the key back early
  const cur = pool.cooldownUntil.get(key) ?? 0;
  if (until > cur) pool.cooldownUntil.set(key, until);
}

/** Keys usable right now (diagnostics / the UI). */
export function availableKeys(pool: KeyPoolState, now: number): string[] {
  return pool.keys.filter((k) => (pool.cooldownUntil.get(k) ?? 0) <= now);
}

/**
 * Rotate to a different key after a failure, or null when there is no alternative.
 *
 * `tried` is the key that just failed; it is put on cooldown first, so the rotation
 * cannot hand the same key back. Returns null when this pool has only one usable key
 * — the caller should then stop rotating and let its own retry ladder run, since
 * re-sending with the same credential proves nothing.
 */
export function rotateAfterFailure(
  pool: KeyPoolState,
  tried: string,
  now: number,
  ms: number = KEY_COOLDOWN_MS,
): string | null {
  coolDown(pool, tried, now, ms);
  const next = nextKey(pool, now);
  if (next === null || next === tried) return null;
  return next;
}

/**
 * The HTTP statuses that mean "this KEY is the problem", so rotating can help.
 *
 * 429 is the reported case. 401/403 are included deliberately: a revoked or
 * exhausted key answers that way, and with a pool the operator very likely has a
 * second working one — this is the difference between rotation being useful and it
 * only covering exactly the one reported symptom. 5xx is NOT here: a provider
 * outage affects every key equally, so rotating just burns the pool.
 */
export function isKeyFailure(status: number | undefined): boolean {
  return status === 429 || status === 401 || status === 403;
}
