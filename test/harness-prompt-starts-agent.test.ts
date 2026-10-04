/**
 * #123 — "saving a TODO while the agent is idle does not make it run, even when
 * the harness notifies the agent. The same problem applies to notifications from
 * a sub-agent via the harness."
 *
 * ## Cause
 *
 * The route enqueues a harness prompt:
 *
 *     a.enqueuePrompt(`[harness] The operator updated the task list: …`, "harness");
 *
 * but a queued prompt does not start the loop — it is drained at the next turn
 * boundary, and an IDLE agent has no turn to drain it at. So the prompt sat in
 * the queue until something else started the agent, which made saving a task
 * list look like it had been ignored.
 *
 * The `/goal` route had already learned this:
 *
 *     // an idle agent must actually START working on the new goal — the
 *     // queued prompt alone sat there forever when nothing else started
 *     if (a.status !== "running") a.start("goal set");
 *
 * `/todo` never got the same line. Neither did the two sub-agent → parent
 * notifications in master.ts, which is the second half of the report: a finished
 * or errored sub-agent enqueues a report into the parent, and an idle parent
 * never reacted to it.
 *
 * ## What is tested
 *
 * The guard is `status !== "running"` in each place, plus the parent side of a
 * child report. Structural, because these are one-line call sites in three files
 * and the failure is their ABSENCE — a test that cannot notice a missing line is
 * exactly the gap #75 describes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const api = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
const master = readFileSync(new URL("../src/master.ts", import.meta.url), "utf8");

/** the window of source after a marker, bounded by the next `return` or marker */
function after(src: string, marker: string, chars = 900): string {
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `marker not found: ${marker}`);
  return src.slice(at, at + chars);
}

test("saving a todo starts an idle agent (#123)", () => {
  const block = after(api, 'await a.setTodo(body.text ?? "");', 1200);
  assert.match(block, /a\.enqueuePrompt\(/, "the harness prompt is queued (#123)");
  assert.match(
    block,
    /if \(a\.status !== "running"\) a\.start\("todo set"\);/,
    "an idle agent must be STARTED — a queued prompt alone is never drained (#123)",
  );
});

test("the todo start is conditional, so a running agent is not restarted (#123)", () => {
  const block = after(api, 'a.start("todo set")', 200);
  assert.doesNotMatch(
    block,
    /\n\s*a\.start\("todo set"\);\s*\n\s*a\.start\("todo set"\);/,
    "start() must not be called unconditionally (#123)",
  );
  assert.match(
    api,
    /if \(a\.status !== "running"\) a\.start\("todo set"\);/,
    "the guard is what prevents a restart loop (#123)",
  );
});

test("a finished sub-agent's report starts an idle parent (#123)", () => {
  const block = after(master, "finished. Final report:", 900);
  assert.match(block, /parent\.enqueuePrompt\(/, "the report is queued (#123)");
  assert.match(
    block,
    /if \(parent\.status !== "running"\) parent\.start\(`sub-agent \$\{ac\.id\} finished`\);/,
    "an idle parent must START, or the report sits forever (#123)",
  );
});

test("a sub-agent ERROR report starts an idle parent too (#123)", () => {
  const block = after(master, "hit an error:", 600);
  assert.match(
    block,
    /if \(parent\.status !== "running"\) parent\.start\(`sub-agent \$\{ac\.id\} error`\);/,
    "the error path needs the same start as the report path (#123)",
  );
});

test("every harness enqueue in api.ts is followed by a start (#123)", () => {
  // the structural guard against the whole class: an enqueue with no start is the
  // bug, so assert there are none left
  const sites = [...api.matchAll(/(\w+)\.enqueuePrompt\(/g)].map((m) => m.index);
  assert.ok(sites.length > 0, "precondition: there are enqueue sites (#123)");
  const orphans = sites.filter((at) => {
    // 700 chars reached the /prompt site's `a.start("prompt")` but the window
    // must cover the guard wherever it sits, including after a log append
    const window = api.slice(at, at + 1200);
    // the guard may carry extra conditions — `/prompt` reads
    // `body.start !== false && a.status !== "running"`, and an enqueue guarded by
    // nothing else in that window is the bug. So: is there a status check AND a
    // start() nearby, rather than one exact shape?
    const guarded =
      /\w+\.status !== "running"/.test(window) && /\w+\.start\(/.test(window);
    return !guarded;
  });
  assert.deepEqual(
    orphans.map((at) => api.slice(0, at).split("\n").length),
    [],
    `every harness enqueue must be able to START the agent (#123); lines ${orphans
      .map((at) => api.slice(0, at).split("\n").length)
      .join(", ")}`,
  );
});