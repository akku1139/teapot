import { test } from "node:test";
import assert from "node:assert/strict";
import { subAgentDisplayName } from "../frontend/lib/sidebar-tree.ts";

const PERSONAS = ["reviewer", "tester", "researcher", "implementer"];

test("the reported id yields its name (#121)", () => {
  assert.equal(
    subAgentDisplayName("tyb2-6-sub-mt6628_reg", PERSONAS),
    "mt6628 reg",
    "the reported case (#121)",
  );
});

test("underscores are the spawn-time mangling and become spaces (#121)", () => {
  assert.equal(subAgentDisplayName("x-sub-my_task_name", PERSONAS), "my task name");
});

test("a persona segment is stripped when a name follows (#121)", () => {
  assert.equal(
    subAgentDisplayName("x-sub-reviewer-code", PERSONAS),
    "code",
    "`<parent>-sub-<persona>-<name>` (#121)",
  );
});

test("a bare persona has no operator name, so nothing is invented (#121)", () => {
  assert.equal(
    subAgentDisplayName("x-sub-reviewer", PERSONAS),
    null,
    "there is no name to show — the caller falls back rather than showing the persona (#121)",
  );
});

test("a segment that merely looks like a persona is kept (#121)", () => {
  assert.equal(subAgentDisplayName("x-sub-reviewer-code", []), "reviewer-code");
});

test("ids with no sub-agent suffix yield null (#121)", () => {
  for (const id of ["plain-agent", "x-sub", "x-sub-", ""]) {
    assert.equal(subAgentDisplayName(id, PERSONAS), null, `${JSON.stringify(id)} has no name (#121)`);
  }
});

