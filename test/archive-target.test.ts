/**
 * Which agent to show after archiving one (#archive).
 *
 * Reported: "archiveするとghostなセッションに移動してしまう". The handler picked
 * `rest[0]` — the first remaining row — and that can be a 👻 ghost (its workspace
 * directory is gone). Archiving is tidying up, so landing on a dead session is the
 * opposite of what the operator asked for.
 *
 * This is order-of-preference logic, which is exactly the kind of decision that is
 * invisible inside a component and trivial to get wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickAfterArchive } from "../frontend/archive-target.ts";

const a = (id: string, workspaceMissing = false) => ({ id, workspaceMissing });

test("a ghost is NEVER chosen while a usable agent remains (#archive)", () => {
  // the exact reported shape: the ghost sorts first in the list
  const agents = [a("gone", true), a("alive"), a("other")];
  const next = pickAfterArchive(agents, new Set(["archived-one"]));
  assert.equal(next?.id, "alive", "the first NON-ghost must win, not the first row");
});

test("the ghost is skipped even when it is the only other entry (#archive)", () => {
  // nothing usable left → a ghost is still better than a blank screen, but it must be
  // chosen deliberately rather than by accident of ordering
  const agents = [a("gone", true)];
  assert.equal(pickAfterArchive(agents, new Set(["x"]))?.id, "gone");
});

test("nothing left means null, so the caller clears the timeline (#archive)", () => {
  assert.equal(pickAfterArchive([], new Set(["only"])), null);
  assert.equal(pickAfterArchive([a("only")], new Set(["only"])), null);
});

test("the archived subtree itself is excluded (#archive)", () => {
  // archiving a parent takes its children; none of them may be selected afterwards
  const agents = [a("parent"), a("child"), a("grandchild"), a("bystander")];
  const removed = new Set(["parent", "child", "grandchild"]);
  assert.equal(pickAfterArchive(agents, removed)?.id, "bystander");
});

test("order among usable agents is preserved (#archive)", () => {
  // the picker must not reorder the list — the operator's own ordering decides
  const agents = [a("beta"), a("alpha")];
  assert.equal(pickAfterArchive(agents, new Set())?.id, "beta");
});
