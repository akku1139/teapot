/**
 * #37 — "pending messages should appear at the BOTTOM of the timeline, because
 *        they are sent to the LLM after the messages already on the timeline"
 *
 * A queued message has NOT reached the model yet — it waits behind whatever
 * the agent is doing. Its log row carries the seq it was TYPED at, so the
 * timeline showed the queued message ABOVE agent output that came after it.
 *
 * The UI already re-sequenced a DELIVERED prompt down to its delivery note for
 * exactly this reason; the undelivered echo needed the same treatment. Both
 * now live in frontend/timeline-order.ts, pure and dependency-free so they are
 * unit-testable under node --test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  placeEchoesBelow,
  resequenceToDelivery,
  pendingFloor,
} from "../frontend/timeline-order.ts";

const row = (seq: number, id: string) => ({ seq, id, type: "message" });

/* ---------- the reported case ---------- */

test("a pending message sorts below everything already on the timeline (#37)", () => {
  // agent output the operator has already seen, up to seq 30
  const visible = [row(10, "a"), row(20, "b"), row(30, "c")];
  // the queued message was TYPED early, so its log row carries a LOW seq —
  // exactly the situation the report describes
  const echo = { ...row(2, "queued"), type: "prompt" };
  const out = placeEchoesBelow(visible, [echo]);
  assert.equal(out.at(-1)!.id, "queued", "the pending message must be LAST (#37)");
  assert.ok(
    out.at(-1)!.seq > out.at(-2)!.seq,
    `pending seq ${out.at(-1)!.seq} must exceed the last row's ${out.at(-2)!.seq}`,
  );
});

test("a message typed EARLY still sorts below a LATER agent reply (#37)", () => {
  // the regression: the queued prompt was logged with the seq it was TYPED at
  // (2), which is BELOW the agent's reply that came afterwards (3)
  const typedAt = row(2, "queued-typed-here");
  const agentReplyAfter = row(3, "agent-replied-after");
  const visible = [row(1, "a"), typedAt, agentReplyAfter];
  const out = placeEchoesBelow(visible, [{ ...typedAt, type: "prompt" }]);
  assert.equal(
    out.at(-1)!.id,
    "queued-typed-here",
    "typing position must not decide display position (#37)",
  );
});

/* ---------- multiple pending messages keep send order ---------- */

test("several pending messages read top-down in send order (#37)", () => {
  const visible = [row(1, "a")];
  const echoes = [row(9, "first-sent"), row(9, "second-sent"), row(9, "third-sent")];
  const out = placeEchoesBelow(visible, echoes);
  assert.deepEqual(
    out.slice(1).map((e) => e.id),
    ["first-sent", "second-sent", "third-sent"],
    "the pending block must keep the order the operator typed them",
  );
  const seqs = out.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "rows stay strictly ordered");
});

test("pending seqs sit strictly below the last settled row (#37)", () => {
  const visible = [row(1, "a"), row(7, "b"), row(4, "c")]; // deliberately unsorted input
  const out = placeEchoesBelow(visible, [row(0, "q1"), row(0, "q2")]);
  const maxSettled = Math.max(...visible.map((e) => e.seq));
  for (const e of out.slice(visible.length)) {
    assert.ok(e.seq > maxSettled, `pending seq ${e.seq} must exceed ${maxSettled} (#37)`);
  }
});

/* ---------- no echoes / empty timeline ---------- */

test("no pending messages leaves the timeline untouched (#37)", () => {
  const visible = [row(1, "a"), row(2, "b")];
  assert.equal(placeEchoesBelow(visible, []), visible, "returns the SAME array when there is nothing to place");
});

test("a pending message on an empty timeline still lands (#37)", () => {
  const out = placeEchoesBelow([], [row(0, "q")]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, "q");
});

/* ---------- no mutation of caller-owned rows ---------- */

test("placeEchoesBelow never mutates the caller's rows (#37)", () => {
  // App.tsx hands us rows it still owns and caches; mutating their seq in place
  // corrupted the event cache and re-ordered the whole feed on the next pass.
  const visible = [row(1, "a")];
  const echoes = [row(1, "q")];
  const out = placeEchoesBelow(visible, echoes);
  assert.equal(visible[0]!.seq, 1);
  assert.equal(echoes[0]!.seq, 1, "the echo input must not be mutated");
  assert.notEqual(out.at(-1), echoes[0], "returns a placed COPY");
});

test("resequenceToDelivery never mutates its input (#37)", () => {
  const r = row(2, "prompt");
  resequenceToDelivery(r, 9);
  assert.equal(r.seq, 2, "input row must be untouched");
});

/* ---------- delivered prompts ---------- */

test("a delivered prompt moves DOWN to its delivery note (#37)", () => {
  // typed at seq 2, but the model consumed it after the reply at seq 3
  const r = row(2, "delivered");
  const out = resequenceToDelivery(r, 5);
  assert.equal(out.seq, 5, "must sit where the model actually received it");
});

test("a delivered prompt is never moved UP (#37)", () => {
  const r = row(9, "already-correct");
  assert.equal(resequenceToDelivery(r, 4).seq, 9, "must not reorder an already-correct row");
});

test("a delivered prompt without a note keeps its position (#37)", () => {
  const r = row(3, "no-note");
  assert.equal(resequenceToDelivery(r, undefined).seq, 3);
  assert.equal(resequenceToDelivery(r, 0).seq, 3, "a 0/absent note is not a position");
});

test("resequenceToDelivery returns the same object when nothing changes (#37)", () => {
  const r = row(3, "same");
  assert.equal(resequenceToDelivery(r, undefined), r, "identity preserved for Solid's reference-stability");
  assert.equal(resequenceToDelivery(r, 1), r);
});

/* ---------- pendingFloor ---------- */

test("pendingFloor is one past the last settled row (#37)", () => {
  assert.equal(pendingFloor([row(1, "a"), row(9, "b")]), 10);
  assert.equal(pendingFloor([]), 1);
});

/* ---------- App.tsx wiring ---------- */

test("App.tsx uses the shared ordering helpers (#37)", () => {
  const src = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  assert.match(src, /placeEchoesBelow\(visible, echoes\)/, "echo placement must go through the helper");
  assert.match(src, /resequenceToDelivery\(/, "delivery re-sequencing must go through the helper");
  assert.doesNotMatch(
    src,
    /echoes\.forEach\(\(e, i\)\s*=>\s*\{\s*e\.seq\s*=/,
    "the old in-place seq mutation must be gone (#37)",
  );
});