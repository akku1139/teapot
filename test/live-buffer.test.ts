/**
 * #40 — "with the message order agent1 → bash (running) → agent2 (writing),
 * agent2's message shows agent1's content with a 'writing' prompt attached"
 *
 * The live-stream buffer is keyed per agent (correct), but its LIFECYCLE was
 * not: an agent's `status` does not change between tool calls within one round,
 * so a finished reply's buffer was never cleared. It lingered and kept
 * rendering under the streaming…/writing… chrome until some later, unrelated
 * event happened to cover it.
 *
 * The fix clears the buffer at the real turn boundary — the "llm turn start"
 * state event the server already logs once per turn. The empty llm-delta the
 * server sends before each call is NOT a valid boundary: it fires on every
 * RETRY too, so clearing on it would flash the bubble away mid-reply.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyDelta,
  clearLive,
  isTurnBoundary,
  isCoveredByLog,
  pruneDeadLiveBuffers,
  type LiveBuf,
} from "../frontend/live-buffer.ts";

const buf = (text: string): LiveBuf => ({ text, reasoning: "", at: 1000 });

/* ---------- per-agent isolation ---------- */

test("a delta only ever touches its own agent's buffer (#40)", () => {
  let m = applyDelta(new Map(), "agent1", { text: "hello from one" });
  m = applyDelta(m, "agent2", { text: "hello from two" });
  assert.equal(m.get("agent1")?.text, "hello from one");
  assert.equal(m.get("agent2")?.text, "hello from two");
  assert.equal(m.size, 2, "both agents keep their own stream");
});

/* ---------- THE regression ---------- */

test("a turn boundary drops the previous turn's buffer (#40)", () => {
  // agent1 finished its reply and moved on to a bash tool call
  let m = applyDelta(new Map(), "agent1", { text: "agent1 finished reply" });
  assert.ok(m.has("agent1"));
  // the NEXT turn starts — the stale reply must not survive into it
  m = clearLive(m, "agent1");
  assert.equal(m.has("agent1"), false, "stale buffer survived the turn boundary (#40)");
});

test("the reported sequence leaves no duplicate text behind (#40)", () => {
  // agent1 → bash(running) → agent2(writing)
  let m = applyDelta(new Map(), "agent1", { text: "agent1 finished reply" });
  m = clearLive(m, "agent1"); // agent1's next turn begins (the bash call)
  m = applyDelta(m, "agent2", { text: "agent2 working" });
  // agent2's bubble must show ONLY agent2's text
  assert.equal(m.get("agent2")?.text, "agent2 working");
  assert.equal(m.has("agent1"), false, "agent1's text leaked into agent2's view");
});

test("a turn boundary only clears the agent that started a turn (#40)", () => {
  let m = applyDelta(new Map(), "agent1", { text: "one" });
  m = applyDelta(m, "agent2", { text: "two" });
  m = clearLive(m, "agent1");
  assert.equal(m.has("agent1"), false);
  assert.equal(m.get("agent2")?.text, "two", "agent2 was still streaming and must survive");
});

test("clearing with no buffer is a no-op that preserves identity (#40)", () => {
  const m = applyDelta(new Map(), "agent2", { text: "two" });
  const same = clearLive(m, "agent1");
  assert.equal(same, m, "must return the SAME map so Solid can skip re-rendering");
});

/* ---------- boundary detection ---------- */

test("isTurnBoundary recognises only the per-turn state event (#40)", () => {
  assert.equal(isTurnBoundary({ type: "state", data: { detail: "llm turn start" } }), true);
  // every other state change is NOT a turn boundary
  assert.equal(isTurnBoundary({ type: "state", data: { from: "idle", to: "running" } }), false);
  assert.equal(isTurnBoundary({ type: "state", data: { detail: "something else" } }), false);
  assert.equal(isTurnBoundary({ type: "message", data: { role: "assistant" } }), false);
  assert.equal(isTurnBoundary({ type: "tool_result", data: {} }), false);
  assert.equal(isTurnBoundary(null), false);
  assert.equal(isTurnBoundary(undefined), false);
});

test("App.tsx clears on the turn boundary, not on the per-attempt reset (#40)", () => {
  // Guards against "fixing" this by clearing on the empty llm-delta the server
  // emits before EVERY call — that fires on retries too and would blank the
  // bubble mid-reply.
  const src = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  assert.match(src, /isTurnBoundary\(msg\.event\)/, "turn-boundary check must be wired in");
  const handler = src.slice(src.indexOf('if (msg.kind === "llm-delta")'));
  const boundaryBlock = handler.slice(0, handler.indexOf('if (msg.kind === "llm-delta")'));
  assert.doesNotMatch(
    boundaryBlock,
    /msg\.text\s*\?\?\s*""\)\s*===\s*""/,
    "must not clear the buffer by inspecting delta text",
  );
});

/* ---------- the covered-by-log rule ---------- */

test("isCoveredByLog drops a buffer the log already carries (#40)", () => {
  const events = [
    { type: "message", data: { role: "assistant", content: "persisted reply" } },
  ];
  assert.equal(isCoveredByLog(buf("persisted reply"), events, "running"), true);
});

test("isCoveredByLog keeps a buffer that is genuinely still streaming (#40)", () => {
  const events = [
    { type: "message", data: { role: "assistant", content: "an OLDER reply" } },
  ];
  assert.equal(
    isCoveredByLog(buf("a reply still being written"), events, "running"),
    false,
    "a live bubble must not be blanked mid-reply",
  );
});

