/**
 * #107 — "both `decision` and `record_decision` exist on the timeline. Keep only
 * `decision`."
 *
 * One `record_decision` call produces THREE log events:
 *
 *   decision      -> rendered as the 📌 card (App.tsx `case "decision"`)
 *   tool_call     -> a meta row "called record_decision"
 *   tool_result   -> a meta row "record_decision succeeded"
 *
 * `report_progress` and `ask_user` are already excluded from the meta rows
 * because their own embeds render everything. `record_decision` was not, so the
 * operator saw the decision twice — the card, then a row that restated that the
 * tool had been called. That is the reported symptom exactly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const agent = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");

/**
 * Driven through the REAL pipeline instead of reading App.tsx for a regex.
 *
 * These used to assert that `metaToolName === "record_decision") return false;` appeared
 * in the source. Such a test cannot fail for a real reason: it pins the SPELLING of the
 * filter, so it went red when the filter moved into `frontend/timeline.ts` while the
 * behaviour — the decision showing once — was completely intact. It would equally have
 * stayed green if the filter had been left in place but made unreachable.
 */
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

/** run a list through the real pipeline with no pending messages */
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
  // the premise: one call emits a decision event AND a tool_call/tool_result pair
  const events = [
    ev("message", { role: "user", content: "pick one" }),
    ev("tool_call", { name: "record_decision", args: { decision: "use X" } }),
    ev("decision", { decision: "use X", rationale: "because Y" }),
    ev("tool_result", { name: "record_decision", ok: true, result: "recorded" }),
    ev("message", { role: "assistant", content: "done" }),
  ];
  const out = run(events);

  // PRECONDITION: the fixture really does contain the duplication that caused the bug
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
  // the SAME rule, not a special case for one tool: all three own an embed
  for (const tool of ["report_progress", "ask_user"]) {
    const events = [
      ev("tool_call", { name: tool, args: {} }),
      ev("tool_result", { name: tool, ok: true, result: "ok" }),
    ];
    const out = run(events);
    // PRECONDITION: both rows exist in the input
    assert.equal(events.length, 2);
    assert.deepEqual(out, [], `${tool}'s rows must all be dropped — its embed tells the story`);
  }
});

test("no OTHER tool was newly excluded (#107)", () => {
  // the inverse, which is what keeps the rule honest: an ordinary tool must still show.
  const events = [
    ev("tool_call", { name: "bash", args: { command: "ls" } }),
    ev("tool_result", { name: "bash", ok: true, result: "a.txt" }),
  ];
  const out = run(events);
  assert.equal(out.length, 2, `an ordinary tool must keep its rows; got ${JSON.stringify(out.map((e) => e.type))}`);
});

test("a real record_decision call emits the decision event AND its tool pair (#107)", async () => {
  // THE PREMISE, driven through a real agent rather than read off the source.
  //
  // The exclusion above is only correct while `record_decision` really does produce both a
  // `decision` event (the 📌 card) and a tool_call/tool_result pair. If that ever changed,
  // the exclusion would be dead code hiding nothing — so the premise needs its own check.
  //
  // This used to `assert.match` a 2600-char slice of agent.ts. That cannot fail for a real
  // reason: it pins the SPELLING of the handler, and it went red here merely because the
  // handler moved into the meta-tool dispatch table while the behaviour was unchanged.
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
    // PRECONDITION: the call really happened, so the assertions below are not vacuous
    assert.equal(calls.length, 1, "the record_decision call must be logged");
    assert.equal(decisions.length, 1, "the 📌 decision card event must be emitted");
    assert.equal(results.length, 1, "the tool_call must be answered, or its row never completes");
  } finally {
    await a.dispose().catch(() => {});
  }
});

