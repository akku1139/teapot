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
  assert.equal(groupedWith(call("load_skill"), call("bash")), false);
  assert.equal(groupedWith(result("load_skill"), call("bash")), false, "nor under its result");
  assert.equal(
    groupedWith(call("load_skill"), result("load_skill")),
    true,
    "the panel and its result are one unit",
  );
});

test("a pending or withdrawn message never groups", () => {
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
  const parent = call("bash");
  const kid = row("tool_call", { name: "bash", actor: "alpha-kid" });
  assert.equal(groupedWith(parent, kid), false);
  assert.equal(groupedWith(kid, row("tool_call", { name: "bash", actor: "alpha-kid" })), true);
});
