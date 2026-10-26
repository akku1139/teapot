import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchedule, nextFireAt } from "../src/scheduler/cron.ts";

test("a schedule ~100 days out still reports its next fire time (#B6)", () => {
  const target = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000);
  const spec = `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`;
  const s = parseSchedule(spec);
  const next = nextFireAt(s);
  assert.ok(next, `a ${spec} cron (~100 days out) must report a next fire time, not null`);
  const got = new Date(next!);
  const expected = new Date(target);
  expected.setSeconds(0, 0);
  assert.equal(got.getTime(), expected.getTime(), `next must be the target date, got ${next}`);
});