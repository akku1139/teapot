import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchedule, matches } from "../src/scheduler/cron.ts";

const at = (min: number, hour = 10, day = 15, month = 6, dow = 3) =>
  new Date(2026, month - 1, day, hour, min, 0);

test("cron: step field", () => {
  const s = parseSchedule("*/10 * * * *");
  assert.ok(matches(s, at(0)));
  assert.ok(matches(s, at(30)));
  assert.ok(!matches(s, at(5)));
});

test("cron: explicit list and range", () => {
  const s = parseSchedule("5,15 8-9 * * *");
  assert.ok(matches(s, at(5, 8)));
  assert.ok(matches(s, at(15, 9)));
  assert.ok(!matches(s, at(20, 9)));
  assert.ok(!matches(s, at(5, 10)));
});

test("cron: every shorthand rounds seconds to minutes", () => {
  const s = parseSchedule("every 90s");
  assert.ok(matches(s, at(0)));
  assert.ok(matches(s, at(2)));
  assert.ok(!matches(s, at(1)));
});

test("cron: every hours", () => {
  const s = parseSchedule("every 2h");
  assert.ok(matches(s, at(0, 0)));
  assert.ok(matches(s, at(0, 4)));
  assert.ok(!matches(s, at(0, 1)));
});

test("cron: sunday as 7 matches day 0", () => {
  const s = parseSchedule("0 0 * * 7");
  // 2026-08-23 is a Sunday
  assert.ok(matches(s, new Date(2026, 7, 23, 0, 0)));
  assert.ok(!matches(s, new Date(2026, 7, 24, 0, 0)));
});

test("cron: rejects garbage", () => {
  assert.throws(() => parseSchedule("nope"));
  assert.throws(() => parseSchedule("* * * *"));
});
