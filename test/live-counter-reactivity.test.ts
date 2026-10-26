import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function makeClock(startedAt: number) {
  let now = 1000;
  const tick = (to: number) => {
    now = to;
  };
  const snapshot = () => `${Math.max(0, now - startedAt)}ms`;
  const thunk = () => `${Math.max(0, now - startedAt)}ms`;
  return { tick, snapshot, thunk };
}

test("a value read once in the render body freezes at its first value (#render)", () => {
  const clock = makeClock(500);
  const firstRender = clock.snapshot(); 
  assert.equal(firstRender, "500ms");

  clock.tick(2000);
  assert.equal(clock.snapshot(), "1500ms", "the clock did move");
  assert.equal(firstRender, "500ms", "but the rendered value never changes — the reported freeze");
});

test("a thunk re-reads on every render, so the counter advances (#render)", () => {
  const clock = makeClock(500);
  const renders: string[] = [];
  const render = () => renders.push(clock.thunk()); 

  render();
  clock.tick(2000);
  render();
  clock.tick(61_000);
  render();

  assert.deepEqual(renders, ["500ms", "1500ms", "60500ms"], "a tick must reach the readout every time");
});

test("the readout is guarded on the RESULT, so an unarmed or stale clock renders nothing (#render)", () => {
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

test("ThinkingTimer computes its readout inside a thunk, not in the render body (#render)", () => {
  const src = readFileSync("frontend/components/code.tsx", "utf8");
  const at = src.indexOf("export function ThinkingTimer");
  assert.ok(at > 0, "ThinkingTimer must exist");
  const body = src.slice(at, src.indexOf("export function AnsiText", at));

  assert.match(body, /const txt = \(\) =>/, "the readout must be a thunk the template calls (#render)");
  const beforeReturn = body.slice(0, body.indexOf("return ("));
  assert.doesNotMatch(
    beforeReturn.replace(/const txt = \(\) => \{[\s\S]*?\n  \};/, ""),
    /const elapsed = Math\.max\(0, now\(\) -/,
    "hoisting `elapsed` above the `return` reads the clock ONCE and freezes the counter (#render)",
  );
  assert.match(body, /\{txt\(\)\}/, "and the template must render the thunk's value");
});
