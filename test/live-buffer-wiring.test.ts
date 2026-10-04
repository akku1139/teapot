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
import { readFileSync } from "node:fs";
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

test("no other call site reads agents() inside a setLiveByAgent updater (#40)", () => {
  // the general shape of the bug: a lazy read inside an updater that may never
  // run, so the effect subscribes to nothing
  const lazy = [...app.matchAll(/setLiveByAgent\(\(prev\) => \{[\s\S]{0,240}?agents\(\)/g)];
  assert.deepEqual(
    lazy.map((m) => m[0].slice(0, 80)),
    [],
    `a signal updater must not be the only reader of a dependency (#40); found ${lazy.length}`,
  );
});

test("the sweep covers EVERY agent, not just the selected one (#40)", () => {
  const body = pruneEffect();
  assert.match(
    body,
    /list\.find\(\(x\) => x\.id === id\)/,
    "status must come from the per-agent snapshot (#40)",
  );
  assert.doesNotMatch(
    body,
    /selected\(\)/,
    "and must not be scoped to the selected agent — that was the original bug (#40)",
  );
});

test("the helper itself still refuses to guess an unknown status (#40)", () => {
  // belt and braces on the pure behaviour the wiring depends on: an agent with
  // no snapshot is left alone rather than treated as idle
  const lb = readSource(new URL("../frontend/live-buffer.ts", import.meta.url));
  assert.match(
    lb,
    /if \(st === undefined\) continue;/,
    "an unknown status must not prune — absence of evidence is not completion (#40)",
  );
  // #40: this was a literal match on `st === "running" || st === "waiting"`, which
  // broke when that expression moved into the shared `isLiveStatus()` predicate —
  // the predicate is what makes the two call sites agree, so match on THAT.
  assert.match(
    lb,
    /if \(isLiveStatus\(st\)\) continue;/,
    "a live or parked agent keeps its buffer (#40)",
  );
});
