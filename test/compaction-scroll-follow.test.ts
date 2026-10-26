import { test } from "node:test";
import assert from "node:assert/strict";
import { atTail, classifyScroll, distanceToTail, nextFollowing } from "../frontend/lib/scroll-policy.ts";

const VIEWPORT = 800;
const at = (top: number, height: number) => ({ top, height, viewport: VIEWPORT });

test("the compaction banner appearing does not take follow away (#108)", () => {
  const before = at(200, 1000);
  assert.ok(atTail(before), "precondition: the reader starts at the tail");
  const after = at(200, 1044);
  assert.equal(
    classifyScroll(after, null, before.height, VIEWPORT),
    "layout",
    "a height change is layout — the reader cannot change scrollHeight",
  );
  assert.equal(nextFollowing(true, "layout", after), true, "follow must survive the banner");
});

test("the banner DISAPPEARING — the browser clamping — does not either (#108)", () => {
  const before = at(244, 1044); 
  assert.ok(atTail(before), "precondition: at the tail with the banner up");
  const after = at(200, 1000);
  assert.equal(
    classifyScroll(after, { top: 244, height: 1044 }, before.height, VIEWPORT),
    "layout",
    "a shrink is layout; the clamp is the browser, not the reader",
  );
  assert.equal(nextFollowing(true, "layout", after), true, "follow must survive the removal");
  assert.equal(distanceToTail(after), 0);
});

test("a compaction that leaves the reader short of the tail still keeps follow (#108)", () => {
  const before = at(244, 1044);
  const after = at(201, 1001); 
  assert.equal(classifyScroll(after, { top: 244, height: 1044 }, before.height, VIEWPORT), "layout");
  assert.equal(nextFollowing(true, "layout", after), true);
  assert.ok(atTail(after), "a pixel short is still the tail");
});

test("compaction does not mask a REAL scroll-up (#108)", () => {
  const before = at(200, 1000);
  const after = at(60, 1000); 
  assert.equal(classifyScroll(after, null, before.height, VIEWPORT), "reader");
  assert.equal(nextFollowing(true, "reader", after), false, "a person still unpins");
});
