/**
 * Seeded randomness for property tests (#185).
 *
 * "Randomise the test inputs" has an obvious objection: with a random input there is no expected
 * output to compare against. The answer is not to guess harder — it is to assert an INVARIANT instead
 * of a value. `sort(xs)` has no fixed answer for an unknown `xs`, but "the result is a permutation of
 * the input", "it is ordered", and "its length is unchanged" hold for EVERY input, and a broken sort
 * violates at least one of them.
 *
 * So the rules here are:
 *
 *   1. NEVER assert a hard-coded expectation derived from the generated input. Assert a property.
 *   2. ALWAYS print the seed, and allow it to be replayed (`TEAPOT_SEED=…`). A random failure that
 *      cannot be reproduced is worse than no test: it teaches people to re-run until green.
 *   3. Keep the iteration count small enough that the suite stays fast, large enough to hit edges —
 *      and always include the DEGENERATE cases (empty, one element, duplicates) rather than hoping
 *      randomness finds them.
 *
 * MEASURED motivation: the suite was full of fixtures that were too tidy to fail — a single branch, one
 * session, an id with no separator. The bugs that escaped were all shape-dependent (two sessions, an
 * image-bearing tool result, a session switch mid-stream).
 */

/** mulberry32 — small, fast, and good enough that seeds differ visibly */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The seed for this test: `TEAPOT_SEED` if set, else derived from the clock.
 *
 * The chosen seed is logged so a CI failure names the value that reproduces it.
 */
export function seedFor(label: string): number {
  const env = process.env.TEAPOT_SEED;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n)) return n >>> 0;
  }
  const seed = (Date.now() ^ (label.length * 2654435761)) >>> 0;
  return seed;
}

/** Generate `n` values from `make`, reporting the seed on any failure. */
export async function forRandom<T>(
  label: string,
  n: number,
  make: (rng: () => number, i: number) => T,
  check: (value: T, i: number, rng: () => number) => void | Promise<void>,
): Promise<void> {
  const seed = seedFor(label);
  const rng = makeRng(seed);
  for (let i = 0; i < n; i++) {
    const value = make(rng, i);
    try {
      await check(value, i, rng);
    } catch (err) {
      // the seed is the whole point: without it the failure cannot be replayed
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${label}: case ${i} failed (replay with TEAPOT_SEED=${seed})\n${msg}`, {
        cause: err,
      });
    }
  }
}

/** an integer in [lo, hi] */
export const int = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

/** one of `list` */
export const pick = <T>(rng: () => number, list: readonly T[]): T => list[int(rng, 0, list.length - 1)]!;

/** a boolean with probability p */
export const chance = (rng: () => number, p = 0.5): boolean => rng() < p;

/** a string of `n` random printable chars — for text that must not need escaping */
export const text = (rng: () => number, n: number): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-./";
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[int(rng, 0, alphabet.length - 1)];
  return out;
};

/** `n` distinct-ish ids, some of which contain separators — that shape broke real bugs */
export const ids = (rng: () => number, n: number): string[] =>
  Array.from({ length: n }, (_, i) => {
    const base = pick(rng, ["a", "teapot", "ghidra", "x"]);
    const sep = pick(rng, ["-", "_", "", "/"]);
    return `${base}${sep}${i}${chance(rng, 0.3) ? "suffix" : ""}`;
  });

/**
 * Always run these as well as the random ones.
 *
 * Randomness is bad at generating the cases that matter: an empty list, a single element, a duplicate,
 * a value at the boundary. Every bug this suite missed was found at a DEGENERATE input, not an average
 * one, so the edge list is explicit rather than hoped for.
 */
export const edges = <T>(...extra: T[]): T[] => extra;
