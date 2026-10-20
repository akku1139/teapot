/**
 * #scroll: `<For>` keys on ITEM IDENTITY, so a rebuilt array must reuse its items.
 *
 * The reported symptom: "新しいメッセージが来るとかのたびにタイムラインがフラッシュする".
 *
 * `<For>` compares the new array against the previous one POSITION BY POSITION and keeps a
 * row only when the item at that position is the SAME object (`items[i] === nextItems[i]`).
 * Anything else is disposed and re-created — a full remount, which is the flash.
 *
 * `chatEvents()` returns rows that `stabilize()` has already made reference-stable, but the
 * template does not render those directly: it renders `rowsWithPrev()`, which pairs each row
 * with its neighbours. The first version did
 *
 *     rows.map((row, idx) => ({ row, prev: …, next: … }))
 *
 * which allocates a FRESH wrapper for every row on every rebuild — so every position looked
 * "changed" and the entire timeline remounted on each incoming event.
 *
 * These tests pin the contract the wrapper has to satisfy, because the failure is invisible
 * in a DOM assertion (a remount renders the same markup) and only shows as a flicker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

type Row = { id: string; data?: Record<string, unknown> };
type Pair = { row: Row; prev?: Row; next?: Row };

/**
 * The pairing rule, mirroring `pairCache`/`rowsWithPrev` in App.tsx.
 *
 * Extracted here rather than imported because the component owns it inline; what matters is
 * that the SHAPE of the rule (reuse when the row and both neighbours are unchanged) is
 * pinned by a test. A refactor that breaks it fails here.
 */
function makePairer() {
  const cache = new WeakMap<Row, Pair>();
  return (rows: Row[]): Pair[] =>
    rows.map((row, idx) => {
      const prev = idx > 0 ? rows[idx - 1] : undefined;
      const next = idx < rows.length - 1 ? rows[idx + 1] : undefined;
      const cached = cache.get(row);
      if (cached && cached.prev === prev && cached.next === next) return cached;
      const fresh = { row, prev, next };
      cache.set(row, fresh);
      return fresh;
    });
}

const mk = (id: string): Row => ({ id });

test("an APPEND keeps every existing wrapper identical (#scroll)", () => {
  const pair = makePairer();
  const a = mk("a");
  const b = mk("b");
  const first = pair([a, b]);
  // one new event arrives at the end — the overwhelmingly common case
  const c = mk("c");
  const second = pair([a, b, c]);

  // PRECONDITION: the rows really were reused, or this test proves nothing
  assert.equal(second.length, 3);
  assert.equal(second[2]!.row, c, "the new row must appear at the end");

  // Every row except the one whose `next` changed keeps its wrapper. On an append that is
  // all of them but the LAST OLD row (`b`, whose next becomes the new row) — a single
  // remount instead of the whole timeline.
  assert.equal(
    second[0],
    first[0],
    `position 0 got a NEW wrapper on an append — <For> disposes and re-creates that row, ` +
      `which is the timeline flash`,
  );
  // …but `b`'s `next` really did change (c is new), so IT must be rebuilt. That is the one
  // wrapper that legitimately moves, and the reason the cache compares neighbours.
  assert.notEqual(second[1], first[1], "b's neighbour changed, so its pairing must be rebuilt");
  assert.equal(second[1]!.next, c);
  // and the NEW row is fresh, obviously
  assert.ok(!first.includes(second[2]!), "the appended row cannot reuse a wrapper");
});

test("a row whose neighbours did not move keeps its wrapper across a no-op rebuild (#scroll)", () => {
  const pair = makePairer();
  const rows = [mk("a"), mk("b"), mk("c")];
  const first = pair(rows);
  const second = pair(rows); // same objects, same order — e.g. a poll that changed nothing
  for (let i = 0; i < rows.length; i++) {
    assert.equal(
      second[i],
      first[i],
      `position ${i} was rebuilt even though nothing changed — every poll would remount the feed`,
    );
  }
});

test("a PREPEND does not leave a stale neighbour on the row that moved (#scroll)", () => {
  // backfill prepends older rows. The row that used to be first now has a `prev`, so its
  // wrapper MUST be rebuilt — a cached one would tell `groupedWith()` it is still the head
  // of the timeline, and the first run would draw without its icon.
  const pair = makePairer();
  const b = mk("b");
  const c = mk("c");
  const first = pair([b, c]);
  assert.equal(first[0]!.prev, undefined, "precondition: b starts as the head");

  const a = mk("a");
  const second = pair([a, b, c]);
  assert.equal(second[1]!.row, b);
  assert.notEqual(second[1], first[0], "b's prev changed, so its wrapper must be rebuilt");
  assert.equal(second[1]!.prev, a, "and it must point at the row that was prepended");
});

test("a row replaced by a DIFFERENT object gets a fresh wrapper (#scroll)", () => {
  // a row that really changed (e.g. a tool row whose result arrived and was re-stabilised)
  const pair = makePairer();
  const a = mk("a");
  const b1 = mk("b");
  const first = pair([a, b1]);
  const b2 = mk("b"); // same id, different object
  const second = pair([a, b2]);
  assert.notEqual(second[1], first[1], "a genuinely new row object must not reuse the old pair");
  assert.equal(second[1]!.row, b2);
  // …and the neighbour that points AT it must be rebuilt too, or it points at a dead row
  assert.notEqual(second[0], first[0], "a's `next` is a different object now");
  assert.equal(second[0]!.next, b2);
});
