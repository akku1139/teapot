/**
 * #78 — pending-echo reconciliation dropped the NEWEST still-queued messages.
 *
 * The comment in the component claimed reconciliation "match[es] on promptId".
 * The code did:
 *
 *     list.filter((p) => !!p.promptId).slice(0, queued)
 *
 * `slice(0, queued)` keeps the FIRST N by POSITION — no matching happens at
 * all. So whenever the server's `pendingPrompts` count dipped below the real
 * queue length (a ✕ cancel in the middle, or the brief gap before
 * `drainPendingPrompts()` settles), the newest still-queued echoes were deleted
 * from `pendingMsgs`. Because `stillPendingIds` is derived from that list, their
 * undelivered log rows immediately reappeared as settled "sent" rows — which is
 * the #19 cancellation bug the neighbouring `cancelledNotes` block exists to
 * prevent.
 *
 * Root cause on the server side: `snapshot()` published only the COUNT, so
 * identity could not be expressed. It now publishes `pendingPromptIds`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* ---------- the rule, as implemented ---------- */

// the shipped shape, so the test cannot drift from it
type Echo = PendingEcho;

/**
 * #87: this used to MIRROR the component's reconciliation. It is now the shipped
 * function, so a change to the rule cannot leave this test passing against a
 * stale copy — the same failure mode as `row-grouping` and
 * `question-answered`.
 */
import { reconcilePending, type PendingEcho } from "../frontend/pending-echo.ts";

const P = (id: number | string, text: string, promptId?: string): Echo => ({ id: String(id), text, promptId, at: 0 });
const ids = (list: Echo[]) => list.map((p) => Number(p.id)).sort((a, b) => a - b);

/* ---------- the reported failure ---------- */

test("a mid-queue cancel does not drop the newest echoes (#78)", () => {
  // [A,B,C,D] with B cancelled -> the live queue is p1,p3,p4
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
  // the gap before drainPendingPrompts() settles: the COUNT is low but the ids
  // show everything is still queued. Positional slicing dropped the newest here.
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

/* ---------- the fallbacks must not regress the plain case ---------- */

test("with no ids available the head is kept (#78)", () => {
  // older server, or every echo predates promptId tracking: the head-keep
  // heuristic is CORRECT for a plain front-to-back drain, which is all it is
  // used for now
  const list = [P(1, "a", "p1"), P(2, "b", "p2"), P(3, "c", "p3")];
  assert.deepEqual(ids(reconcilePending(list, 2, undefined)), [1, 2], "#78");
});

test("an echo with no promptId is not silently deleted (#78)", () => {
  // predates tracking / survived a reload — it has no identity, so it is kept
  // rather than filtered away by a `!!promptId` predicate
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

/* ---------- the server must actually publish the ids ---------- */

test("snapshot publishes pendingPromptIds, not just a count (#78)", () => {
  const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /pendingPromptIds: this\.pendingPrompts\.map\(\(p\) => p\.id\)/,
    "identity cannot be expressed without the ids (#78)",
  );
});

test("the ids are bounded and carry no prompt text (#78)", () => {
  const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => l.includes("pendingPromptIds:")) ?? "";
  assert.match(line, /slice\(0, 64\)/, "the snapshot must stay bounded (#78)");
  assert.doesNotMatch(line, /\.text/, "only ids may travel — never prompt content (#78)");
});

test("the component reconciles by id, not by position (#78)", () => {
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  assert.match(app, /sel\(\)\?\.pendingPromptIds/, "the UI must read the ids (#78)");
  assert.doesNotMatch(
    app,
    /filter\(\(p\) => !!p\.promptId\)\.slice\(0, queued\)/,
    "the positional slice is the bug (#78) — it matches nothing and keeps the first N",
  );
});
