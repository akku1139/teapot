import { test, describe } from "node:test";
import assert from "node:assert/strict";
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

test("a delta only ever touches its own agent's buffer (#40)", () => {
  let m = applyDelta(new Map(), "agent1", { text: "hello from one" });
  m = applyDelta(m, "agent2", { text: "hello from two" });
  assert.equal(m.get("agent1")?.text, "hello from one");
  assert.equal(m.get("agent2")?.text, "hello from two");
  assert.equal(m.size, 2, "both agents keep their own stream");
});

test("a turn boundary drops the previous turn's buffer (#40)", () => {
  let m = applyDelta(new Map(), "agent1", { text: "agent1 finished reply" });
  assert.ok(m.has("agent1"));
  m = clearLive(m, "agent1");
  assert.equal(m.has("agent1"), false, "stale buffer survived the turn boundary (#40)");
});

test("the reported sequence leaves no duplicate text behind (#40)", () => {
  let m = applyDelta(new Map(), "agent1", { text: "agent1 finished reply" });
  m = clearLive(m, "agent1"); 
  m = applyDelta(m, "agent2", { text: "agent2 working" });
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

test("isTurnBoundary recognises only the per-turn state event (#40)", () => {
  assert.equal(isTurnBoundary({ type: "state", data: { detail: "llm turn start" } }), true);
  assert.equal(isTurnBoundary({ type: "state", data: { from: "idle", to: "running" } }), false);
  assert.equal(isTurnBoundary({ type: "state", data: { detail: "something else" } }), false);
  assert.equal(isTurnBoundary({ type: "message", data: { role: "assistant" } }), false);
  assert.equal(isTurnBoundary({ type: "tool_result", data: {} }), false);
  assert.equal(isTurnBoundary(null), false);
  assert.equal(isTurnBoundary(undefined), false);
});

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
  assert.equal(
    isCoveredByLog(buf("anything"), [], "idle"),
    false,
    "an empty log cannot be what this bubble became — the event has not arrived yet",
  );
  const persisted = [{ type: "message", data: { role: "assistant", content: "anything" } }];
  assert.equal(isCoveredByLog(buf("anything"), persisted, "idle"), true, "persisted → drop (#40)");
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
  assert.equal(isCoveredByLog(buf(""), [], "idle"), true);
  assert.equal(isCoveredByLog(buf(""), [], "running"), false);
});

test("isCoveredByLog handles a missing buffer (#40)", () => {
  assert.equal(isCoveredByLog(null, [], "running"), false);
});

describe("pruneDeadLiveBuffers (#40)", () => {
  const status = (m: Record<string, string>) => (id: string) => m[id];

  test("drops an unselected agent's buffer once it goes idle", () => {
    const bufs = new Map([
      ["agent1", { text: "stale reply", reasoning: "", at: 1 }],
      ["agent2", { text: "still writing", reasoning: "", at: 2 }],
    ]);
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
    const bufs = new Map([["agent1", { text: "t", reasoning: "", at: 1 }]]);
    const out = pruneDeadLiveBuffers(bufs, status({}));
    assert.equal(out.has("agent1"), true, "an unknown status must not prune (#40)");
  });

  test("preserves map identity when nothing is dead", () => {
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
  assert.equal(
    isCoveredByLog(reasoningBuf("still thinking"), [], "running"),
    false,
    "nothing has superseded this reasoning, so it must stay (#40)",
  );
});

test("a LATER reasoning stretch is not cleared by an EARLIER tool call (#40)", () => {
  const events = [toolStart(new Date(1000).toISOString())];
  assert.equal(
    isCoveredByLog(reasoningBuf("now that I have the file, thinking again", 5000), events, "running"),
    false,
    "a tool call BEFORE this reasoning does not end it (#40)",
  );
});

test("streaming TEXT keeps its bubble while stale reasoning is retired (#40)", () => {
  const mixed: LiveBuf = { text: "half a repl", reasoning: "thinking that is done", at: 1000 };
  const events = [toolStart(new Date(2000).toISOString())];
  const rest = reconcileLiveBuffer(mixed, events, "running");
  assert.ok(rest, "the reply is not in the log yet, so the bubble stays (#40)");
  assert.equal(rest!.text, "half a repl", "unpersisted text must be kept (#40)");
  assert.equal(rest!.reasoning, "", "and the finished thinking block dropped (#40)");
});

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

test("reasoning already in the log retires the live copy (#40)", () => {
  const reasoning = "the decompiler models this as a 64-bit return";
  const buf: LiveBuf = { text: "", reasoning, at: Date.now() }; 
  const events = [
    { type: "message", ts: "2026-01-01T00:00:01Z", data: { role: "assistant", content: "checking", reasoning } },
    { type: "tool_call", ts: "2026-01-01T00:00:02Z", data: {} },
  ];
  assert.equal(
    isCoveredByLog(buf, events, "running"),
    true,
    "the log holds this reasoning, so the live copy is a duplicate — a timestamp comparison can be " +
      "beaten by a late delta, which is exactly what happened (#40)",
  );
});

test("reasoning the log does NOT carry survives (#40)", () => {
  const buf: LiveBuf = { text: "", reasoning: "still weighing the options", at: 1000 };
  assert.equal(
    isCoveredByLog(
      buf,
      [{ type: "message", data: { role: "assistant", content: "x", reasoning: "something else" } } as never],
      "running",
    ),
    false,
    "an unpersisted thinking stretch must stay visible (#40)",
  );
});
