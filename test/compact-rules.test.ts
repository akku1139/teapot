import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRules, enforceRules, renderRules, RULES_HEADING } from "../src/agent/compact-rules.ts";

const SUMMARY = (rules: string) => `## Primary request and intent
do the thing

${RULES_HEADING}
${rules}

## Pending tasks
- one
`;

test("every level is extracted, including SHOULD (#compact)", () => {
  const rules = extractRules(
    SUMMARY(`- MUST NOT install teapot into Wine
- MUST commit as the configured identity only
- SHOULD prefer edit_file over scripts`),
  );
  assert.deepEqual(
    rules.map((r) => r.level),
    ["MUST NOT", "MUST", "SHOULD"],
    "all three levels, and MUST NOT must not parse as MUST",
  );
  assert.equal(rules[0]!.text, "install teapot into Wine");
});

test("a bullet is optional — a bare keyword line still counts (#compact)", () => {
  const rules = extractRules(SUMMARY("MUST NOT do the bad thing"));
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.level, "MUST NOT");
});

test("prose inside the section is IGNORED, never promoted to a rule (#compact)", () => {
  const rules = extractRules(SUMMARY("- be careful here\n- MUST do the thing"));
  assert.deepEqual(rules.map((r) => r.text), ["do the thing"]);
});

test("the section ENDS at the next heading (#compact)", () => {
  const summary = `${RULES_HEADING}
- MUST keep me

## Pending tasks
- MUST NOT this is a task, not a rule
`;
  assert.deepEqual(extractRules(summary).map((r) => r.text), ["keep me"]);
});

test("a rule a later pass DROPS is put back (#compact)", () => {
  const before = extractRules(
    SUMMARY(`- MUST NOT install teapot into Wine
- MUST commit as the configured identity only`),
  );
  const after = SUMMARY(`- MUST commit as the configured identity only
- MUST NOT force-push a release tag`);

  const { summary, restored } = enforceRules(after, before);
  assert.deepEqual(restored.map((r) => r.text), ["install teapot into Wine"], "the dropped one is detected");

  const merged = extractRules(summary);
  assert.equal(merged.length, 3, "old + new rules all present");
  assert.ok(merged.some((r) => r.text.includes("Wine")), "the dropped rule is back in the text");
  assert.ok(merged.some((r) => r.text.includes("force-push")), "and the new one was kept");
});

test("a rule whose meaning is unchanged is not duplicated (#compact)", () => {
  const before = extractRules(SUMMARY("- MUST NOT install teapot into Wine."));
  const after = SUMMARY("- MUST NOT install teapot into Wine");
  const { restored } = enforceRules(after, before);
  assert.equal(restored.length, 0, "a reworded rule must not be restored as a duplicate");
});

test("enforcing TWICE is a no-op — compaction runs repeatedly (#compact)", () => {
  const before = extractRules(SUMMARY("- MUST NOT install teapot into Wine"));
  const once = enforceRules(SUMMARY("- SHOULD be nice"), before).summary;
  const twice = enforceRules(once, extractRules(once)).summary;
  assert.equal(twice.trim(), once.trim(), "a second pass must not change anything");
});

test("a summary with NO section gets one, rather than losing the rules (#compact)", () => {
  const before = extractRules(SUMMARY("- MUST NOT install teapot into Wine"));
  const { summary, restored } = enforceRules("## Primary request and intent\ndo the thing", before);
  assert.equal(restored.length, 1);
  assert.match(summary, /Hard constraints/);
  assert.match(summary, /MUST NOT install teapot into Wine/);
});

test("rules render strongest-first, so a squeeze drops SHOULD first (#compact)", () => {
  const rendered = renderRules([
    { level: "SHOULD", text: "prefer small edits", line: "" },
    { level: "MUST NOT", text: "push --force", line: "" },
    { level: "MUST", text: "run the gate", line: "" },
  ]);
  const order = rendered.split("\n").map((l) => l.replace(/^- /, "").split(" ")[0] === "MUST" && l.includes("NOT") ? "MUST NOT" : l.replace(/^- /, "").split(" ")[0]);
  assert.deepEqual(order, ["MUST NOT", "MUST", "SHOULD"]);
});

test("an empty rule set renders NO section body, not a placeholder (#compact)", () => {
  assert.equal(renderRules([]), "");
  const { summary } = enforceRules("## Primary request\nx", []);
  assert.doesNotMatch(summary, /Hard constraints\n\n- /, "no empty bullet list");
});

test("a pass that drops EVERY rule still cannot lose them (#compact)", () => {
  const known = extractRules(
    SUMMARY(`- MUST NOT install teapot into Wine
- SHOULD prefer edit_file over scripts`),
  );
  const wiped = "## Primary request and intent\ndo the thing\n";
  const { summary, restored } = enforceRules(wiped, known);
  assert.equal(restored.length, 2, "both are detected as missing");
  const after = extractRules(summary);
  assert.deepEqual(
    after.map((r) => r.text).sort(),
    ["install teapot into Wine", "prefer edit_file over scripts"].sort(),
  );

  const again = enforceRules("## Primary request\nx\n", extractRules(summary));
  assert.equal(extractRules(again.summary).length, 2, "the set is still intact a pass later");
});

test("a pass may ADD a rule and nothing removes it later (#compact)", () => {
  const known = extractRules(SUMMARY("- MUST run the gate before saying done"));
  const added = enforceRules(
    SUMMARY(`- MUST run the gate before saying done
- MUST NOT force-push a release tag`),
    known,
  );
  assert.equal(added.restored.length, 0, "nothing was lost");
  const after = extractRules(added.summary);
  assert.equal(after.length, 2, "the new rule is part of the set from now on");
});
