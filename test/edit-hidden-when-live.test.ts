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
const _agent = readSource(path.join(here, "..", "src", "agent", "agent.ts"));

