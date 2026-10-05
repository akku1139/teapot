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
import { readFileSync } from "node:fs";
// #126: normalises CRLF so source anchors behave the same on Windows
import { readSource } from "./helpers/source.ts";
import { subAgentDisplayName } from "../frontend/sidebar-tree.ts";

const app = readSource(new URL("../frontend/App.tsx", import.meta.url));
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

test("the sidebar tooltip names the sub-agent (#121)", () => {
  const at = app.indexOf("subAgentDisplayName(row.a.id");
  assert.notEqual(at, -1, "the tooltip must use the helper (#121)");
  const block = app.slice(Math.max(0, at - 260), at + 200);
  assert.match(
    block,
    /sub-agent of @\$\{row\.a\.parent\} — "\$\{named\}"/,
    "the parent stays, and the name is added (#121)",
  );
});

test("the persona list is passed in, not hard-coded (#121)", () => {
  // a stale copy in sidebar-tree.ts would mis-parse every persona-spawned id
  // the day a persona is added
  const tree = readSource(new URL("../frontend/sidebar-tree.ts", import.meta.url));
  const fn = tree.slice(tree.indexOf("export function subAgentDisplayName"));
  assert.match(fn, /personas: readonly string\[\] = \[\]/, "the list must be a parameter (#121)");
  assert.doesNotMatch(
    tree.slice(0, tree.indexOf("export function subAgentDisplayName")),
    /reviewer[\s\S]{0,40}tester[\s\S]{0,40}researcher/,
    "and must NOT be duplicated in this module (#121)",
  );
});

test("a top-level chat still has no tooltip (#121)", () => {
  // unchanged: only a sub-agent row gets one
  // `row.a.parent` and the helper call are ~6 lines apart, so an 80-char window
  // found nothing — anchor on the ternary instead.
  //
  // #126: this then searched for a literal "title={\n", which git checks out as
  // CRLF on Windows, so the test failed there while passing on Linux — the THIRD
  // time this shape has broken a test. Never anchor on whitespace between source
  // tokens; anchor on the token itself.
  const at = app.indexOf("row.a.parent\n");
  const gate = at === -1 ? app.indexOf("row.a.parent") : at;
  assert.notEqual(gate, -1, "the tooltip must still be gated on having a parent (#121)");
  const block = app.slice(gate, gate + 700);
  assert.match(block, /: undefined/, "a top-level chat gets NO tooltip (#121)");
  assert.match(block, /: `sub-agent of @\$\{row\.a\.parent\}`;/, "the old wording is the fallback (#121)");
});