/**
 * #121 — "a sub-agent's `title` attribute should be the sub-agent's display
 * name."
 *
 * Reported DOM:
 *
 *   <div class="agent-item sub-row" title="sub-agent of @tyb2-6">
 *     ...<span>tyb2-6-sub-mt6628_reg</span>
 *
 * The tooltip names the PARENT, which is already visible in the row above, and
 * says nothing about what the sub-agent is. The operator's chosen name — the
 * whole point of `spawn_agent({name})` — was only recoverable by reading the id.
 *
 * ## Why the id is parsed rather than a field being added
 *
 * The name is not stored. `spawnChildFor` builds the id as
 * `<parent>-sub[-<persona>]-<name>` (master.ts `spawnChildFor`), so that is
 * where it lives.
 *
 * The persona list is passed IN rather than duplicated: the frontend already
 * loads it from `/api/personas`, and a copied list would mis-parse every
 * persona-spawned id the day a persona was added.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// #126: normalises CRLF so source anchors behave the same on Windows
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
  // spawnChildFor replaces every char outside [\\w.-] with "_", so showing them
  // verbatim leaks the mangling rather than the name the operator typed
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
  // without the persona list, "reviewer" here is a NAME the operator chose
  assert.equal(subAgentDisplayName("x-sub-reviewer-code", []), "reviewer-code");
});

test("ids with no sub-agent suffix yield null (#121)", () => {
  for (const id of ["plain-agent", "x-sub", "x-sub-", ""]) {
    assert.equal(subAgentDisplayName(id, PERSONAS), null, `${JSON.stringify(id)} has no name (#121)`);
  }
});

