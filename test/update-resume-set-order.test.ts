import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

/**
 * The resume set must be captured BEFORE the wind-down stops everything.
 *
 * `takeResumeSet()` asks `isLive()`, and `windDownForUpdate()` sets `status = "idle"` as its success
 * condition. Ordering them the other way collected nothing, and the operator's log said so:
 *
 *     [teapot] live update: waiting for 1 agent(s) to reach a turn boundary...
 *     [teapot] live update: 0 session(s) will resume
 *     [teapot] live update: resumed 0 session(s)
 *
 * The one agent that was working was recorded as "not working" by the step that had just made it
 * stop, so the work never came back — reported as "ライブアップデート壊れた?".
 *
 * This is a source-order assertion because the bug IS the order: both calls are correct on their
 * own, and only their sequence is wrong.
 */
test("resumeAfterUpdate is captured before the wind-down (#update)", () => {
  const src = readSource("src/master.ts");
  const body = src.slice(src.indexOf("async restartServer()"));
  const captureAt = body.indexOf("this.config.resumeAfterUpdate = this.takeResumeSet()");
  const windDownAt = body.indexOf("await this.windDownAllAgents(");
  assert.ok(captureAt > 0, "the resume set must be captured somewhere in restartServer");
  assert.ok(windDownAt > 0, "and the wind-down must still happen");
  assert.ok(
    captureAt < windDownAt,
    "the resume set must be taken BEFORE windDownAllAgents: the wind-down sets every agent to " +
      "idle, which is exactly what `takeResumeSet` reads as 'not working' (#update)",
  );
});

test("^C during an update does not silently cancel the handover (#update)", () => {
  /**
   * MEASURED: pressing ^C while the update waited ran the ordinary shutdown path, which disposes
   * every agent and exits — the operator saw "0 session(s) will resume" after the work had been
   * running. The handover is exactly the window where ^C is ambiguous, so the first one has to be
   * refused rather than obeyed.
   */
  const src = readSource("src/index.ts");
  assert.match(
    src,
    /master\.updateInFlight/,
    "shutdown must know an update is in flight (#update)",
  );
  assert.match(
    src,
    /TEAPOT_FORCE_SHUTDOWN/,
    "and a second ^C must get through — refusing outright would trap the operator (#update)",
  );
});
