/**
 * #40 — "agent2's message is agent1's content, with the writing cursor attached."
 *
 * Shipped in v0.26.1 and STILL REPRODUCING, because the fix was dead code.
 * `pruneDeadLiveBuffers()` was correct and fully unit-tested; the WIRING was
 * wrong:
 *
 *     setLiveByAgent((prev) => {
 *       const statusOf = (id) => agents().find(...)?.status;   // read INSIDE
 *       return pruneDeadLiveBuffers(prev, statusOf);          // the updater
 *     });
 *
 * `liveByAgent` is an empty Map on the first run, so the loop body never
 * executed, `statusOf` was never called, and the effect subscribed to NO signal.
 * It ran exactly once, at mount.
 *
 * Proven with an instrumented bundle: "effect runs: 1, statusOf calls: 0".
 *
 * That is why the pure-helper tests passed and the bug shipped — they test
 * `pruneDeadLiveBuffers` in isolation and cannot see that nothing calls it.
 *
 * This test therefore asserts on the SOURCE WIRING rather than the helper, and
 * specifically asserts the dependency is read OUTSIDE the updater — the exact
 * shape that made it dead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// #126: normalises CRLF so source anchors behave the same on Windows
import { readSource } from "./helpers/source.ts";

const app = readSource(new URL("../frontend/App.tsx", import.meta.url));

/** the body of the pruning effect */
function pruneEffect(): string {
  const at = app.indexOf("pruneDeadLiveBuffers(prev");
  assert.notEqual(at, -1, "the pruning sweep must exist (#40)");
  const start = app.lastIndexOf("createEffect(", at);
  assert.notEqual(start, -1, "it must be inside an effect (#40)");
  return app.slice(start, app.indexOf("\n  });", at));
}

test("the sweep reads agents() OUTSIDE the signal updater (#40)", () => {
  const body = pruneEffect();
  // the dependency must be read in the effect body, not lazily inside the
  // updater — that is the whole bug
  assert.match(
    body,
    /const list = agents\(\)/,
    `agents() must be read in the effect body (#40); got: ${body.slice(0, 200)}`,
  );
  assert.match(
    body,
    /pruneDeadLiveBuffers\(prev, \(id\) => list\.find/,
    "the updater must close over that value, not re-read the signal (#40)",
  );
});

