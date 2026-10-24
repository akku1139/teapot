import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

/**
 * A live update must wait for the work it is about to interrupt — and must not lie about how much
 * there is.
 *
 * Two reports from one update on a machine with ONE working session:
 *
 *     [teapot] live update: waiting for 440 agent(s) to reach a turn boundary...
 *     ...
 *     ✖ fail  bash  299945ms  not completed — the agent restarted while this tool was running
 *
 * (1) "440 agent(s)" was every LOADED agent (511 configured, 71 archived, 440 loaded) while exactly
 *     one had work in flight. The number read as "440 interrupted jobs" and the call was not free:
 *     each idle agent had `windDownRequested` set and `wake()` poked for nothing.
 *
 * (2) The wait was 180s while a `bash` call may legitimately run 3600s. The update gave up, disposed
 *     the agent, and the in-flight call was recorded as not completed — work that was seconds from
 *     returning.
 */
test("only agents with work in flight are waited for (#update)", () => {
  const src = readSource("src/master.ts");
  const at = src.indexOf("async windDownAllAgents");
  assert.ok(at > 0, "windDownAllAgents must exist");
  const body = src.slice(at, src.indexOf("}\n", src.indexOf("return stuck", at)));
  assert.match(
    body,
    /\.filter\(\(\[, a\]\) => a\.isLive\(\)\)/,
    "the wait must target agents that are actually live — every loaded agent is 440 on this machine " +
      "with one working session (#update)",
  );
});

test("the wind-down timeout is comparable to a tool's own ceiling (#update)", () => {
  const src = readSource("src/master.ts");
  const m = /private updateWindDownMs = ([\d_]+);/.exec(src);
  assert.ok(m, "the timeout must be a named constant");
  const ms = Number(m![1]!.replace(/_/g, ""));
  assert.ok(
    ms >= 600_000,
    `the wait must exceed a long tool call: 180s interrupted a ~300s bash that was about to finish ` +
      `(#update); got ${ms}ms`,
  );
  assert.ok(
    ms <= 1_800_000,
    `but it must stay far below a bash call's 3600s ceiling, or an update blocks for an hour ` +
      `(#update); got ${ms}ms`,
  );
});

test("a background shell is waited for, not killed (#update)", () => {
  /**
   * `settled()` resolves when the RUN CHAIN drains, and a background job is deliberately not on that
   * chain — the round ends while the job keeps running. So the wait returned immediately and the
   * update proceeded to `dispose()`, which calls `killBgShells`. A live update killed every
   * background job on the machine, unannounced.
   */
  const src = readSource("src/agent/agent.ts");
  const at = src.indexOf("async windDownForUpdate");
  const body = src.slice(at, at + 3000);
  assert.match(
    body,
    /hasRunningBgShellsFor\(/,
    "the wind-down must wait out the agent's own background shells — `settled()` does not cover " +
      "them, and dispose() kills them (#update)",
  );
});
