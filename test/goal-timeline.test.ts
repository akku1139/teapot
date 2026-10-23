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
import { goalLine, auditPhase, isAuditLifecycle } from "../frontend/lib/goal-timeline.ts";
import { Agent } from "../src/agent/agent.ts";
import { useTempDirs } from "./helpers/tmp.ts";
import { readEvents } from "../src/log/events.ts";

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
  // the audit rejection is what reopens a goal, so it carries `by: "auditor"` — a bare "active"
  // with no cause is the operator case (see the resume test below)
  const reopened = goalLine({ event: "status", status: "active", by: "auditor" });

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
  // a WARNING belongs to the audit rejection only: it is the case where the agent's finish was
  // refused. An operator resuming a paused goal is a plain action and must not look like a problem.
  assert.equal(goalLine({ event: "status", status: "active", by: "auditor" }).tone, "warn");
  assert.equal(goalLine({ event: "status", status: "active", by: "operator" }).tone, "");
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
    // #41: never a bare label with nothing after it.
    // #51: a VERDICT with no REASON is the one deliberate exception — a card
    // whose whole content is "(no detail)" is the absence of a finding dressed
    // up as one. The label still stands; only the card is withheld, and
    // `hasCard` is the flag that says so.
    // `audit-started` is NOT the exception: it always carries the verification
    // contract (or a "checking…" fallback).
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

/* ---------- App.tsx wiring ---------- */


/**
 * The goal text is MARKDOWN, and it must be rendered as such.
 *
 * Reported: "タイムラインに出るgoal関連のカードがマークダウンレンダリングされてない". The card
 * component already called `renderMarkdown`, but `goalLine()` set `markdown: false` for every
 * branch carrying real prose, so the renderer wrapped it in a code fence and the operator's own
 * goal came back showing literal `## Heading` and `- item`.
 *
 * The distinction that matters: a FIXED sentence ("the audit rejected the finish — work
 * continues on the same goal") needs no markdown, but anything taken from `d.text`, `d.verify`
 * or `d.feedback` is prose someone wrote.
 */
test("operator/agent prose in a goal card is rendered as MARKDOWN (#goal-md)", () => {
  // a goal the operator wrote with common markdown
  const goalText = "## Ship it\n\n- [ ] tests pass\n- run `pnpm typecheck`";
  const cases: { name: string; data: Record<string, unknown> }[] = [
    { name: "goal text (default branch)", data: { text: goalText } },
    { name: "goal status with text", data: { status: "active", text: goalText } },
    { name: "goal status with no text", data: { status: "paused" } },
  ];
  // the audit VERDICT's feedback is prose too
  cases.push({ name: "audit feedback", data: { event: "audit", verdict: "approved", feedback: goalText } });

  for (const c of cases) {
    const line = goalLine(c.data as never);
    assert.equal(
      line.markdown,
      true,
      `${c.name}: a card carrying prose must be markdown, or its headings and lists render literally`,
    );
  }

  // …and a branch whose body is a FIXED sentence stays plain: there is no markdown in it, and
  // treating it as markdown would invite the model's wording to be reinterpreted as structure
  // `event: "status"` is required: without it this routes to the catch-all branch, which is
  // the "unknown event with prose" case and IS markdown. The fixture was what was wrong.
  const fixed = goalLine({ event: "status", status: "done" } as never);
  assert.equal(fixed.markdown, false, "a canned sentence is not markdown");
  assert.ok(fixed.detail.length > 0, "precondition: it still carries a body");
});

test("`active` from the OPERATOR is a resume, not an audit rejection (#41)", () => {
  /**
   * Reported: pausing a goal and pressing ▶ working produced
   * "▶ goal reopened / the audit rejected the finish — work continues on the same goal".
   *
   * Both causes set status to "active", and the renderer hardcoded the audit wording, so a
   * deliberate operator action was announced as a rejected delivery. The event now carries `by`.
   */
  const resumed = goalLine({ event: "status", status: "active", by: "operator" });
  assert.match(resumed.label, /resumed/);
  assert.doesNotMatch(resumed.detail, /audit/i, "a resume must not claim the audit was involved");
  assert.doesNotMatch(resumed.label, /reopened/);

  // and the audit case keeps its warning, because there it IS the truth
  const rejected = goalLine({ event: "status", status: "active", by: "auditor" });
  assert.match(rejected.label, /reopened/);
  assert.match(rejected.detail, /audit rejected/);
  assert.equal(rejected.tone, "warn");

  /**
   * A log written before `by` existed cannot say which happened, so it gets the NEUTRAL wording:
   * guessing "the audit rejected it" is how the original bug looked.
   */
  const legacy = goalLine({ event: "status", status: "active" });
  assert.doesNotMatch(legacy.detail, /audit/i, "an unknown cause must not be reported as an audit rejection");
  assert.match(legacy.label, /resumed/);
});


test("the API records WHY a status changed, so the two `active` causes stay distinct (#41)", async () => {
  /**
   * The renderer can only tell a resume from an audit rejection if the log says which it was, and
   * the log is written by the agent. This pins the PRODUCER side: the operator path records
   * `by: "operator"`. Without it the renderer fix is cosmetic — correct wording over an event that
   * never says who changed anything.
   */
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
    // paused → active: the reported sequence
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
