/**
 * nextFireAt が 31 日で打ち切られ、年次スケジュールの next が null になる。
 *
 * 実際の発火は tick() の matches() で正しく行われるが、UI の「next」表示は
 * この関数なので、発火日が 31 日超先のタスク（例: 12/1 を 8 月に見る）は
 * next: null で表示される。
 *
 * Required: 366 日以内に発火日があるスケジュールは next を返す。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchedule, nextFireAt } from "../src/scheduler/cron.ts";

test("a schedule ~100 days out still reports its next fire time (#B6)", () => {
  // a fixed date ~100 days in the future from NOW, whichever day that is
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