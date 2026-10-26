import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const agent = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");

import { buildTimeline, type TimelineEvent } from "../frontend/lib/timeline.ts";

const FEED = new Set([
  "prompt", "message", "tool_call", "tool_result", "system_note", "decision", "progress",
]);
const RENDERED = new Set([
  "prompt", "message", "tool_call", "tool_result", "decision", "progress",
]);
const RENDERED_NOTES = new Set(["context-compacted"]);

let n = 0;
const ev = (type: string, data: Record<string, unknown> = {}): TimelineEvent => ({
  id: `e${++n}`,
  seq: n,
  type,
  data,
});

function run(events: TimelineEvent[]): TimelineEvent[] {
  return buildTimeline({
    events,
    consumed: new Set<string>(),
    pending: [],
    echo: () => ev("prompt", {}),
    feedTypes: FEED,
    renderedTypes: RENDERED,
    renderedNoteEvents: RENDERED_NOTES,
  });
}

test("a record_decision call shows ONCE — the card, never the meta rows (#107)", () => {
  const events = [
    ev("message", { role: "user", content: "pick one" }),
    ev("tool_call", { name: "record_decision", args: { decision: "use X" } }),
    ev("decision", { decision: "use X", rationale: "because Y" }),
    ev("tool_result", { name: "record_decision", ok: true, result: "recorded" }),
    ev("message", { role: "assistant", content: "done" }),
  ];
  const out = run(events);

  assert.ok(
    events.some((e) => e.type === "decision"),
    "precondition: the decision event must be present",
  );
  assert.ok(
    events.some((e) => e.type === "tool_call" && e.data?.name === "record_decision"),
    "precondition: the tool CALL must be present, or there is nothing to suppress",
  );

  const decisionRows = out.filter((e) => e.type === "decision");
  assert.equal(decisionRows.length, 1, "the decision card must appear exactly once");
  const metaRows = out.filter(
    (e) =>
      (e.type === "tool_call" || e.type === "tool_result") &&
      e.data?.name === "record_decision",
  );
  assert.deepEqual(metaRows, [], "no meta row may restate that the tool was called (#107)");
});

test("report_progress and ask_user are suppressed the same way (#107)", () => {
  for (const tool of ["report_progress", "ask_user"]) {
    const events = [
      ev("tool_call", { name: tool, args: {} }),
      ev("tool_result", { name: tool, ok: true, result: "ok" }),
    ];
    const out = run(events);
    assert.equal(events.length, 2);
    assert.deepEqual(out, [], `${tool}'s rows must all be dropped — its embed tells the story`);
  }
});

test("no OTHER tool was newly excluded (#107)", () => {
  const events = [
    ev("tool_call", { name: "bash", args: { command: "ls" } }),
    ev("tool_result", { name: "bash", ok: true, result: "a.txt" }),
  ];
  const out = run(events);
  assert.equal(out.length, 2, `an ordinary tool must keep its rows; got ${JSON.stringify(out.map((e) => e.type))}`);
});

test("a real record_decision call emits the decision event AND its tool pair (#107)", async () => {
  const { mkdtempInRootSync } = await import("./helpers/tmp-root.ts");
  const { Agent } = await import("../src/agent/agent.ts");
  const { readEvents } = await import("../src/log/events.ts");
  const ws = mkdtempInRootSync("dec-");
  const sd = mkdtempInRootSync("decs-");
  let n = 0;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      if (n++ === 0) {
        return {
          message: {
            role: "assistant" as const,
            content: "",
            tool_calls: [
              {
                id: "d1",
                type: "function" as const,
                function: { name: "record_decision", arguments: JSON.stringify({ decision: "use X", rationale: "because Y" }) },
              },
            ],
          },
        };
      }
      return { message: { role: "assistant" as const, content: "done" } };
    },
    autoContinue: false,
  } as never) as InstanceType<typeof Agent>;
  await a.init();
  try {
    a.enqueuePrompt("go", "user");
    a.start("t");
    await a.settled().catch(() => {});
    const events = await readEvents(a.log.filePath);
    const decisions = events.filter((e) => e.type === "decision");
    const calls = events.filter((e) => e.type === "tool_call" && (e.data as { name?: string }).name === "record_decision");
    const results = events.filter((e) => e.type === "tool_result" && (e.data as { callId?: string }).callId === "d1");
    assert.equal(calls.length, 1, "the record_decision call must be logged");
    assert.equal(decisions.length, 1, "the 📌 decision card event must be emitted");
    assert.equal(results.length, 1, "the tool_call must be answered, or its row never completes");
  } finally {
    await a.dispose().catch(() => {});
  }
});

