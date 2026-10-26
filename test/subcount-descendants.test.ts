import { test } from "node:test";
import assert from "node:assert/strict";
import { descendantsOf } from "../frontend/lib/sidebar-tree.ts";

interface A {
  id: string;
  parent?: string;
  workspace: string;
  status: string;
}
const agent = (id: string, parent = "", status = "stopped"): A => ({ id, parent, workspace: "/w", status });
const isLive = (a: A) => a.status === "running" || a.status === "waiting";

function badge(agents: A[], root: string) {
  const direct = agents.filter((x) => x.parent === root);
  const all = descendantsOf(agents, root);
  const fmt = (k: A[]) => `${k.length}${k.filter(isLive).length ? ` · ▶${k.filter(isLive).length}` : ""}`;
  return { before: fmt(direct), after: fmt(all) };
}

test("descendants are counted at every depth (#98)", () => {
  const agents = [agent("root"), agent("a", "root"), agent("b", "a")];
  assert.deepEqual(
    descendantsOf(agents, "root").map((x) => x.id),
    ["a", "b"],
    "a nested sub-agent must be counted (#98)",
  );
});

test("a running NESTED sub-agent shows as active (#98)", () => {
  const agents = [agent("root"), agent("a", "root"), agent("b", "a", "running")];
  assert.equal(badge(agents, "root").before, "1", "precondition: the old count missed it (#98)");
  assert.equal(badge(agents, "root").after, "2 · ▶1", "and it must now be visible (#98)");
});

test("three levels deep still counts and reports activity (#98)", () => {
  const agents = [agent("root"), agent("a", "root"), agent("b", "a"), agent("c", "b", "waiting")];
  assert.equal(badge(agents, "root").after, "3 · ▶1", "waiting counts as active too (#98)");
});

test("direct children are still counted — no regression (#98)", () => {
  const agents = [agent("teapot"), ...Array.from({ length: 4 }, (_, i) => agent(`s${i}`, "teapot"))];
  assert.equal(badge(agents, "teapot").before, "4");
  assert.equal(badge(agents, "teapot").after, "4", "must be unchanged (#98)");
});

test("siblings of a nested sub are not double-counted (#98)", () => {
  const agents = [agent("root"), agent("a", "root"), agent("c", "root"), agent("b", "a")];
  const ids = descendantsOf(agents, "root").map((x) => x.id);
  assert.deepEqual(ids, ["a", "b", "c"], "each descendant appears exactly once (#98)");
  assert.equal(new Set(ids).size, ids.length, "no duplicates (#98)");
});

test("a parent cycle terminates instead of recursing forever (#98)", () => {
  const agents = [agent("root"), { ...agent("a", "b"), workspace: "/w" }, { ...agent("b", "a"), workspace: "/w" }];
  assert.doesNotThrow(() => descendantsOf(agents, "root"), "a cycle must not hang (#98)");
});

test("an agent with no descendants yields an empty list (#98)", () => {
  assert.deepEqual(descendantsOf([agent("solo")], "solo"), [], "no subs means no badge (#98)");
});

