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

function argsFor(name: string): Record<string, unknown> {
  switch (name) {
    case "finish":
      return { goalComplete: false, summary: "s" };
    case "ask_user":
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
  return answers.join("\n---\n");
}

test("every advertised meta tool is handled by the loop, not reported as unknown", async () => {
  assert.ok(META_TOOLS.length >= 10, `expected the meta table to be populated, got ${META_TOOLS.length}`);
  const missing: string[] = [];
  for (const name of META_TOOL_NAMES) {
    const answer = await runOne(name);
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
  for (const s of specs) {
    assert.ok(
      (s.function.description ?? "").length > 10,
      `${s.function.name} has no usable description, so the model cannot choose it`,
    );
  }
});

test("the node-count rejection is NOT treated as a context overflow (#nodecap)", async () => {
  const { isContextOverflow, isRequestNodeLimit } = await import("../src/agent/tools.ts");
  const err = new Error(
    'LLM API error 400: {"message":"Invalid request JSON: JSON node count cannot exceed 32768 trace_id: a617"}',
  );
  assert.equal(
    isContextOverflow(err),
    false,
    "a structural node cap must NOT trigger compaction — the retry would cost a full summarisation " +
      "and be refused identically (#nodecap)",
  );
  const cap = isRequestNodeLimit(err);
  assert.equal(cap.hit, true, "it must be recognised so the operator gets actionable advice");
  assert.equal(cap.limit, 32768, "and the gateway's own number is quoted back");
  assert.equal(isRequestNodeLimit(new Error("context length exceeded")).hit, false);
  assert.equal(isContextOverflow(new Error("context length exceeded")), true);
});
