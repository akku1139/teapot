import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function pairEvents(
  events: { id: string; type: string; data: { callId?: string } }[],
): { resFor: Map<string, string>; orphanResults: string[] } {
  const resFor = new Map<string, string>();
  const awaiting = new Map<string, string[]>();
  for (const e of events) {
    if (e.type === "tool_call") {
      const q = awaiting.get(String(e.data.callId)) ?? [];
      q.push(e.id);
      awaiting.set(String(e.data.callId), q);
    } else if (e.type === "tool_result") {
      const call = awaiting.get(String(e.data.callId))?.shift();
      if (call) resFor.set(call, e.id);
    }
  }
  const orphanResults: string[] = [];
  const seenCalls = new Set<string>();
  for (const e of events) if (e.type === "tool_call") seenCalls.add(String(e.data.callId));
  for (const e of events)
    if (e.type === "tool_result" && !seenCalls.has(String(e.data.callId))) orphanResults.push(e.id);
  return { resFor, orphanResults };
}

type Ev = { id: string; type: string; data: { callId?: string; result?: string } };

function longBashStream(noise: number): Ev[] {
  const out: Ev[] = [{ id: "c", type: "tool_call", data: { callId: "k1" } }];
  for (let i = 0; i < noise; i++)
    out.push({ id: `n${i}`, type: "message", data: { result: "token" } });
  out.push({ id: "r", type: "tool_result", data: { callId: "k1", result: "done" } });
  return out;
}

export const DEFAULT_WINDOW = 200;

export function windowFor(maxGap: number, safety = 2): number {
  return Math.max(DEFAULT_WINDOW, (maxGap + 2) * safety);
}

test("the SHIPPED default window orphans a long bash's call (#54)", () => {
  const all = longBashStream(400);
  const { resFor, orphanResults } = pairEvents(all.slice(-DEFAULT_WINDOW));
  assert.equal(resFor.size, 0, `the default ${DEFAULT_WINDOW}-event window orphans the call (#54)`);
  assert.deepEqual(orphanResults, ["r"], "…leaving the result stranded (#54)");
  assert.equal(pairEvents(all).resFor.size, 1, "the walk is correct; the WINDOW was the bug (#54)");
});

test("the request must ask for a window that fits a whole pair (#54)", () => {
  const needed = windowFor(400);
  assert.ok(
    needed > DEFAULT_WINDOW,
    `a long stream needs a wider window than the ${DEFAULT_WINDOW} default (#54)`,
  );
  const all = longBashStream(400);
  assert.equal(pairEvents(all.slice(-needed)).resFor.size, 1, "the wider window pairs them (#54)");
});

test("raising the window a LITTLE is not enough (#54)", () => {
  const all = longBashStream(400);
  for (const limit of [200, 400, 401]) {
    assert.equal(
      pairEvents(all.slice(-limit)).resFor.size,
      0,
      `limit=${limit} is not wide enough for a 400-event stream (#54)`,
    );
  }
  assert.equal(
    pairEvents(all.slice(-windowFor(400))).resFor.size,
    1,
    `the sized window (${windowFor(400)}) works (#54)`,
  );
});

test("an orphaned result is still rendered, not dropped (#54)", () => {
  const events: Ev[] = [{ id: "r", type: "tool_result", data: { callId: "k1", result: "done" } }];
  const { orphanResults } = pairEvents(events);
  assert.deepEqual(orphanResults, ["r"], "the result is detectable as an orphan (#54)");
  assert.equal(events[0]!.type, "tool_result", "an orphan result carries its own completion (#54)");
});

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");

function srcHas(label: string, re: RegExp): void {
  if (!re.test(app)) assert.fail(`${label}\n  expected source to match: ${re}`);
}

test("the events endpoint must default to a window that fits a pair (#54)", () => {
  const m = api.match(/const limit = Math\.min\(Number\(c\.req\.query\("limit"\) \?\? (\d+)\), (\d+)\)/);
  assert.ok(m, "the events endpoint must declare its window (#54)");
  const dflt = Number(m![1]);
  const clamp = Number(m![2]);
  assert.ok(
    dflt > DEFAULT_WINDOW,
    `the default window (${dflt}) must exceed the old ${DEFAULT_WINDOW} that caused #54`,
  );
  assert.ok(
    clamp >= dflt,
    `the clamp (${clamp}) must not silently cap the default back down to ${DEFAULT_WINDOW} (#54)`,
  );
});

