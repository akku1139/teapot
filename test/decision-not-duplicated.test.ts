/**
 * #107 — "both `decision` and `record_decision` exist on the timeline. Keep only
 * `decision`."
 *
 * One `record_decision` call produces THREE log events:
 *
 *   decision      -> rendered as the 📌 card (App.tsx `case "decision"`)
 *   tool_call     -> a meta row "called record_decision"
 *   tool_result   -> a meta row "record_decision succeeded"
 *
 * `report_progress` and `ask_user` are already excluded from the meta rows
 * because their own embeds render everything. `record_decision` was not, so the
 * operator saw the decision twice — the card, then a row that restated that the
 * tool had been called. That is the reported symptom exactly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
const agent = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");

/** the meta-row exclusion list */
function exclusionList(): string {
  const at = app.indexOf('metaToolName === "report_progress"');
  assert.notEqual(at, -1, "the exclusion list must exist (#107)");
  // Bound the slice by the LAST exclusion, not by the next occurrence of
  // "tool_result" — the identifier appears in the line above the list, so that
  // ended the window before any of the entries and every match came back empty.
  const start = app.lastIndexOf("const metaToolName", at);
  const end = app.indexOf("// paired tool results", at);
  return app.slice(start, end);
}

test("record_decision is excluded from the meta rows (#107)", () => {
  assert.match(
    exclusionList(),
    /metaToolName === "record_decision"\) return false;/,
    "record_decision's tool rows must be dropped, or the decision appears twice (#107)",
  );
});

test("it sits with the other fully-embedded tools (#107)", () => {
  // same treatment as report_progress and ask_user, not a separate special case
  const list = exclusionList();
  for (const tool of ["report_progress", "ask_user", "record_decision"]) {
    assert.match(
      list,
      new RegExp(`metaToolName === "${tool}"\\) return false;`),
      `${tool} must be excluded in the same list (#107)`,
    );
  }
});

test("the decision card itself still renders (#107)", () => {
  // the exclusion must not remove the thing the operator wants
  assert.match(app, /case "decision":/, "the 📌 decision card must remain (#107)");
  assert.match(
    app,
    /📌/,
    "and it must still be drawn (#107)",
  );
});

test("the handler really does emit both a decision event and a tool pair (#107)", () => {
  // the premise. If this ever changes, the exclusion becomes dead code and the
  // comment above it should change with it.
  const at = agent.indexOf('call.function.name === "record_decision"');
  assert.notEqual(at, -1, "the handler must exist (#107)");
  const body = agent.slice(at, at + 2600);
  assert.match(
    body,
    /log\.append\("decision"/,
    "it appends a decision event (#107)",
  );
  assert.match(
    body,
    /answerMeta\(/,
    "and answers the meta tool call (#107) — hence the duplicate",
  );
});

test("no OTHER tool was newly excluded (#107)", () => {
  // the exclusion list is a deliberate allowlist; adding entries silently would
  // hide tools from the timeline without anyone noticing
  const names = [...exclusionList().matchAll(/metaToolName === "([a-z_]+)"\) return false;/g)].map(
    (m) => m[1]!,
  );
  assert.deepEqual(
    [...names].sort(),
    ["ask_user", "record_decision", "report_progress"],
    `the exclusion list changed: ${JSON.stringify(names)} (#107)`,
  );
});