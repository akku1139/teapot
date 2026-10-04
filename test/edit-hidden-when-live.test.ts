/**
 * #129 — "after sending with edit, stop can no longer be done from the controls.
 * Reloading the tab makes stop work again."
 *
 * ## Mechanism
 *
 * The edit affordance was offered on ANY delivered user prompt, including while the
 * agent was running. But `editPromptAt` refuses a live agent:
 *
 *     "agent is running — stop it before editing history"
 *
 * so the button opened a modal whose only possible submission was a 409. That
 * modal then sat over the controls, and Escape closed the MODAL rather than
 * stopping the agent — that ordering is deliberate (#107: Escape must dismiss the
 * topmost overlay first). So the operator pressing stop saw nothing happen, and a
 * reload cleared the modal and "fixed" it.
 *
 * Measured before the fix, through the real route:
 *
 *     status before edit : running
 *     edit-prompt ->     409 {"error":"agent is running — stop it before editing history"}
 *     stop ->            200        (the endpoint is fine; the modal blocks the UI)
 *
 * The server-side guard is correct and stays. The fix is not to offer an action
 * that cannot succeed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readSource(path.join(here, "..", "frontend", "App.tsx"));
const agent = readSource(path.join(here, "..", "src", "agent", "agent.ts"));

test("the edit affordance is hidden while the agent is live (#129)", () => {
  const at = app.indexOf("setEditing({ eventId: e.id");
  assert.notEqual(at, -1, "the edit affordance must exist (#129)");
  const gate = app.slice(Math.max(0, at - 900), at);
  assert.match(
    gate,
    /!\s*isSelLive\(\)/,
    "the editor must not be offered while the agent is live — the route 409s (#129)",
  );
});

test("it is still offered once the agent is idle (#129)", () => {
  // the fix must gate on liveness, not disable the feature
  // anchor on the conditions themselves rather than a fixed-width slice
  const at = app.indexOf("setEditing({ eventId: e.id");
  const from = app.indexOf('e.type === "prompt" &&', Math.max(0, at - 1200));
  const gate = app.slice(from, at);
  for (const cond of [
    'e.data?.source === "user"',
    "!e.data?.cancelled",
  ]) {
    assert.ok(gate.includes(cond), `the other conditions must remain: ${cond} (#129)`);
  }
});

test("the server-side refusal is unchanged — it is correct (#129)", () => {
  assert.match(
    agent,
    /throw new Error\("agent is running — stop it before editing history"\);/,
    "the guard must stay: editing under a live agent replaces the array it resumes into (#38)",
  );
});
