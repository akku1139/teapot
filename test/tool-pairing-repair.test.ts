import { test } from "node:test";
import assert from "node:assert/strict";
import { repairToolPairing, type ChatMessage } from "../src/agent/llm.ts";

const user = (c: string): ChatMessage => ({ role: "user", content: c });
const call = (id: string, content = ""): ChatMessage => ({
  role: "assistant",
  content,
  tool_calls: [{ id, type: "function", function: { name: "bash", arguments: "{}" } }],
});
const result = (id: string, c = "out"): ChatMessage => ({ role: "tool", tool_call_id: id, content: c });

function pairingErrors(msgs: ChatMessage[]): string[] {
  const calls = new Set<string>();
  for (const m of msgs) for (const t of m.tool_calls ?? []) if (t.id) calls.add(t.id);
  const answered = new Set<string>();
  for (const m of msgs) if (m.role === "tool" && m.tool_call_id) answered.add(m.tool_call_id);
  const errs: string[] = [];
  for (const m of msgs) {
    if (m.role === "tool" && !calls.has(m.tool_call_id!)) errs.push(`orphan result ${m.tool_call_id}`);
    for (const t of m.tool_calls ?? []) if (!answered.has(t.id)) errs.push(`unanswered call ${t.id}`);
  }
  if (msgs[0]?.role === "tool") errs.push("starts with a tool result");
  const answers = msgs.filter((m) => m.role === "tool" && m.tool_call_id).map((m) => m.tool_call_id!);
  if (new Set(answers).size !== answers.length) errs.push("duplicate tool result");
  const issued = new Set<string>();
  for (const m of msgs) {
    if (m.role === "tool" && m.tool_call_id && !issued.has(m.tool_call_id)) errs.push("result before its call");
    for (const t of m.tool_calls ?? []) if (t.id) issued.add(t.id);
  }
  return errs;
}

test("an orphan tool RESULT is dropped — it cannot be attributed to anything (#152)", () => {
  const fixed = repairToolPairing([user("go"), result("gone", "orphaned output")]);
  assert.deepEqual(pairingErrors(fixed), [], `must be sendable: ${JSON.stringify(fixed)}`);
  assert.ok(
    !fixed.some((m) => m.role === "tool" && m.tool_call_id === "gone"),
    "a result whose call is absent has no id to reconstruct, so it is dropped (#152)",
  );
  assert.ok(fixed.some((m) => m.content === "go"), "and everything else survives");
});

test("an UNANSWERED call gets a placeholder result, so the exchange survives (#152)", () => {
  const fixed = repairToolPairing([user("go"), call("c1"), result("c1", "ok"), call("c2")]);
  assert.deepEqual(pairingErrors(fixed), []);
  const synth = fixed.find((m) => m.role === "tool" && m.tool_call_id === "c2");
  assert.ok(synth, "the missing result must be supplied, not silently dropped — the CALL is real");
  assert.match(String(synth!.content), /not completed/, "and must say it never ran");
});

test("a kept tail starting on a tool result is trimmed (#152)", () => {
  const fixed = repairToolPairing([result("gone", "orphan"), user("go"), call("c1"), result("c1")]);
  assert.deepEqual(pairingErrors(fixed), []);
  assert.notEqual(fixed[0]?.role, "tool", `must not start with a tool result (#152): ${JSON.stringify(fixed)}`);
});

test("a valid history is returned UNCHANGED — no reallocation, prefix intact (#152)", () => {
  const good: ChatMessage[] = [user("go"), call("c1"), result("c1"), { role: "assistant", content: "done" }];
  assert.equal(repairToolPairing(good), good, "the same array object, not a copy");
});

test("a multi-call batch answered ONE SHORT is repaired (#152)", () => {
  const two: ChatMessage = {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "a", type: "function", function: { name: "bash", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "bash", arguments: "{}" } },
    ],
  };
  const fixed = repairToolPairing([user("go"), two, result("a")]);
  assert.deepEqual(pairingErrors(fixed), []);
  assert.ok(fixed.some((m) => m.role === "tool" && m.tool_call_id === "b"), "the unanswered one is filled");
});

test("an empty history, and one with no tool calls at all, pass through (#152)", () => {
  assert.deepEqual(repairToolPairing([]), []);
  const plain: ChatMessage[] = [user("hi"), { role: "assistant", content: "hello" }];
  assert.equal(repairToolPairing(plain), plain);
});

test("a SECOND answer to one call is dropped (#152)", () => {
  const fixed = repairToolPairing([user("go"), call("c1"), result("c1", "first"), result("c1", "second")]);
  assert.deepEqual(pairingErrors(fixed), []);
  const answers = fixed.filter((m) => m.role === "tool" && m.tool_call_id === "c1");
  assert.equal(answers.length, 1, `exactly one answer must survive (#152): ${JSON.stringify(fixed)}`);
  assert.equal(answers[0]!.content, "first", "and it must be the first, not the last");
});

test("a result placed BEFORE its call is repaired (#152)", () => {
  const fixed = repairToolPairing([user("go"), result("c1", "out"), call("c1")]);
  assert.deepEqual(pairingErrors(fixed), []);
  const idx = (pred: (m: ChatMessage) => boolean) => fixed.findIndex(pred);
  assert.ok(
    idx((m) => (m.tool_calls ?? []).some((t) => t.id === "c1")) <
      idx((m) => m.role === "tool" && m.tool_call_id === "c1"),
    `the call must PRECEDE its result (#152): ${JSON.stringify(fixed)}`,
  );
});
