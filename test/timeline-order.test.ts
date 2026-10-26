import { test } from "node:test";
import assert from "node:assert/strict";
import {
  placeEchoesBelow,
  resequenceToDelivery,
  pendingFloor,
} from "../frontend/lib/timeline-order.ts";

const row = (seq: number, id: string) => ({ seq, id, type: "message" });

test("a pending message sorts below everything already on the timeline (#37)", () => {
  const visible = [row(10, "a"), row(20, "b"), row(30, "c")];
  const echo = { ...row(2, "queued"), type: "prompt" };
  const out = placeEchoesBelow(visible, [echo]);
  assert.equal(out.at(-1)!.id, "queued", "the pending message must be LAST (#37)");
  assert.ok(
    out.at(-1)!.seq > out.at(-2)!.seq,
    `pending seq ${out.at(-1)!.seq} must exceed the last row's ${out.at(-2)!.seq}`,
  );
});

test("a message typed EARLY still sorts below a LATER agent reply (#37)", () => {
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
  const visible = [row(1, "a"), row(7, "b"), row(4, "c")]; 
  const out = placeEchoesBelow(visible, [row(0, "q1"), row(0, "q2")]);
  const maxSettled = Math.max(...visible.map((e) => e.seq));
  for (const e of out.slice(visible.length)) {
    assert.ok(e.seq > maxSettled, `pending seq ${e.seq} must exceed ${maxSettled} (#37)`);
  }
});

test("no pending messages still SORTS, because a delivered prompt moved (#37)", () => {
  const early = row(1, "early");
  const tool = row(2, "tool");
  const prompt = row(9, "queued"); 
  const reply = row(10, "reply");
  const out = placeEchoesBelow([early, prompt, tool, reply], []);
  assert.deepEqual(
    out.map((e) => e.id),
    ["early", "tool", "queued", "reply"],
    "the resequenced prompt must land between the earlier output and the reply (#37)",
  );
});

test("rows are not reordered when their seqs are already in order (#37)", () => {
  const visible = [row(1, "a"), row(2, "b")];
  assert.deepEqual(placeEchoesBelow(visible, []).map((e) => e.id), ["a", "b"]);
});

test("a pending message on an empty timeline still lands (#37)", () => {
  const out = placeEchoesBelow([], [row(0, "q")]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, "q");
});

test("placeEchoesBelow never mutates the caller's rows (#37)", () => {
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

test("a delivered prompt moves DOWN to its delivery note (#37)", () => {
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

test("pendingFloor is one past the last settled row (#37)", () => {
  assert.equal(pendingFloor([row(1, "a"), row(9, "b")]), 10);
  assert.equal(pendingFloor([]), 1);
});

