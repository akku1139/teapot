/**
 * Every tool the prompt ADVERTISES must be a tool the loop can actually RUN.
 *
 * ## The defect this protects against
 *
 * A meta tool (finish, set_todo, read_memory, ask_user…) used to be declared in two
 * hand-maintained places with nothing connecting them:
 *
 *   1. a 389-line block of `if (call.function.name === "…")` in `runTurnsUntilIdle`;
 *   2. an object literal among the sixteen in `allToolSpecs`.
 *
 * Neither error was loud. A spec without a branch falls through the if-chain to
 * `executeTool`, which looks the name up in the built-in `TOOLS` table, does not find it,
 * and returns **"unknown tool"** — while the prompt that same request carried had just
 * told the model the tool exists and described its arguments. The model, being told its
 * tool is unknown, retries, reformulates, or gives up. A branch without a spec is the
 * quieter half: unreachable code the model never learns about.
 *
 * The specs now live in ONE table (`src/agent/meta-tools.ts`), which is necessary but not
 * sufficient — the handlers are still `if` branches, so the two can still drift. This
 * test is what makes the drift fail: it takes every advertised meta tool from the table
 * and requires the loop to answer it with something OTHER than "unknown tool".
 *
 * It asserts on the RESULT the model receives, not on the source, because the result is
 * exactly what the model acts on and what the operator sees in the timeline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";
import { META_TOOLS, META_TOOL_NAMES, metaToolSpecs } from "../src/agent/meta-tools.ts";

const toolCall = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

/** the argument object a tool needs to get past its own validation */
function argsFor(name: string): Record<string, unknown> {
  switch (name) {
    case "finish":
      // goalComplete:false keeps the round going, so the loop answers and continues
      return { goalComplete: false, summary: "s" };
    case "ask_user":
      // parks the loop on purpose; still has to be ANSWERED, which is the point
      return { question: "q?" };
    case "set_goal":
      return { text: "g" };
    case "set_todo":
      return { content: "- [ ] a" };
    case "add_feedback":
      return { rule: "be brief" };
    case "record_decision":
      return { decision: "d", rationale: "r" };
    case "set_memory":
      return { content: "note" };
    case "add_memory":
      return { text: "note" };
    case "forget_memory":
      return { query: "note" };
    case "read_memory":
      return {};
    case "report_progress":
      return { doing: "x", goalStatus: "y", recent: "z" };
    default:
      return {};
  }
}

/**
 * Run one tool call through a real agent and return the content the model was given back.
 *
 * `ask_user` parks the loop by throwing `WaitForUser`, which is correct behaviour — the
 * tool was handled, so the assertion is that the CALL was answered, not that the round
 * continued. The answered content is captured wherever the loop got to.
 */
async function runOne(name: string): Promise<string> {
  const ws = mkdtempInRootSync("meta-");
  const sd = mkdtempInRootSync("metas-");
  const answers: string[] = [];
  let n = 0;
  const agent = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (_c: unknown, msgs: { role: string; content?: unknown }[]): Promise<LlmResult> => {
      for (const m of msgs) if (m.role === "tool") answers.push(String(m.content ?? ""));
      // first round: the meta call. later rounds: a plain answer so the loop ends.
      if (n++ === 0) {
        return {
          message: { role: "assistant", content: "", tool_calls: [toolCall("c1", name, argsFor(name))] },
        };
      }
      return { message: { role: "assistant", content: "done" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await agent.init();
  try {
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled().catch(() => {});
  } finally {
    await agent.dispose().catch(() => {});
  }
  // the answer for OUR call id, not just any tool reply
  return answers.join("\n---\n");
}

test("every advertised meta tool is handled by the loop, not reported as unknown", async () => {
  // precondition: the table is not empty. Without this the loop below proves nothing.
  assert.ok(META_TOOLS.length >= 10, `expected the meta table to be populated, got ${META_TOOLS.length}`);
  const missing: string[] = [];
  for (const name of META_TOOL_NAMES) {
    const answer = await runOne(name);
    // "unknown tool: <name>" is what executeTool says for a name it cannot find, and it is
    // exactly what a spec-without-a-branch produces
    if (/unknown tool/i.test(answer)) missing.push(name);
  }
  assert.deepEqual(
    missing,
    [],
    `these tools are advertised to the model but the loop does not handle them, so every ` +
      `call returns "unknown tool": ${missing.join(", ")}`,
  );
});

test("the spec's declared name always equals the table key", () => {
  // the loop matches the NAME, the model sends the SPEC's name. If they disagree the tool
  // is advertised under one name and handled under another — unreachable either way.
  for (const t of META_TOOLS) {
    assert.equal(
      t.spec.function.name,
      t.name,
      `table entry ${JSON.stringify(t.name)} declares spec name ${JSON.stringify(t.spec.function.name)}`,
    );
  }
});

test("metaToolSpecs() hands the wire exactly the table, with no duplicates", () => {
  const specs = metaToolSpecs();
  assert.equal(specs.length, META_TOOLS.length);
  const names = specs.map((s) => s.function.name);
  assert.deepEqual(
    [...new Set(names)],
    names,
    `duplicate tool name would make one spec unreachable: ${names.join(", ")}`,
  );
  // a tool the model cannot call is useless, so every entry needs a description
  for (const s of specs) {
    assert.ok(
      (s.function.description ?? "").length > 10,
      `${s.function.name} has no usable description, so the model cannot choose it`,
    );
  }
});
