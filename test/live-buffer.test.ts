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
// #126: normalises CRLF so source anchors behave the same on Windows
import {
  applyDelta,
  clearLive,
  isTurnBoundary,
  isCoveredByLog,
  pruneDeadLiveBuffers,
  reconcileLiveBuffer,
  type LiveBuf,
} from "../frontend/lib/live-buffer.ts";

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

test("isCoveredByLog needs the log to REALLY hold the text, not just a stopped agent (#40)", () => {
  // This used to assert `isCoveredByLog(buf("anything"), [], "idle") === true`: "the
  // agent stopped, so drop whatever the bubble holds". That is the bug — a turn
  // settles before its assistant event is delivered, so at that instant the log holds
  // nothing and the bubble was destroyed with nothing to replace it. The message
  // blinked out and came back.
  //
  // The property #40 actually wanted: an IDLE bubble is redundant only when the log
  // already has its content.
  assert.equal(
    isCoveredByLog(buf("anything"), [], "idle"),
    false,
    "an empty log cannot be what this bubble became — the event has not arrived yet",
  );
  const persisted = [{ type: "message", data: { role: "assistant", content: "anything" } }];
  assert.equal(isCoveredByLog(buf("anything"), persisted, "idle"), true, "persisted → drop (#40)");
  // a DIFFERENT persisted reply must not cover it either
  const other = [{ type: "message", data: { role: "assistant", content: "something else" } }];
  assert.equal(isCoveredByLog(buf("anything"), other, "idle"), false);
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


});

/* ---------- the two halves settle independently ---------- */

/**
 * Reported: "reasoningだけしてtool発行したらreasoningのliveがタイムラインに残留する".
 *
 * The mechanism was one boolean serving two questions. `isCoveredByLog` asked "does the log carry
 * this bubble's TEXT?"; for a reasoning-only buffer there is no text, so it fell through to "is the
 * agent still live?", which stays true for the WHOLE turn — including the tool run, when the model
 * cannot be thinking. Nothing retired the 💭 block, so it sat there next to the tool row it had
 * already preceded.
 *
 * These pin the boundary in three directions, because a patch that fixes only the reported case
 * would pass a single test while still being one boolean.
 */
const reasoningBuf = (reasoning: string, at = 1000): LiveBuf => ({ text: "", reasoning, at });
const toolStart = (ts: string) => ({ type: "tool_call", ts, data: {} });

test("reasoning is retired once a tool call starts after it (#40)", () => {
  const events = [toolStart(new Date(2000).toISOString())];
  assert.equal(
    isCoveredByLog(reasoningBuf("let me look at the config"), events, "running"),
    true,
    "the model cannot be thinking and running a tool at once — the 💭 block is over (#40)",
  );
});

test("reasoning survives while it is still the newest thing (#40)", () => {
  // no tool call yet: the stretch is in progress and dropping it blanks the bubble mid-thought
  assert.equal(
    isCoveredByLog(reasoningBuf("still thinking"), [], "running"),
    false,
    "nothing has superseded this reasoning, so it must stay (#40)",
  );
});

test("a LATER reasoning stretch is not cleared by an EARLIER tool call (#40)", () => {
  /**
   * After a tool result the model reasons again. Those deltas advance `at` past the old
   * `tool_start`, so the fresh stretch must survive — a check that only asked "does a tool_start
   * exist" would retire every subsequent thought on the turn.
   */
  const events = [toolStart(new Date(1000).toISOString())];
  assert.equal(
    isCoveredByLog(reasoningBuf("now that I have the file, thinking again", 5000), events, "running"),
    false,
    "a tool call BEFORE this reasoning does not end it (#40)",
  );
});

test("streaming TEXT keeps its bubble while stale reasoning is retired (#40)", () => {
  /**
   * The reason the halves had to be split: a reply can be mid-stream (the log does not have it, so
   * its bubble must stay) at the same moment the thinking stretch is provably over. One boolean
   * could only answer one of them.
   */
  const mixed: LiveBuf = { text: "half a repl", reasoning: "thinking that is done", at: 1000 };
  const events = [toolStart(new Date(2000).toISOString())];
  const rest = reconcileLiveBuffer(mixed, events, "running");
  assert.ok(rest, "the reply is not in the log yet, so the bubble stays (#40)");
  assert.equal(rest!.text, "half a repl", "unpersisted text must be kept (#40)");
  assert.equal(rest!.reasoning, "", "and the finished thinking block dropped (#40)");
});

/**
 * The fixture must use the event type the system actually emits.
 *
 * The stale-reasoning guard looked for `tool_start`, a type that does not exist: `EventType` declares
 * `tool_call` and `tool_result`. Every test above passed because their fixtures were built with the
 * same wrong string — so the guard was always false, it was never exercised, and a 💭 block stayed on
 * the timeline after the tool row it preceded. MEASURED in a real session: the live bubble carried
 * the exact reasoning text of the settled assistant turn above it.
 *
 * A fixture is only evidence when it matches what is emitted, so this reads the SOURCE OF TRUTH and
 * fails if the guard ever names a type that is not declared there.
 */
test("the stale-reasoning guard names a REAL event type (#40)", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.join(import.meta.dirname, "..");
  const declared = await readFile(path.join(root, "src/log/events.ts"), "utf8");
  const guard = await readFile(path.join(root, "frontend/lib/live-buffer.ts"), "utf8");

  const at = guard.indexOf("function startedToolCallSince");
  const body = guard.slice(at, guard.indexOf("\n}", at));
  const named = [...body.matchAll(/e\.type\s*!==\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  assert.ok(named.length > 0, "the guard must compare against some event type");
  for (const t of named) {
    assert.match(
      declared,
      new RegExp(`\\|\\s*"${t}"`),
      `the guard compares against "${t}", which EventType does not declare — a guard that names a ` +
        `type nothing emits can never fire (#40)`,
    );
  }
});
