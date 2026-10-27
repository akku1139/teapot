import { test } from "node:test";
import assert from "node:assert/strict";
import { evictOver, weighJson } from "../frontend/lib/retention.ts";

/**
 * Per-session retention must be bounded in BYTES, and eviction must actually run (#186).
 *
 * The report was "セッションを行き来してるとフロントエンドがメモリリークしてる気がする", with the
 * concrete numbers "最初は200MBちょっと、そのうち800MB". The session cache is the structure built
 * exactly for switching back and forth, so it is the first place to look.
 *
 * Two defects are pinned here:
 *   1. `weighJson` — the old estimate counted only top-level strings, so an event's real cost (nested
 *      `data`, keys, UTF-16) was undercounted and the byte budget was fiction.
 *   2. `evictOver` — eviction ran on ONE code path. Anything inserted elsewhere was never reconsidered,
 *      so a session that was archived or had its branch switched kept its whole feed alive.
 */
const entry = (at: number, bytes: number) => ({ at, bytes });

test("the byte budget is enforced, not just the entry count (#186)", () => {
  const m = new Map([["a", entry(1, 4_000_000)], ["b", entry(2, 4_000_000)], ["c", entry(3, 4_000_000)]]);
  // three entries is under a 6-entry cap, but 12MB is over an 8MB budget
  const dropped = evictOver(m, { maxEntries: 6, maxBytes: 8 * 1024 * 1024 });
  assert.ok(dropped > 0, "the byte budget must evict on its own");
  const total = [...m.values()].reduce((n, v) => n + v.bytes, 0);
  assert.ok(total <= 8 * 1024 * 1024, `still over budget: ${total}`);
});

test("the entry count is enforced too (#186)", () => {
  const m = new Map(Array.from({ length: 10 }, (_, i) => [String(i), entry(i, 1)]));
  evictOver(m, { maxEntries: 3, maxBytes: 1_000_000 });
  assert.equal(m.size, 3);
});

test("it evicts the OLDEST first, so recent back-and-forth survives (#186)", () => {
  const m = new Map([["old", entry(1, 5)], ["mid", entry(5, 5)], ["new", entry(9, 5)]]);
  evictOver(m, { maxEntries: 2, maxBytes: 1_000 });
  assert.equal(m.has("new"), true, "the most recent must survive");
  assert.equal(m.has("old"), false, "and the oldest must go");
});

test("a single entry larger than the whole budget still terminates (#186)", () => {
  // without a guard this is an infinite loop: size is 1 > maxEntries is false, bytes over → drop → empty
  const m = new Map([["huge", entry(1, 999_999_999)]]);
  const dropped = evictOver(m, { maxEntries: 6, maxBytes: 1_000 });
  assert.equal(m.size, 0, "an over-budget entry cannot be kept, and the loop must stop");
  assert.equal(dropped, 1);
});

test("nothing is dropped when it already fits (#186)", () => {
  const m = new Map([["a", entry(1, 100)]]);
  assert.equal(evictOver(m, { maxEntries: 6, maxBytes: 1_000 }), 0, "no churn when there is room");
  assert.equal(m.size, 1);
});

test("weighJson counts nested data and keys, not just top-level strings (#186)", () => {
  const shallow = { data: { result: "x".repeat(100) } };
  const deep = { data: { result: "x".repeat(100), images: [{ url: "data:image/png;base64," + "A".repeat(100) }] } };
  assert.ok(weighJson(deep) > weighJson(shallow), "a nested image must weigh more");

  // UTF-16: a 1000-char string is ~2000 bytes, not 1000
  assert.ok(weighJson("z".repeat(1000)) >= 2000, "characters are not bytes");

  // keys are part of the retained size
  const longKeys = { ["k".repeat(200)]: 1 };
  assert.ok(weighJson(longKeys) >= 400, "key length must count");
});

test("weighJson is finite on deep and cyclic-free shapes (#186)", () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } };
  const n = weighJson(deep);
  assert.ok(Number.isFinite(n) && n > 0, `got ${n}`);
});

test("random cache sizes never leave the cache over budget (#185)", async () => {
  const { forRandom, int } = await import("./helpers/random.ts");
  await forRandom(
    "evict",
    200,
    (rng) => ({
      maxEntries: int(rng, 1, 8),
      maxBytes: int(rng, 100, 100_000),
      entries: Array.from({ length: int(rng, 0, 20) }, (_, i) => ({ key: `k${i}`, at: int(rng, 0, 1000), bytes: int(rng, 1, 30_000) })),
    }),
    ({ maxEntries, maxBytes, entries }) => {
      const m = new Map(entries.map((e) => [e.key, { at: e.at, bytes: e.bytes }]));
      evictOver(m, { maxEntries, maxBytes });
      const total = [...m.values()].reduce((n, v) => n + v.bytes, 0);
      // the invariant: after eviction the cache FITS, or it is empty because nothing could fit
      assert.ok(
        (m.size <= maxEntries && total <= maxBytes) || m.size === 0,
        `size=${m.size}/${maxEntries} bytes=${total}/${maxBytes}`,
      );
    },
  );
});
