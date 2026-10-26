import { test } from "node:test";
import assert from "node:assert/strict";
import { composerHeight } from "../frontend/lib/composer-size.ts";

const MAX = 360;

test("the box fits its content when the content is within the cap", () => {
  assert.equal(composerHeight(20, MAX), 20, "one line");
  assert.equal(composerHeight(40, MAX), 40, "two lines");
  assert.equal(composerHeight(60, MAX), 60, "three lines");
});

test("past the cap the box stops growing and scrolls instead", () => {
  assert.equal(composerHeight(1000, MAX), MAX);
});

test("an empty box never resolves to zero height", () => {
  assert.equal(composerHeight(0, MAX), 1);
  assert.ok(composerHeight(0, MAX) > 0);
});
