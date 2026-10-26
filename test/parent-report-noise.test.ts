import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import { HARNESS_ACK, PLACEHOLDER_TEXT } from "../src/agent/agent.ts";

const kept = (text: string): boolean => {
  const t = text.trim();
  if (!t) return false;
  if (PLACEHOLDER_TEXT.test(t)) return false;
  if (HARNESS_ACK.test(t)) return false;
  return true;
};

test("a '(tool call)' placeholder is not reported as content (#94)", () => {
  assert.equal(kept("(tool call)"), false, "#94");
  assert.equal(kept("x (tool call)"), true, "only a WHOLE placeholder is dropped (#94)");
});

test("EVERY parenthesised acknowledgement is dropped, not just three (#94)", () => {
  const real = [
    "(tool call)",
    "(no content)",
    "(no output)",
    "(tool_call)",            
    "(goal complete)",
    "(round ended)",
    "(round ended: finished)",
    "(tool try)",
    "(no sub-agents)",
    "(nothing running to stop)",
    "(no result recorded)",
    "(todo.md is empty — no task list yet)",
    "(decisions.md is empty — no decisions recorded yet)",
    "(skills created)",
  ];
  for (const p of real) assert.equal(kept(p), false, `#94 must drop the ack: ${p}`);
});

test("real work is never mistaken for an acknowledgement (#94)", () => {
  for (const g of [
    "All files clean, running the final verification.",
    "leds-mt6320.c newline=OK trailing-ws=0",
    "════ FINAL ════ checkpatch: 0 errors, 718 lines checked",
    "Seven rejections with no stated gap. I stopped auditing the driver.",
    "The symbol is MFD_MT6397, not MFD_MT6320 — see drivers/mfd/Kconfig:1141",
  ])
    assert.equal(kept(g), true, `#94 must keep real work: ${g.slice(0, 40)}`);
});

test("harness acknowledgements do not consume a slot (#94)", () => {
  for (const a of [
    "decision recorded to decisions.md",
    "progress recorded",
    "goal saved",
    "memory saved",
    "read_memory",
  ])
    assert.equal(kept(a), false, `#94: ${a}`);
});

test("real findings are kept (#94)", () => {
  for (const good of [
    "All files clean. Let me run the complete final verification.",
    "════ FINAL ════ checkpatch: total: 0 errors, 0 warnings, 718 lines checked",
    "leds-mt6320.c newline=OK trailing-ws=0",
    "Seven rejections with no stated gap. I stopped auditing the driver.",
  ])
    assert.equal(kept(good), true, `#94 must keep: ${good.slice(0, 40)}`);
});

test("the filters are anchored, not substring matches (#94)", () => {
  const longFinding =
    "I fixed the driver. The memory layout was wrong and I had to re-read the " +
    "datasheet twice before I understood the decision recorded in the log.";
  assert.equal(
    kept(longFinding),
    true,
    `a real finding must not be dropped for CONTAINING an ack phrase (#94): ${longFinding.slice(0, 50)}`,
  );
  assert.equal(kept("this (tool call) appears mid-sentence"), true, "only a WHOLE placeholder (#94)");
});

