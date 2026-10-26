/**
 * Tool-row grouping: which adjacent tool rows form one visual block.
 *
 * ## The rule, and how it got here
 *
 * A run of the SAME tool groups — a series of bash commands reads as one block under a
 * single icon. A change of tool starts a new block, because the second tool's row would
 * otherwise hang under the first tool's output and read as part of it rather than as
 * the next action.
 *
 * This file exists because that rule was wrong in BOTH directions before, and each
 * wrong version had a test asserting it:
 *
 * - #149: every tool shared one bucket, so a `bash` after a `load_skill` panel (which
 *   renders as expanded PROSE) appeared inside the skill text.
 * - the follow-up: the fix special-cased only `load_skill`, so the same thing still
 *   happened for every other tool — "write_file 後の bash が間違ってグループ化されてる".
 *   MEASURED: `write_file -> bash` returned `grouped: true`.
 *
 * The earlier note in `actorKeyOf` claimed keying by tool name "split a run as soon as
 * two different tools ran back to back". Keying by name does not do that: two rows of
 * the SAME tool still share a key, so a homogeneous run still groups. What it prevents
 * is exactly the reported bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupedWith, type RowLike } from "../frontend/lib/row-grouping.ts";

const row = (type: string, data: Record<string, unknown> = {}): RowLike => ({
  type,
  session: "s",
  branch: "br0",
  data,
});
const call = (name: string) => row("tool_call", { name });
const result = (name: string) => row("tool_result", { name });

test("a run of the SAME tool groups under one head", () => {
  assert.equal(groupedWith(call("bash"), call("bash")), true, "bash after bash");
  assert.equal(groupedWith(call("read_file"), call("read_file")), true, "read after read");
  assert.equal(
    groupedWith(call("bash"), result("bash")),
    true,
    "a call and its own result are one visual unit",
  );
});

test("a DIFFERENT tool after a tool does NOT group", () => {
  // The reported bug: the second tool's row hung under the first's output, so it read
  // as part of that output instead of as the next action.
  assert.equal(
    groupedWith(call("write_file"), call("bash")),
    false,
    "write_file 後の bash がグループ化されていた",
  );
  assert.equal(groupedWith(call("edit_file"), call("bash")), false, "same for edit_file");
  assert.equal(groupedWith(call("read_file"), call("bash")), false, "same for read_file");
  assert.equal(groupedWith(call("bash"), call("write_file")), false, "and in the other order");
});

test("a bash row does not hang under a load_skill panel (#149)", () => {
  // load_skill renders as an EXPANDED panel of prose, so anything under it reads as
  // that prose. It now groups only with itself, which the tool-name rule already gives
  // — but the case is kept explicit because it is a reported bug with its own reason.
  assert.equal(groupedWith(call("load_skill"), call("bash")), false);
  assert.equal(groupedWith(result("load_skill"), call("bash")), false, "nor under its result");
  assert.equal(
    groupedWith(call("load_skill"), result("load_skill")),
    true,
    "the panel and its result are one unit",
  );
});

test("a pending or withdrawn message never groups", () => {
  // its cancel affordance lives in the msg-head, which only renders when not grouped
  assert.equal(
    groupedWith(row("prompt", { source: "user" }), row("prompt", { source: "user", pending: true })),
    false,
    "a queued message must keep its head so it can be withdrawn (#49)",
  );
  assert.equal(
    groupedWith(row("prompt", { source: "user" }), row("prompt", { source: "user", cancelled: true })),
    false,
    "nor may a withdrawn one group",
  );
});

test("rows from a different session or branch never group", () => {
  const a = call("bash");
  const otherSession = { ...call("bash"), session: "other" };
  const otherBranch = { ...call("bash"), branch: "br1" };
  assert.equal(groupedWith(a, otherSession as RowLike), false, "a session boundary is a real boundary");
  assert.equal(groupedWith(a, otherBranch as RowLike), false, "and so is a branch boundary");
});

test("a mirrored sub-agent row groups only with ITS OWN actor", () => {
  // a child's activity is attributed to the child, so it must not continue the parent's
  // run (that was #40: the parent's cursor appeared on a child's rows)
  const parent = call("bash");
  const kid = row("tool_call", { name: "bash", actor: "alpha-kid" });
  assert.equal(groupedWith(parent, kid), false);
  assert.equal(groupedWith(kid, row("tool_call", { name: "bash", actor: "alpha-kid" })), true);
});
