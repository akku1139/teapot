/**
 * #149 — "the bash after `load_skill` hangs under `load_skill`".
 *
 * Grouping keys tool rows by the AGENT (`"agent-tools"`), deliberately: keying by
 * tool NAME split a run as soon as two different tools ran back to back. That rule
 * is right for homogeneous tool work and wrong for a row that is not really a tool
 * — `load_skill` renders as an EXPANDED panel of prose (the skill body), so a
 * following `bash` row appearing under it reads as part of the skill text rather
 * than as the next action.
 *
 * The fix keeps the agent-wide key for ordinary tools and treats a skill load as
 * its own row: it groups with its own RESULT (still one visual unit) but not with
 * an ordinary tool row after it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupedWith, type RowLike } from "../frontend/row-grouping.ts";

const row = (type: string, data: Record<string, unknown> = {}): RowLike => ({
  type,
  session: "s",
  branch: "br0",
  data,
});

test("a bash row does NOT hang under a load_skill panel (#149)", () => {
  const loadCall = row("tool_call", { name: "load_skill" });
  const bashCall = row("tool_call", { name: "bash" });
  assert.equal(
    groupedWith(loadCall, bashCall),
    false,
    "the reported symptom: bash rendered inside the skill's expanded block (#149)",
  );
});

test("a bash row does not hang under a load_skill RESULT either (#149)", () => {
  // the result row is what actually precedes the next call in the log
  const loadResult = row("tool_result", { name: "load_skill" });
  const bashCall = row("tool_call", { name: "bash" });
  assert.equal(groupedWith(loadResult, bashCall), false, "same for the result row (#149)");
});

test("consecutive bash rows STILL group — the ordinary case must not regress", () => {
  // keying tool rows by tool NAME was tried before and split a run whenever two
  // different tools ran back to back, so the agent-wide key is deliberate
  assert.equal(groupedWith(row("tool_call", { name: "bash" }), row("tool_call", { name: "bash" })), true);
  assert.equal(
    groupedWith(row("tool_call", { name: "bash" }), row("tool_result", { name: "bash" })),
    true,
    "a call and its result are one unit",
  );
  assert.equal(
    groupedWith(row("tool_call", { name: "read_file" }), row("tool_call", { name: "bash" })),
    true,
    "and two DIFFERENT ordinary tools still group — that was the reason for the agent-wide key",
  );
});

test("a skill load groups with its own call/result pair (#149)", () => {
  assert.equal(
    groupedWith(row("tool_call", { name: "load_skill" }), row("tool_result", { name: "load_skill" })),
    true,
    "the panel and its result are one visual unit",
  );
});
