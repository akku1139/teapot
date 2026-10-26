import { test } from "node:test";
import assert from "node:assert/strict";

type Row = { id: string; data?: Record<string, unknown> };
type Pair = { row: Row; prev?: Row; next?: Row };

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
  const c = mk("c");
  const second = pair([a, b, c]);

  assert.equal(second.length, 3);
  assert.equal(second[2]!.row, c, "the new row must appear at the end");

  assert.equal(
    second[0],
    first[0],
    `position 0 got a NEW wrapper on an append — <For> disposes and re-creates that row, ` +
      `which is the timeline flash`,
  );
  assert.notEqual(second[1], first[1], "b's neighbour changed, so its pairing must be rebuilt");
  assert.equal(second[1]!.next, c);
  assert.ok(!first.includes(second[2]!), "the appended row cannot reuse a wrapper");
});

test("a row whose neighbours did not move keeps its wrapper across a no-op rebuild (#scroll)", () => {
  const pair = makePairer();
  const rows = [mk("a"), mk("b"), mk("c")];
  const first = pair(rows);
  const second = pair(rows); 
  for (let i = 0; i < rows.length; i++) {
    assert.equal(
      second[i],
      first[i],
      `position ${i} was rebuilt even though nothing changed — every poll would remount the feed`,
    );
  }
});

test("a PREPEND does not leave a stale neighbour on the row that moved (#scroll)", () => {
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
  const pair = makePairer();
  const a = mk("a");
  const b1 = mk("b");
  const first = pair([a, b1]);
  const b2 = mk("b"); 
  const second = pair([a, b2]);
  assert.notEqual(second[1], first[1], "a genuinely new row object must not reuse the old pair");
  assert.equal(second[1]!.row, b2);
  assert.notEqual(second[0], first[0], "a's `next` is a different object now");
  assert.equal(second[0]!.next, b2);
});