test("isCoveredByLog drops anything once the agent is no longer running (#40)", () => {
  assert.equal(isCoveredByLog(buf("anything"), [], "idle"), true);
});

test("isCoveredByLog ignores non-assistant and non-matching rows (#40)", () => {
  const events = [
    { type: "message", data: { role: "user", content: "same text" } },
    { type: "message", data: { role: "assistant", content: "different text" } },
  ];
  assert.equal(isCoveredByLog(buf("same text"), events, "running"), false);
});

test("isCoveredByLog drops a reasoning-only buffer when the agent stops (#40)", () => {
  // reasoning-only buffers never persist a message, so they can only be
  // dropped on the status change — that path must not regress
  assert.equal(isCoveredByLog(buf(""), [], "idle"), true);
  assert.equal(isCoveredByLog(buf(""), [], "running"), false);
});

test("isCoveredByLog handles a missing buffer (#40)", () => {
  assert.equal(isCoveredByLog(null, [], "running"), false);
});
/* ---------- pruning buffers whose agent is not live (#40) ---------- */

/**
 * The reported symptom was "agent2's message shows agent1's content, with a
 * writing cursor". The buffer store is already per-agent and correctly keyed —
 * so the duplication was not a key collision. It was a buffer that was never
 * CLEARED: the pruning effect consulted only the SELECTED agent's status, so
 * every other agent depended entirely on its turn-boundary event arriving over
 * the WebSocket. Nothing replays missed events on reconnect, so a boundary lost
 * across a reconnect left that text on screen with the streaming chrome still
 * attached, until a reload (the buffers are memory-only).
 */
describe("pruneDeadLiveBuffers (#40)", () => {
  const status = (m: Record<string, string>) => (id: string) => m[id];

  test("drops an unselected agent's buffer once it goes idle", () => {
    const bufs = new Map([
      ["agent1", { text: "stale reply", reasoning: "", at: 1 }],
      ["agent2", { text: "still writing", reasoning: "", at: 2 }],
    ]);
    // agent1 finished (idle), agent2 is mid-turn — and NEITHER is "selected"
    // from the store's point of view
    const out = pruneDeadLiveBuffers(bufs, status({ agent1: "idle", agent2: "running" }));
    assert.equal(out.has("agent1"), false, "the idle agent's stale buffer must go (#40)");
    assert.equal(out.get("agent2")?.text, "still writing", "the live agent's buffer must survive (#40)");
  });

  test("keeps a WAITING agent — a parked tool is still in flight", () => {
    const bufs = new Map([["agent1", { text: "t", reasoning: "", at: 1 }]]);
    const out = pruneDeadLiveBuffers(bufs, status({ agent1: "waiting" }));
    assert.equal(out.has("agent1"), true, "waiting is not dead (#40)");
  });

  test("does NOT guess when an agent has no status", () => {
    // absence of evidence is not evidence of completion: a snapshot we have not
    // received yet must not be treated as idle, or a connecting client loses
    // every buffer it has
    const bufs = new Map([["agent1", { text: "t", reasoning: "", at: 1 }]]);
    const out = pruneDeadLiveBuffers(bufs, status({}));
    assert.equal(out.has("agent1"), true, "an unknown status must not prune (#40)");
  });

  test("preserves map identity when nothing is dead", () => {
    // Solid skips re-rendering on referential equality, and this effect runs on
    // every snapshot
    const bufs = new Map([["agent1", { text: "t", reasoning: "", at: 1 }]]);
    const out = pruneDeadLiveBuffers(bufs, status({ agent1: "running" }));
    assert.equal(out.size, 1);
    assert.equal(pruneDeadLiveBuffers(bufs, status({ agent1: "running" })), bufs, "no-op keeps identity (#40)");
  });

  test("prunes every dead buffer, not just the first", () => {
    const bufs = new Map([
      ["a", { text: "1", reasoning: "", at: 1 }],
      ["b", { text: "2", reasoning: "", at: 2 }],
      ["c", { text: "3", reasoning: "", at: 3 }],
    ]);
    const out = pruneDeadLiveBuffers(bufs, status({ a: "idle", b: "stopped", c: "running" }));
    assert.deepEqual([...out.keys()], ["c"], "only the live agent remains (#40)");
  });

  test("App.tsx prunes by agent status, not by the selected session", () => {
    // This assertion used to REQUIRE the dead-code shape — `agents()` read
    // inside the signal updater — which is precisely why v0.26.1 shipped the fix
    // and it never ran. It asserted the text, not the behaviour.
    //
    // The wiring is now asserted in test/live-buffer-wiring.test.ts, which
    // checks the dependency is read OUTSIDE the updater (the thing that actually
    // makes the effect subscribe) and that nothing else has the same bug.
    const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
    const at = app.indexOf("pruneDeadLiveBuffers(prev");
    const start = app.lastIndexOf("createEffect(", at);
    const body = app.slice(start, app.indexOf("\n  });", at));
    assert.match(
      body,
      /const list = agents\(\)/,
      "agents() must be read in the effect body so the effect subscribes (#40)",
    );
    assert.match(
      body,
      /list\.find\(\(x\) => x\.id === id\)/,
      "status must come from the agent snapshot, per agent (#40)",
    );
    assert.doesNotMatch(
      body,
      /selected\(\)/,
      "and must not be scoped to the selected agent — that was the original bug (#40)",
    );
  });
});
