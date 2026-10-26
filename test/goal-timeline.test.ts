import { test } from "node:test";
import assert from "node:assert/strict";
import { goalLine, auditPhase, isAuditLifecycle } from "../frontend/lib/goal-timeline.ts";
import { Agent } from "../src/agent/agent.ts";
import { useTempDirs } from "./helpers/tmp.ts";
import { readEvents } from "../src/log/events.ts";

test("the finish→audit→continue sequence is legible (#41)", () => {
  const claimed = goalLine({ event: "status", status: "done" });
  const started = goalLine({ event: "audit-started", verify: "npm test passes" });
  const rejected = goalLine({
    event: "audit",
    verdict: "changes-required",
    feedback: "tests are missing for the parser",
  });
  const reopened = goalLine({ event: "status", status: "active", by: "auditor" });

  assert.match(claimed.label, /pending audit/i, "'done' must read as PENDING audit (#41)");
  assert.equal(started.detail, "npm test passes", "the verify contract must be shown (#41)");
  assert.equal(rejected.detail, "tests are missing for the parser", "the verdict must be shown (#41)");
  assert.match(reopened.label, /reopened/i, "the reopen must be labelled (#41)");
});

test("no lifecycle event renders with an empty body (#41)", () => {
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

test("each lifecycle event gets its own label (#41)", () => {
  assert.match(goalLine({ event: "audit-started" }).label, /audit started/i);
  assert.match(goalLine({ event: "audit", verdict: "approved" }).label, /approved/i);
  assert.match(goalLine({ event: "audit", verdict: "changes-required" }).label, /changes required/i);
  assert.match(goalLine({ event: "audit-failed" }).label, /unavailable/i);
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

test("the reopen is visually distinct from a normal status (#41)", () => {
  assert.equal(goalLine({ event: "status", status: "active", by: "auditor" }).tone, "warn");
  assert.equal(goalLine({ event: "status", status: "active", by: "operator" }).tone, "");
  assert.equal(goalLine({ event: "status", status: "done" }).tone, "", "a pending claim is not a warning");
});

test("audit feedback renders as markdown so lists survive (#41)", () => {
  assert.equal(goalLine({ event: "audit", verdict: "approved", feedback: "- a\n- b" }).markdown, true);
  const started = goalLine({ event: "audit-started", verify: "npm test passes" });
  assert.equal(started.markdown, false);
});

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
    if (e.event === "audit" && !line.hasCard) {
      assert.equal(line.detail.trim(), "", "a withheld card must carry no detail (#51)");
      continue;
    }
    assert.ok(line.detail.trim(), `empty detail for ${JSON.stringify(e)} (#41)`);
    assert.equal(line.hasCard, true, `hasCard must agree with detail for ${JSON.stringify(e)}`);
  }
});

test("a verdict WITH a reason still gets its card (#51)", () => {
  for (const verdict of ["approved", "changes-required"]) {
    const line = goalLine({ event: "audit", verdict, feedback: "the parser drops CRLF" });
    assert.equal(line.hasCard, true, `a real ${verdict} reason must render a card (#51)`);
    assert.match(line.detail, /CRLF/);
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

test("operator/agent prose in a goal card is rendered as MARKDOWN (#goal-md)", () => {
  const goalText = "## Ship it\n\n- [ ] tests pass\n- run `pnpm typecheck`";
  const cases: { name: string; data: Record<string, unknown> }[] = [
    { name: "goal text (default branch)", data: { text: goalText } },
    { name: "goal status with text", data: { status: "active", text: goalText } },
    { name: "goal status with no text", data: { status: "paused" } },
  ];
  cases.push({ name: "audit feedback", data: { event: "audit", verdict: "approved", feedback: goalText } });

  for (const c of cases) {
    const line = goalLine(c.data as never);
    assert.equal(
      line.markdown,
      true,
      `${c.name}: a card carrying prose must be markdown, or its headings and lists render literally`,
    );
  }

  const fixed = goalLine({ event: "status", status: "done" } as never);
  assert.equal(fixed.markdown, false, "a canned sentence is not markdown");
  assert.ok(fixed.detail.length > 0, "precondition: it still carries a body");
});

test("`active` from the OPERATOR is a resume, not an audit rejection (#41)", () => {
  const resumed = goalLine({ event: "status", status: "active", by: "operator" });
  assert.match(resumed.label, /resumed/);
  assert.doesNotMatch(resumed.detail, /audit/i, "a resume must not claim the audit was involved");
  assert.doesNotMatch(resumed.label, /reopened/);

  const rejected = goalLine({ event: "status", status: "active", by: "auditor" });
  assert.match(rejected.label, /reopened/);
  assert.match(rejected.detail, /audit rejected/);
  assert.equal(rejected.tone, "warn");

  const legacy = goalLine({ event: "status", status: "active" });
  assert.doesNotMatch(legacy.detail, /audit/i, "an unknown cause must not be reported as an audit rejection");
  assert.match(legacy.label, /resumed/);
});

test("the API records WHY a status changed, so the two `active` causes stay distinct (#41)", async () => {
  await useTempDirs(["gby-a-", "gby-b-"], async ([ws, sd]) => {
    const agent = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
    } as never) as Agent;
    await agent.init();
    await agent.setGoal("do the thing");
    await agent.setGoalStatus("paused", "operator");
    await agent.setGoalStatus("active", "operator");

    const events = await readEvents(agent.log.filePath);
    const active = events.filter(
      (e) =>
        e.type === "goal" &&
        (e.data as { event?: string }).event === "status" &&
        (e.data as { status?: string }).status === "active",
    );
    assert.ok(active.length > 0, "precondition: a status=active goal event must be logged");
    assert.equal(
      (active[active.length - 1]!.data as { by?: string }).by,
      "operator",
      "the operator path must say so, or the renderer cannot avoid blaming the audit",
    );
    await agent.dispose();
  });
});

test("a manual completion is not described as an agent finish claim (#goal)", () => {
  const manual = goalLine({ event: "status", status: "done", by: "operator" });
  assert.doesNotMatch(
    manual.detail,
    /the agent called finish/,
    "a manual done must not announce a finish() the agent never made (#goal)",
  );
  assert.doesNotMatch(manual.detail, /being audited/, "and no audit runs for it (#goal)");
  assert.match(manual.label, /marked done/, "the label must say who did it (#goal)");
});

test("an AGENT's done still reads as a claim awaiting audit (#goal)", () => {
  const agent = goalLine({ event: "status", status: "done" });
  assert.match(agent.detail, /the agent called finish/, "the audited path keeps its wording (#goal)");
  assert.match(agent.label, /pending audit/, "and still says the audit is pending (#goal)");
});

test("an older log with no `by` keeps the pending-audit wording (#goal)", () => {
  assert.match(goalLine({ event: "status", status: "done", by: undefined }).detail, /the agent called finish/);
  assert.match(goalLine({ event: "status", status: "done", by: "" }).detail, /the agent called finish/);
});
