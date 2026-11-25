/**
 * One clock, driven by one interval, and it can be asked directly.
 *
 * The bug this replaces: `fmtDur(Date.now() - startedAt)` in a template froze at the last render ("時刻カウントもライブ更新も進まない").
 * A per-component `setInterval` fixes the symptom and cannot be tested — Solid 2 defers effects until a renderer settles, so
 * MEASURED, a ticker armed in `createEffect` never started outside a real render root (its value stayed at the initial read).
 * The DOM cannot answer it either: with the FROZEN version the panel's text still moved from "1m 5s" to "1m 6s" within a
 * second, because any unrelated re-render repaints the template.
 *
 * A module-level signal driven by an interval has neither problem: the interval writes the signal, so a test observes it without
 * a renderer, and a component reading `nowMs()` is the only thing that can make it move.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clockRunning, nowMs, startClock } from "../frontend/lib/clock.ts";

test("the clock advances on its own", async () => {
  const stop = startClock(20);
  try {
    const first = nowMs();
    const deadline = Date.now() + 2_000;
    while (nowMs() === first) {
      assert.ok(Date.now() < deadline, "the clock never advanced — a frozen readout is the reported bug");
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    stop();
  }
});

test("more than one readout can share it, and only the LAST release stops it", async () => {
  /**
   * Refcounted on purpose: a running bash row and the shells panel can both be on screen, and the first one to unmount must not
   * stop the clock under the other.
   */
  const stopA = startClock(20);
  const stopB = startClock(20);
  assert.equal(clockRunning(), true);
  stopA();
  assert.equal(clockRunning(), true, "the other readout is still showing elapsed time");
  stopB();
  assert.equal(clockRunning(), false, "the last release stops the one interval");
  const atStop = nowMs();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(nowMs(), atStop, "a stopped clock must not keep ticking");
});
