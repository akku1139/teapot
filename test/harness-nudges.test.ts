/**
 * #43 — "without a nudge to call the finish tool it just works forever on
 *         'Continue working toward the current goal. If you are blocked,
 *          explain why briefly.'"
 * #45 — "the progress request should tell it to use the progress tool … it
 *         calls the tool and then also reports in text"
 *
 * Both are harness-prompt bugs, and both are invisible in normal use: the
 * nudge only fails when the model has actually finished, and the duplicate
 * report only shows on the timeline. Asserting on the exported prompt text
 * pins them cheaply and precisely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUTO_CONTINUE_NUDGE, PROGRESS_REQUEST } from "../src/agent/agent.ts";

const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");

/* ---------- #43: the nudge must say how to STOP ---------- */

test("the auto-continue nudge names the finish tool (#43)", () => {
  assert.match(
    AUTO_CONTINUE_NUDGE,
    /finish\(/,
    `the nudge must name finish() explicitly (#43): ${AUTO_CONTINUE_NUDGE}`,
  );
});

test("the nudge distinguishes met from blocked (#43)", () => {
  assert.match(AUTO_CONTINUE_NUDGE, /goalComplete=true/, "must say how to signal 'done' (#43)");
  assert.match(AUTO_CONTINUE_NUDGE, /goalComplete=false/, "must say how to signal 'blocked' (#43)");
});

test("the nudge warns that prose does not stop the loop (#43)", () => {
  // THE regression: the model has no other cue that prose != stop. Without this
  // sentence it answers in text and the loop nudges it again, forever.
  assert.match(
    AUTO_CONTINUE_NUDGE,
    /prose/i,
    `must say that replying in prose does not stop the loop (#43): ${AUTO_CONTINUE_NUDGE}`,
  );
  assert.match(AUTO_CONTINUE_NUDGE, /does not stop/i);
});

test("the nudge still tells it to keep working (#43)", () => {
  // the fix must not break the original purpose of the nudge
  assert.match(AUTO_CONTINUE_NUDGE, /Continue working toward the current goal/i);
});

test("agent.ts actually sends the shared nudge (#43)", () => {
  assert.match(src, /: AUTO_CONTINUE_NUDGE;/, "the root branch must use AUTO_CONTINUE_NUDGE (#43)");
});

test("both the root and the sub-agent nudge mention finish() (#43)", () => {
  // the sub-agent nudge already did; the root one did not. Neither may regress.
  const subNudge = /\[harness\] Auto-nudge\.[^`]*/.exec(src)?.[0] ?? "";
  assert.ok(subNudge.length > 0, "sub-agent nudge not found");
  assert.match(subNudge, /finish\(\)/, "the sub-agent nudge must keep naming finish() (#43)");
  assert.match(AUTO_CONTINUE_NUDGE, /finish\(\)/, "the root nudge must name it too (#43)");
});

/* ---------- #45: ask for the TOOL, not prose ---------- */

test("the progress request asks for the report_progress TOOL (#45)", () => {
  assert.match(
    PROGRESS_REQUEST,
    /report_progress/,
    `must name the tool (#45): ${PROGRESS_REQUEST}`,
  );
});

test("the progress request forbids a prose answer (#45)", () => {
  assert.match(
    PROGRESS_REQUEST,
    /do NOT answer in prose|not.*in prose/i,
    `must rule out the prose answer (#45): ${PROGRESS_REQUEST}`,
  );
  assert.match(
    PROGRESS_REQUEST,
    /duplicate/i,
    `must say why prose is wrong (#45): ${PROGRESS_REQUEST}`,
  );
});

test("the progress request names the tool's fields (#45)", () => {
  for (const f of ["doing", "goalStatus", "recent", "problems", "next"]) {
    assert.ok(
      PROGRESS_REQUEST.includes(f),
      `must tell the model what to fill in — missing "${f}" (#45)`,
    );
  }
});

test("the progress request keeps its identifying opening (#45)", () => {
  // existing harness prompts, tests and operator habit key off this sentence —
  // #45 changed the INSTRUCTION, not how the request is identified
  assert.match(
    PROGRESS_REQUEST,
    /Please give a brief progress report/,
    "the opening sentence must stay recognisable (#45)",
  );
  assert.match(PROGRESS_REQUEST, /Keep it under 10 lines/);
});

test("agent.ts actually sends the shared progress request (#45)", () => {
  assert.match(src, /const request = PROGRESS_REQUEST;/, "must use PROGRESS_REQUEST (#45)");
});

/* ---------- the two must not contradict each other ---------- */

test("the two harness nudges are distinct and both name a tool (#43/#45)", () => {
  assert.notEqual(AUTO_CONTINUE_NUDGE, PROGRESS_REQUEST);
  assert.match(AUTO_CONTINUE_NUDGE, /finish\(/);
  assert.match(PROGRESS_REQUEST, /report_progress/);
});