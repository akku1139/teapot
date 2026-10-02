/**
 * #51 — two complaints about the completion-audit rows:
 *
 *  1. "`🔍 completion audit started` and the audit body to its right are on ONE
 *     line, and the card's left edge is out of line with the others."
 *  2. "`⚠ audit: changes required (no detail)` sits between the divider lines,
 *     and having a `no detail` card in there feels a bit off."
 *
 * Cause for (1): the goal rows render inside `.divider-msg`, which is
 * `display:flex` with `::before`/`::after` filling the slack. A card nested
 * inside it is therefore a FLEX SIBLING of the label, not a block beneath it —
 * so the label, the card and the trailing rule all share one row, and the card
 * starts wherever the flex layout happens to put it.
 *
 * Cause for (2): when the auditor returns no usable text the harness stores the
 * literal placeholder "(no detail)", which the UI then renders as a card as if
 * it were the auditor's finding. A missing verdict is not a finding; it should
 * say the audit gave no reason rather than display a card reading "(no detail)".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { goalLine } from "../frontend/goal-timeline.ts";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
const agent = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");

function srcHas(label: string, re: RegExp): void {
  if (!re.test(app)) assert.fail(`${label}\n  expected source to match: ${re}`);
}

/* ---------- the layout cause ---------- */

test("the audit card is a BLOCK below the label, not a flex sibling (#51)", () => {
  // A card rendered directly inside .divider-msg becomes a flex child and lands
  // on the same row as the label. It needs a wrapper that stacks.
  srcHas(
    "the goal row must stack the label above the card (#51)",
    /class=\{"goalline[\s\S]{0,200}goalline-label/,
  );
});

test("the goal row does not reuse the divider flex container (#51)", () => {
  assert.doesNotMatch(
    app,
    /class=\{"divider-msg " \+ \(line\.tone/,
    "the audit card must not be a child of the flex .divider-msg row (#51)",
  );
});

test("the stacking wrapper has its own style (#51)", () => {
  const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.goalline\s*\{|block-title[\s\S]{0,200}display:\s*block/,
    "the new wrapper needs a rule that actually stacks its children (#51)",
  );
});

/* ---------- the "no detail" cause ---------- */

test("an audit with no reason does NOT produce a detail card (#51)", () => {
  const line = goalLine({
    event: "audit",
    verdict: "changes-required",
    feedback: "(no detail)",
  });
  // "(no detail)" is the harness placeholder for "the auditor said nothing
  // useful". Rendering it as a card is what the report calls 気持ち悪い — so
  // the placeholder must be recognised and suppressed.
  const showsPlaceholder =
    !!line.detail && /no detail/i.test(line.detail);
  assert.equal(
    showsPlaceholder,
    false,
    `a "(no detail)" placeholder must not be rendered as a card body (#51). Got: ${JSON.stringify(line.detail)}`,
  );
});

test("a real audit finding still renders its card (#51)", () => {
  const line = goalLine({
    event: "audit",
    verdict: "changes-required",
    feedback: "the parser drops CRLF line endings",
  });
  assert.match(
    line.detail ?? "",
    /CRLF/,
    "a genuine finding must still be shown (#51)",
  );
});

test("the harness must not persist the placeholder as if it were feedback (#51)", () => {
  // Storing "(no detail)" in goal.md means the RIGHT PANEL also shows it, so
  // the fix belongs at the source as well as in the renderer.
  assert.doesNotMatch(
    agent,
    /feedback \|\| "\(no detail\)"/,
    'the audit feedback must not be stored as the literal "(no detail)" (#51)',
  );
});
