import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

/**
 * A delivery note clears its echo for ANY session, and the queue badge counts echoes.
 *
 * Reported: "タイムライン上でharnessとyouとが出てて、youはqueuedになってて、harnessはqueuedになってない。
 * そして、youのはずっとqueuedが外れないし、タイムライン上部にはqueuedのカウントが出てない".
 *
 * Two defects, one root — the echo and the server snapshot were treated as separate truths:
 *
 *   1. `prompt-delivered` / `prompt-cancelled` only cleared the echo when the note belonged to the
 *      VISIBLE agent (`msg.agentId === selected()`). Echoes are stored PER SESSION, so a prompt
 *      delivered while the operator was reading another session kept its echo forever.
 *   2. the ⏳ badge was gated on the agent SNAPSHOT alone. An echo with no snapshot entry (just sent,
 *      or one of the stale ones above) left the timeline showing `queued` with a count of zero.
 */
test("a delivery note clears the echo in whichever session holds it (#echo)", () => {
  const app = readSource("frontend/App.tsx");
  const at = app.indexOf('ed.event === "prompt-delivered"');
  assert.ok(at > 0, "the delivery handler must exist");
  const window = app.slice(Math.max(0, at - 200), at + 1800);
  assert.doesNotMatch(
    window,
    /ed\.event === "prompt-delivered" && msg\.agentId === selected\(\)/,
    "gating the clear on the VISIBLE agent is what left a queued echo with no way to clear it (#echo)",
  );
  assert.match(
    window,
    /pendingBySession/,
    "the clear must search the per-session store, because the note may name a session that is not on " +
      "screen (#echo)",
  );
});

test("the queued badge counts echoes as well as the snapshot (#echo)", () => {
  const app = readSource("frontend/App.tsx");
  const at = app.indexOf("const queuedCount = () =>");
  assert.ok(at > 0, "there must be one place that answers 'how many are queued' (#echo)");
  const body = app.slice(at, at + 700);
  /**
   * The echo half comes from `pendingCount()` — the pipeline's own count — and NOT from
   * `pendingMsgs().length`.
   *
   * `pendingMsgs()` is client memory; the rows are chosen from the LOG. Counting memory made the
   * badge outlive the row it counted: the feed showed nothing queued and "⏳ 1 message queued"
   * stayed until a session switch rebuilt the list. Asserting the raw list here is what kept that
   * alive, so the assertion is now the shared decision.
   */
  assert.match(body, /pendingCount\(\)/, "echoes are the other half of the answer, from the pipeline (#echo)");
  assert.doesNotMatch(
    body,
    /pendingMsgs\(\)\.length/,
    "counting client memory is the drift this replaced — the log decides (#echo)",
  );
  assert.match(body, /pendingPromptQueue|pendingPromptIds|pendingPrompts/, "and the snapshot is one half (#echo)");
  // the gate must use it, or the memo is dead code and the badge stays hidden
  assert.match(
    app,
    /<Show when=\{queuedCount\(\) > 0\}>/,
    "the badge must be gated on that count, or an echo-only queue shows nothing (#echo)",
  );
});
