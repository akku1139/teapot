import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A live counter must read its clock INSIDE the expression that renders it.
 *
 * Reported twice: "thinking右の思考時間カウンタが動かない", and the frozen value differed each time —
 * "20ms", "65ms". That randomness is the diagnosis: the number is the instant the component happened
 * to render, so the read happened ONCE and nothing subscribed to the clock afterwards.
 *
 * It was a regression. The original was `{fmtDur(Math.max(0, now() - props.startedAt))}` — an
 * expression in JSX, which Solid tracks and re-evaluates on every tick. A later stale-clock fix
 * hoisted it to `const elapsed = …` above the `return` to add a bounds check, which reads the signal
 * once and hands the template a finished string. `BashElapsed` next door always used a thunk
 * (`txt()`), which is why only this counter froze.
 *
 * Solid is not driven here — the property under test is about WHERE a read happens, and it holds for
 * any dependency-tracking renderer. The two shapes are modelled explicitly so the failure mode is
 * visible: `snapshot` is evaluated once, `thunk` on every render.
 */
function makeClock(startedAt: number) {
  let now = 1000;
  const tick = (to: number) => {
    now = to;
  };
  // the BROKEN shape: read at render time, outside anything the template re-runs
  const snapshot = () => `${Math.max(0, now - startedAt)}ms`;
  // the WORKING shape: the template calls this, so the read happens during rendering
  const thunk = () => `${Math.max(0, now - startedAt)}ms`;
  return { tick, snapshot, thunk };
}

test("a value read once in the render body freezes at its first value (#render)", () => {
  const clock = makeClock(500);
  const firstRender = clock.snapshot(); // what the JSX got
  assert.equal(firstRender, "500ms");

  clock.tick(2000);
  assert.equal(clock.snapshot(), "1500ms", "the clock did move");
  assert.equal(firstRender, "500ms", "but the rendered value never changes — the reported freeze");
});

test("a thunk re-reads on every render, so the counter advances (#render)", () => {
  const clock = makeClock(500);
  const renders: string[] = [];
  const render = () => renders.push(clock.thunk()); // what a tracked expression does

  render();
  clock.tick(2000);
  render();
  clock.tick(61_000);
  render();

  assert.deepEqual(renders, ["500ms", "1500ms", "60500ms"], "a tick must reach the readout every time");
});

test("the readout is guarded on the RESULT, so an unarmed or stale clock renders nothing (#render)", () => {
  /**
   * Both halves of the guard that the hoist was introduced for, kept working: 0 is the "not armed"
   * sentinel (`now - 0` is the epoch), and a clock left armed from an earlier stretch must not render
   * a five-digit hour count. Expressing it as `null` from the thunk is what lets `<Show>` gate it
   * without losing the subscription.
   */
  const txt = (startedAt: number, now: number) => {
    if (!startedAt) return null;
    const elapsed = Math.max(0, now - startedAt);
    if (elapsed > 24 * 60 * 60 * 1000) return null;
    return `${elapsed}ms`;
  };
  assert.equal(txt(0, 1000), null, "unarmed renders nothing, not the epoch");
  assert.equal(txt(1000, 1000), "0ms", "an armed clock renders 0ms — 0 is a real elapsed time");
  assert.equal(txt(1, 1000 + 25 * 60 * 60 * 1000), null, "a stretch older than a day is not this block");
});

/**
 * And the COMPONENT must be shaped that way.
 *
 * The three tests above prove the mechanism; this one proves the component uses it. Without it, the
 * regression that actually shipped (a hoist above the `return`) would pass every test above while
 * the counter stayed frozen — which is precisely what happened, twice.
 *
 * `fmtDur` appearing inside a `const txt = () => …` thunk is the property; where the bounds check
 * sits does not matter, only that the read is inside a function the template calls.
 */
test("ThinkingTimer computes its readout inside a thunk, not in the render body (#render)", () => {
  const src = readFileSync("frontend/components/code.tsx", "utf8");
  const at = src.indexOf("export function ThinkingTimer");
  assert.ok(at > 0, "ThinkingTimer must exist");
  const body = src.slice(at, src.indexOf("export function AnsiText", at));

  assert.match(body, /const txt = \(\) =>/, "the readout must be a thunk the template calls (#render)");
  // the elapsed value must be derived INSIDE that thunk, not hoisted above the return
  const beforeReturn = body.slice(0, body.indexOf("return ("));
  assert.doesNotMatch(
    beforeReturn.replace(/const txt = \(\) => \{[\s\S]*?\n  \};/, ""),
    /const elapsed = Math\.max\(0, now\(\) -/,
    "hoisting `elapsed` above the `return` reads the clock ONCE and freezes the counter (#render)",
  );
  assert.match(body, /\{txt\(\)\}/, "and the template must render the thunk's value");
});
