/**
 * #41 — "finish → audit reject → continue is hard to follow on the timeline"
 *
 * The audit lifecycle emits four `goal` events (status=done → audit-started →
 * audit → status=active), and the renderer collapsed each into
 *
 *     🎯 goal <event>: <d.text ?? "">
 *
 * which produced bare labels with EMPTY bodies — the verification contract and
 * the verdict/feedback never reached the screen. And because `status: done` is
 * logged BEFORE the audit runs, the timeline read as if the goal had completed
 * when the audit was about to reject it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { goalLine, auditPhase, isAuditLifecycle } from "../frontend/goal-timeline.ts";

/* ---------- the reported sequence, end to end ---------- */

test("the finish→audit→continue sequence is legible (#41)", () => {
  // the exact four events src/agent/agent.ts logs
  const claimed = goalLine({ event: "status", status: "done" });
  const started = goalLine({ event: "audit-started", verify: "npm test passes" });
  const rejected = goalLine({
    event: "audit",
    verdict: "changes-required",
    feedback: "tests are missing for the parser",
  });
  const reopened = goalLine({ event: "status", status: "active" });

  // the claim must NOT read as completion
  assert.match(claimed.label, /pending audit/i, "'done' must read as PENDING audit (#41)");
  // the contract being audited must be visible
  assert.equal(started.detail, "npm test passes", "the verify contract must be shown (#41)");
  // the verdict must be visible
  assert.equal(rejected.detail, "tests are missing for the parser", "the verdict must be shown (#41)");
  // and the reopen must be labelled as such
  assert.match(reopened.label, /reopened/i, "the reopen must be labelled (#41)");
});

/* ---------- THE regression: no empty bodies ---------- */

test("no lifecycle event renders with an empty body (#41)", () => {
  // the old template produced "🎯 goal audit:" + oneLine(d.text ?? "") — and
  // audit-started/audit carry NO text field, hence the blank row
  const events = [
    { event: "audit-started", verify: "npm test passes" },
    { event: "audit", verdict: "approved", feedback: "all good" },
    { event: "audit", verdict: "changes-required", feedback: "needs tests" },
    { event: "audit-failed", detail: "auditor 500" },
    { event: "status", status: "done" },
    { event: "status", status: "active" },
  ];
  for (const e of events) {
    const line = goalLine(e);
    assert.ok(line.label.trim(), `empty label for ${JSON.stringify(e)} (#41)`);
    assert.ok(
      line.detail.trim(),
      `empty BODY for ${JSON.stringify(e)} → rendered as "${line.label}:" with nothing after it (#41)`,
    );
  }
});

/* ---------- labels say what happened ---------- */

test("each lifecycle event gets its own label (#41)", () => {
  assert.match(goalLine({ event: "audit-started" }).label, /audit started/i);
  assert.match(goalLine({ event: "audit", verdict: "approved" }).label, /approved/i);
  assert.match(goalLine({ event: "audit", verdict: "changes-required" }).label, /changes required/i);
  assert.match(goalLine({ event: "audit-failed" }).label, /unavailable/i);
  // and none of them leaks the raw event name
  for (const e of [
    { event: "audit-started" },
    { event: "audit", verdict: "approved" },
    { event: "audit-failed" },
  ]) {
    assert.doesNotMatch(goalLine(e).label, /goal audit/, `raw event name leaked: ${goalLine(e).label}`);
  }
});

test("an approved audit reads differently from a rejected one (#41)", () => {
  const ok = goalLine({ event: "audit", verdict: "approved", feedback: "ship it" });
  const bad = goalLine({ event: "audit", verdict: "changes-required", feedback: "fix it" });
  assert.notEqual(ok.label, bad.label, "the two verdicts must be distinguishable (#41)");
  assert.equal(ok.tone, "ok");
  assert.equal(bad.tone, "warn");
});

test("a failed audit is an error and says the finish was accepted (#41)", () => {
  const line = goalLine({ event: "audit-failed", detail: "auditor returned 500" });
  assert.equal(line.tone, "err");
  assert.match(line.label, /accepted/i, "fail-open must be explicit (#41)");
  assert.equal(line.detail, "auditor returned 500");
});

/* ---------- tone drives the visual distinction ---------- */

test("the reopen is visually distinct from a normal status (#41)", () => {
  assert.equal(goalLine({ event: "status", status: "active" }).tone, "warn");
  assert.equal(goalLine({ event: "status", status: "done" }).tone, "", "a pending claim is not a warning");
});

test("audit feedback renders as markdown so lists survive (#41)", () => {
  assert.equal(goalLine({ event: "audit", verdict: "approved", feedback: "- a\n- b" }).markdown, true);
  // a verify contract is plain text, and code-fenced so it is not reflowed
  const started = goalLine({ event: "audit-started", verify: "npm test passes" });
  assert.equal(started.markdown, false);
});

/* ---------- robustness ---------- */

test("missing fields degrade gracefully (#41)", () => {
  for (const e of [
    {},
    { event: "audit" },
    { event: "audit", verdict: "approved" },
    { event: "audit-started" },
    { event: "status" },
    { event: "status", status: "done" },
    { event: "audit-failed" },
  ]) {
    const line = goalLine(e);
    assert.ok(line.label.trim(), `empty label for ${JSON.stringify(e)}`);
    assert.ok(line.detail.trim(), `empty detail for ${JSON.stringify(e)} (#41)`);
  }
});

test("unknown goal events still render (#41)", () => {
  const line = goalLine({ event: "verify-set", verify: "x" });
  assert.ok(line.label.includes("verify-set"), "unknown events must not vanish");
  assert.equal(auditPhase({ event: "verify-set" }), "other");
  assert.equal(isAuditLifecycle({ event: "verify-set" }), false);
  assert.equal(isAuditLifecycle({ event: "audit" }), true);
});

test("a non-audit goal event keeps its text (#41)", () => {
  const line = goalLine({ event: "text", text: "ship the parser" });
  assert.equal(line.detail, "ship the parser");
});

/* ---------- App.tsx wiring ---------- */

test("App.tsx renders goal events through goalLine (#41)", () => {
  const src = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  assert.match(src, /goalLine\(e\.data/, "the goal renderer must go through goalLine (#41)");
  assert.doesNotMatch(
    src,
    /🎯 goal \{String\(d\.event/,
    "the old empty-body template must be gone (#41)",
  );
  // the label alone is not enough — the detail must be rendered too
  const block = src.slice(src.indexOf('if (e.type === "goal")'));
  assert.match(block.slice(0, 1400), /line\.detail/, "the detail body must be rendered (#41)");
});