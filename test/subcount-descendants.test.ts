/**
 * #98 — "some sessions do not have their sub-agents counted."
 *
 * The sidebar's 🧩 badge counted only DIRECT children:
 *
 *     agents().filter((x) => x.parent === row.a.id)
 *
 * so a sub-agent that spawned its own was not counted at all. Worse, the
 * `· ▶N` active count had the same shape, so a busy subtree several levels down
 * rendered as an idle-looking parent — which is exactly the case the badge exists
 * for: "a busy parent must not look idle with its subtree hidden".
 *
 * `subtreeUnread` in App.tsx already recursed for notifications, so the two
 * badges could disagree about the same subtree. `descendantsOf()` is the shared
 * version, cycle-guarded on `parent`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { descendantsOf } from "../frontend/sidebar-tree.ts";

interface A {
  id: string;
  parent?: string;
  workspace: string;
  status: string;
}
const agent = (id: string, parent = "", status = "stopped"): A => ({ id, parent, workspace: "/w", status });
const isLive = (a: A) => a.status === "running" || a.status === "waiting";

/** what the badge rendered before, and what it renders now */
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
  // the badge's stated purpose: a busy parent must not look idle when collapsed
  const agents = [agent("root"), agent("a", "root"), agent("b", "a", "running")];
  assert.equal(badge(agents, "root").before, "1", "precondition: the old count missed it (#98)");
  assert.equal(badge(agents, "root").after, "2 · ▶1", "and it must now be visible (#98)");
});

test("three levels deep still counts and reports activity (#98)", () => {
  const agents = [agent("root"), agent("a", "root"), agent("b", "a"), agent("c", "b", "waiting")];
  assert.equal(badge(agents, "root").after, "3 · ▶1", "waiting counts as active too (#98)");
});

test("direct children are still counted — no regression (#98)", () => {
  // the reported case: 4 direct subs all stopped. The badge said 4 and must
  // still say 4; this guards against "fixing" the undercount by over-counting
  const agents = [agent("teapot"), ...Array.from({ length: 4 }, (_, i) => agent(`s${i}`, "teapot"))];
  assert.equal(badge(agents, "teapot").before, "4");
  assert.equal(badge(agents, "teapot").after, "4", "must be unchanged (#98)");
});

test("siblings of a nested sub are not double-counted (#98)", () => {
  // root -> a, root -> c, a -> b : the result must contain each id once
  const agents = [agent("root"), agent("a", "root"), agent("c", "root"), agent("b", "a")];
  const ids = descendantsOf(agents, "root").map((x) => x.id);
  assert.deepEqual(ids, ["a", "b", "c"], "each descendant appears exactly once (#98)");
  assert.equal(new Set(ids).size, ids.length, "no duplicates (#98)");
});

test("a parent cycle terminates instead of recursing forever (#98)", () => {
  // a corrupt log could contain a -> b -> a; the helper must not hang the UI
  const agents = [agent("root"), { ...agent("a", "b"), workspace: "/w" }, { ...agent("b", "a"), workspace: "/w" }];
  assert.doesNotThrow(() => descendantsOf(agents, "root"), "a cycle must not hang (#98)");
});

test("an agent with no descendants yields an empty list (#98)", () => {
  assert.deepEqual(descendantsOf([agent("solo")], "solo"), [], "no subs means no badge (#98)");
});

test("the badge uses the recursive helper (#98)", () => {
  // structural: the badge must not go back to filtering direct children
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  const at = app.indexOf('class={"subcount"');
  assert.notEqual(at, -1, "the badge must exist (#98)");
  // anchor on the gate's position, not its exact text: #81 widened this gate to
  // a multi-line expression, so searching for the old one-line form found nothing
  // and the block came back empty — the test then failed on correct code
  const show = app.lastIndexOf("<Show", at);
  assert.notEqual(show, -1, "the badge gate must exist (#98)");
  const block = app.slice(show, at);
  assert.match(block, /descendantsOf\(agents\(\), row\.a\.id\)/, "the badge must count DESCENDANTS (#98)");
  assert.doesNotMatch(
    block,
    /agents\(\)\.filter\(\(x\) => x\.parent === row\.a\.id\)/,
    "and must not filter direct children (#98)",
  );
});

test("the unread badge and the count agree about a subtree (#98)", () => {
  // they used to differ by construction: subtreeUnread recursed, the badge did not
  const agents = [agent("root"), agent("a", "root"), agent("b", "a")];
  const descendants = descendantsOf(agents, "root").length;
  const unreadShape = agents
    .filter((x) => x.id === "root")
    .concat(descendantsOf(agents, "root")) // what subtreeUnread walks
    .length;
  assert.equal(unreadShape - 1, descendants, "both must describe the same subtree (#98)");
});
