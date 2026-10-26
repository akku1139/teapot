import { test } from "node:test";
import assert from "node:assert/strict";
import { auditPrompt, parseAuditVerdict } from "../src/agent/goal-audit.ts";

/**
 * The completion audit's verdict, and the shape of the call that produces it.
 *
 * MEASURED in github-bug-research-1f48715f — three audits in six minutes, none of which produced a
 * verdict, ending at the unavailable cap with the goal abandoned:
 *
 *   12:23:45  audit-failed  "<||DSML||> calls>\n<||DSML||> invoke name="   ← raw tool-call markup
 *   12:26:37  audit-failed  (same)
 *   12:29:54  audit-failed  "Independent verification against the thr…"    ← prose, no verdict
 *
 * The auditor had been given the worker's entire ~220k-token conversation and told to switch roles,
 * so it continued the work instead of judging it; and the verdict reader tested
 * `/^(APPROVED|CHANGES-REQUIRED)\b/i` against the WHOLE reply, so any leading prose hid a real one.
 */
test("the verdict is the LAST line, not any line (#audit)", () => {
  // the reason may wrap; the marker is last
  const v = parseAuditVerdict("I checked the tests and the report.\nAPPROVED: both are present and current");
  assert.equal(v.kind, "approved");
  assert.equal(v.reason, "both are present and current");
});

test("a prose MENTION of the marker is not a verdict (#audit)", () => {
  /**
   * The reason upstream made this strict: "I would only APPROVED if the tests passed" contains the
   * token but is a rejection. Anchoring to the last line is what separates a verdict from prose.
   */
  for (const reply of [
    "I would only approve if the tests passed, and they do not.",
    "APPROVED is what I would say if the report existed. It does not.",
    "The tests pass. Blah blah APPROVED: earlier",
  ]) {
    const v = parseAuditVerdict(reply);
    assert.equal(v.kind, "none", `must not read a verdict out of prose: ${reply}`);
  }
});

test("the real failure reply yields no verdict, and says why (#audit)", () => {
  const v = parseAuditVerdict("Independent verification against the three blockers shows that the report…");
  assert.equal(
    v.kind,
    "none",
    "prose with no marker must be NO VERDICT — treating it as a rejection tells the worker to fix " +
      "gaps nobody named (#audit)",
  );
  assert.match((v as { detail: string }).detail, /no verdict/);
});

test("provider tool-call markup yields no verdict (#audit)", () => {
  const v = parseAuditVerdict('<||DSML||> calls>\n<||DSML||> invoke name="read_file">');
  assert.equal(v.kind, "none", "leaked tool markup is not a verdict (#audit)");
});

test("a marker with no reason still yields the verdict (#audit)", () => {
  // an empty reason is honest; the caller renders a label-only card rather than inventing text
  assert.equal(parseAuditVerdict("CHANGES-REQUIRED").kind, "changes-required");
  assert.equal(parseAuditVerdict("APPROVED:").kind, "approved");
});

test("the auditor prompt asks for ONE line and forbids continuing the work (#audit)", () => {
  const p = auditPrompt({ goal: "ship it", verify: "tests pass", summary: "done" });
  assert.match(p, /FINAL line/, "the contract must say where the marker goes");
  assert.match(
    p,
    /Do not continue the work/,
    "the auditor kept continuing the work — the prompt has to forbid it explicitly (#audit)",
  );
  // the worker's claim must be labelled untrusted: a summary is not evidence
  assert.match(p, /UNTRUSTED/);
});

test("the auditor prompt carries the contract and the claim (#audit)", () => {
  const p = auditPrompt({ goal: "ship the thing", verify: "npm test passes", summary: "I ran them" });
  assert.ok(p.includes("ship the thing"), "the objective must be present");
  assert.ok(p.includes("npm test passes"), "the contract is what it checks");
  assert.ok(p.includes("I ran them"), "and the claim it is checking");
});
