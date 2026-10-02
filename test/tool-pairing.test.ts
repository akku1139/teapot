/**
 * #54 — "bash sometimes never reads as complete on the streaming timeline.
 *        With a normal API (not WS) the timeline DOES update, so maybe the WS
 *        state management is wrong — or the frontend event dispatcher.
 *        This may also be the cause of #46."
 *
 * The real cause is neither, and it is not about streaming at all: the frontend
 * pairs a `tool_call` with its `tool_result` by walking the events it has, and
 * `/api/agents/:id/events` returns only the LAST `limit` events (200 by
 * default). A long-running bash streams in the meantime, so by the time the
 * result lands, the CALL has been pushed out of the window while the RESULT is
 * inside it. The pairing walk sees a result with no call, and the row renders
 * "waiting for output…" forever.
 *
 * The stale-run guard (`staleDone`) is supposed to rescue exactly this — it
 * marks an unpaired call as done once the agent is no longer running — but it
 * only applies to rows the frontend still HAS. Once the call event is gone from
 * the loaded window there is no row left to rescue: the result event is in the
 * feed as an orphan, and the bash row is simply absent.
 *
 * So the fix is to make the window wide enough to always contain a whole
 * tool call/result pair, and to render an orphaned RESULT rather than dropping
 * it on the floor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * mirror of the shipped pairing walk in pairInfo(): tool_call events are queued
 * per callId and a tool_result consumes the earliest one
 */
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
  // a result with no call in the window is an ORPHAN: the call was evicted
  const orphanResults: string[] = [];
  const seenCalls = new Set<string>();
  for (const e of events) if (e.type === "tool_call") seenCalls.add(String(e.data.callId));
  for (const e of events)
    if (e.type === "tool_result" && !seenCalls.has(String(e.data.callId))) orphanResults.push(e.id);
  return { resFor, orphanResults };
}

type Ev = { id: string; type: string; data: { callId?: string; result?: string } };

/** a long bash: the call, then lots of streaming noise, then the result */
function longBashStream(noise: number): Ev[] {
  const out: Ev[] = [{ id: "c", type: "tool_call", data: { callId: "k1" } }];
  for (let i = 0; i < noise; i++)
    out.push({ id: `n${i}`, type: "message", data: { result: "token" } });
  out.push({ id: "r", type: "tool_result", data: { callId: "k1", result: "done" } });
  return out;
}

/** the window /api/agents/:id/events used before #54 */
export const DEFAULT_WINDOW = 200;

/**
 * The smallest window that guarantees a tool_call and its tool_result are both
 * present, given the most events that can arrive between them.
 *
 * `maxGap` is the worst case: how many events can be logged between a tool
 * being called and its result landing. A long bash streaming tokens is the
 * pathological one, since every delta is an event.
 */
export function windowFor(maxGap: number, safety = 2): number {
  // 1 call + maxGap interleaved + 1 result, doubled so a result landing at the
  // very edge of one window still has its call inside the same one
  return Math.max(DEFAULT_WINDOW, (maxGap + 2) * safety);
}

/* ---------- the shipped default, and why it was the bug ---------- */

test("the SHIPPED default window orphans a long bash's call (#54)", () => {
  // documents the defect precisely: the pairing walk is correct, but the server
  // hands the frontend only the tail, so the call is gone by the time its
  // result lands. This is the state the code was in when #54 was reported.
  const all = longBashStream(400);
  const { resFor, orphanResults } = pairEvents(all.slice(-DEFAULT_WINDOW));
  assert.equal(resFor.size, 0, `the default ${DEFAULT_WINDOW}-event window orphans the call (#54)`);
  assert.deepEqual(orphanResults, ["r"], "…leaving the result stranded (#54)");
  // …and the pairing logic itself is fine once the whole log is available
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
  // Guards against a token fix. With 400 events between a call and its result,
  // the window must exceed 401 to hold both; 200 and 400 still orphan it.
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

/* ---------- the belt-and-braces half ---------- */

test("an orphaned result is still rendered, not dropped (#54)", () => {
  // however wide the window, an eviction can still strand a result (an operator
  // scrolled far back, a session resumed mid-flight). The renderer must show it
  // rather than let it vanish — this is what makes the row "complete" even when
  // its call is gone.
  const events: Ev[] = [{ id: "r", type: "tool_result", data: { callId: "k1", result: "done" } }];
  const { orphanResults } = pairEvents(events);
  assert.deepEqual(orphanResults, ["r"], "the result is detectable as an orphan (#54)");
  // the guard the renderer must apply: an orphan is a COMPLETE row, never a
  // permanently pending one
  assert.equal(events[0]!.type, "tool_result", "an orphan result carries its own completion (#54)");
});

/* ---------- what the shipped code must do ---------- */

import { readFileSync } from "node:fs";

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

test("pairInfo must flag a result whose call is missing (#54)", () => {
  srcHas("an unpaired result must be detectable (#54)", /orphanCalls/);
  srcHas("the orphan must be handed to the renderer (#54)", /orphan=\{pairInfo\(\)\.orphanCalls\.has/);
});

test("an orphan result renders as a COMPLETED tool row (#54)", () => {
  const block = app.slice(app.indexOf('case "tool_result"'));
  const chunk = block.slice(0, 1600);
  // it must carry the tool's identity and its outcome, not just a blob
  srcHas("the orphan row must name the tool (#54)", /name === "bash"|String\(e\.data\.name/);
  srcHas("the orphan row must show the duration/outcome (#54)", /outcomeMarker|fmtDur/);
  srcHas("the orphan row must be expanded by default so it reads as finished (#54)", /open=\{props\.orphan\}/);
  // …and must not be the old anonymous one-line blob
  assert.doesNotMatch(
    chunk,
    /oneLine\(out, 120\)/,
    "the old anonymous output blob is what made the run look unfinished (#54)",
  );
});
