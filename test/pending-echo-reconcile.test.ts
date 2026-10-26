import { test } from "node:test";
import assert from "node:assert/strict";

type Echo = PendingEcho;

import { reconcilePending, type PendingEcho } from "../frontend/lib/pending-echo.ts";

const P = (id: number | string, text: string, promptId?: string): Echo => ({ id: String(id), text, promptId, at: 0 });
const ids = (list: Echo[]) => list.map((p) => Number(p.id)).sort((a, b) => a - b);

test("a mid-queue cancel does not drop the newest echoes (#78)", () => {
  const list = [P(1, "first", "p1"), P(2, "second", "p2"), P(3, "third", "p3"), P(4, "fourth", "p4")];
  assert.deepEqual(
    ids(reconcilePending(list, 3, ["p1", "p3", "p4"])),
    [1, 3, 4],
    "the surviving echoes are the ones the live queue can account for (#78)",
  );
});

test("a front cancel keeps the tail (#78)", () => {
  const list = [P(1, "a", "p1"), P(2, "b", "p2"), P(3, "c", "p3"), P(4, "d", "p4")];
  assert.deepEqual(ids(reconcilePending(list, 2, ["p2", "p3", "p4"])), [2, 3, 4], "#78");
});

test("a plain front-to-back drain keeps the tail (#78)", () => {
  const list = [P(1, "a", "p1"), P(2, "b", "p2"), P(3, "c", "p3"), P(4, "d", "p4")];
  assert.deepEqual(ids(reconcilePending(list, 3, ["p2", "p3", "p4"])), [2, 3, 4], "#78");
});

test("a count dip does not drop anything (#78)", () => {
  const list = [P(1, "a", "p1"), P(2, "b", "p2"), P(3, "c", "p3"), P(4, "d", "p4")];
  assert.deepEqual(
    ids(reconcilePending(list, 2, ["p1", "p2", "p3", "p4"])),
    [1, 2, 3, 4],
    "a stale count must not delete echoes the ids say are queued (#78)",
  );
});

test("nothing is dropped when the count cannot be trusted (#78)", () => {
  const list = [P(1, "a", "p1"), P(2, "b", "p2")];
  assert.deepEqual(reconcilePending(list, 5, ["p1", "p2"]), list, "a count >= list length is a no-op (#78)");
});

test("with no ids available the head is kept (#78)", () => {
  const list = [P(1, "a", "p1"), P(2, "b", "p2"), P(3, "c", "p3")];
  assert.deepEqual(ids(reconcilePending(list, 2, undefined)), [1, 2], "#78");
});

test("an echo with no promptId is not silently deleted (#78)", () => {
  const list = [P(0, "old", undefined), P(1, "a", "p1"), P(2, "b", "p2"), P(3, "c", "p3")];
  const out = reconcilePending(list, 2, ["p3", "p4"]);
  assert.ok(
    out.some((p) => p.promptId === undefined),
    `an unidentifiable echo must not be dropped (#78): ${JSON.stringify(ids(out))}`,
  );
});

test("no live ids at all leaves the list alone (#78)", () => {
  const list = [P(1, "a", "p1"), P(2, "b", "p2"), P(3, "c", "p3")];
  assert.deepEqual(ids(reconcilePending(list, 2, [])), [1, 2], "an empty id list means 'no information' (#78)");
});

