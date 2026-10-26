import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_CONTINUE_NUDGE, PROGRESS_REQUEST } from "../src/agent/agent.ts";

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
  assert.match(
    AUTO_CONTINUE_NUDGE,
    /prose/i,
    `must say that replying in prose does not stop the loop (#43): ${AUTO_CONTINUE_NUDGE}`,
  );
  assert.match(AUTO_CONTINUE_NUDGE, /does not stop/i);
});

test("the nudge still tells it to keep working (#43)", () => {
  assert.match(AUTO_CONTINUE_NUDGE, /Continue working toward the current goal/i);
});

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
  assert.match(
    PROGRESS_REQUEST,
    /Please give a brief progress report/,
    "the opening sentence must stay recognisable (#45)",
  );
  assert.match(PROGRESS_REQUEST, /Keep it under 10 lines/);
});

test("the two harness nudges are distinct and both name a tool (#43/#45)", () => {
  assert.notEqual(AUTO_CONTINUE_NUDGE, PROGRESS_REQUEST);
  assert.match(AUTO_CONTINUE_NUDGE, /finish\(/);
  assert.match(PROGRESS_REQUEST, /report_progress/);
});
