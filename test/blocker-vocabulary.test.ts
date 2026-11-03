import assert from "node:assert/strict";
import test from "node:test";
import { namesBlocker } from "../src/agent/blocker.ts";

test("a summary that names what refused to work counts as a blocker (#200)", () => {
  assert.equal(namesBlocker("the device denies write access to /dev/mali0"), true);
  assert.equal(namesBlocker("build failed: missing linux/futex.h"), true);
  assert.equal(namesBlocker("実機で特定できませんでした"), true);
  assert.equal(namesBlocker("読み取りが通らない。権限で拒否される"), true);
  assert.equal(namesBlocker("无法继续, 权限不足"), true);
});

test("a summary with nothing in the way does NOT (#200)", () => {
  /**
   * The reported behaviour: context fine, auto-compaction on, time left, no blocker — and `finish(false)`
   * anyway. MEASURED: 8 of the 13 `finish(false)` calls that followed a progress report named no blocker.
   */
  assert.equal(namesBlocker("ここまでで一旦区切ります。"), false);
  assert.equal(namesBlocker("progress is good, stopping here for now"), false);
  assert.equal(namesBlocker(""), false);
  assert.equal(namesBlocker(null), false);
});
