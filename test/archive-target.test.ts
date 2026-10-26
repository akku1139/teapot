import { test } from "node:test";
import assert from "node:assert/strict";
import { pickAfterArchive } from "../frontend/lib/archive-target.ts";

const a = (id: string, workspaceMissing = false) => ({ id, workspaceMissing });

test("a ghost is NEVER chosen while a usable agent remains (#archive)", () => {
  const agents = [a("gone", true), a("alive"), a("other")];
  const next = pickAfterArchive(agents, new Set(["archived-one"]));
  assert.equal(next?.id, "alive", "the first NON-ghost must win, not the first row");
});

test("the ghost is skipped even when it is the only other entry (#archive)", () => {
  const agents = [a("gone", true)];
  assert.equal(pickAfterArchive(agents, new Set(["x"]))?.id, "gone");
});

test("nothing left means null, so the caller clears the timeline (#archive)", () => {
  assert.equal(pickAfterArchive([], new Set(["only"])), null);
  assert.equal(pickAfterArchive([a("only")], new Set(["only"])), null);
});

test("the archived subtree itself is excluded (#archive)", () => {
  const agents = [a("parent"), a("child"), a("grandchild"), a("bystander")];
  const removed = new Set(["parent", "child", "grandchild"]);
  assert.equal(pickAfterArchive(agents, removed)?.id, "bystander");
});

test("order among usable agents is preserved (#archive)", () => {
  const agents = [a("beta"), a("alpha")];
  assert.equal(pickAfterArchive(agents, new Set())?.id, "beta");
});
