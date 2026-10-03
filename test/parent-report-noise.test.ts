/**
 * #94 — what the parent is told about the work, once a finish audit is accepted.
 *
 * `captureRecentTurns()` fills a SIX-slot window. In the real log for
 * `tyb2-5-sub-sound-deep-dive-4c13c187`, the accepted report's window was:
 *
 *     [tool]      leds-mt6320.c  newline=OK …            (548 chars, useful)
 *     [assistant] All files clean. Let me run the final…    ( 72 chars, useful)
 *     [tool]      ════ FINAL ════ checkpatch: 0 errors…    (293 chars, useful)
 *     [assistant] (tool call)                            ( 23 chars, NOTHING)
 *     [tool]      decision recorded to decisions.md      ( 40 chars, NOTHING)
 *     [assistant] (tool call)                            ( 23 chars, NOTHING)
 *
 * Half the window was consumed by entries carrying no information:
 *
 *  - `llm.ts` rewrites any assistant/tool message with no usable text to the
 *    literal "(tool call)" / "(no content)". Those are DISPLAY ARTIFACTS and
 *    were reaching the parent verbatim.
 *  - harness acknowledgements ("decision recorded to…") are addressed to the
 *    OPERATOR, not to the agent that reads this next.
 *
 * Dropping them pulled real content back into the window — in the replay above,
 * a 3,600-char finding that had been pushed out entirely.
 *
 * A tool CALL is still work; it is represented by the tool RESULT that follows,
 * so the placeholder itself loses nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HARNESS_ACK, PLACEHOLDER_TEXT } from "../src/agent/agent.ts";

const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");

/**
 * The SHIPPED rules, imported — not re-typed. A copy could drift from the code
 * it is meant to describe, which is the failure mode #75 exists about.
 */
const kept = (text: string): boolean => {
  const t = text.trim();
  if (!t) return false;
  if (PLACEHOLDER_TEXT.test(t)) return false;
  if (HARNESS_ACK.test(t)) return false;
  return true;
};

/* ---------- the filters, stated as behaviour ---------- */

test("a '(tool call)' placeholder is not reported as content (#94)", () => {
  // `kept` takes the raw message text; the "[assistant] " prefix is added later
  assert.equal(kept("(tool call)"), false, "#94");
  assert.equal(kept("x (tool call)"), true, "only a WHOLE placeholder is dropped (#94)");
});

test("EVERY parenthesised acknowledgement is dropped, not just three (#94)", () => {
  // Measured across all session logs. My first filter listed three literals and
  // caught 2 of the 10 forms actually reaching a parent — the rest are harness
  // acks from answerMeta and the meta-tool handlers.
  const real = [
    "(tool call)",
    "(no content)",
    "(no output)",
    "(tool_call)",            // underscore variant
    "(goal complete)",
    "(round ended)",
    "(round ended: finished)",
    "(tool try)",
    "(no sub-agents)",
    "(nothing running to stop)",
    "(no result recorded)",
    "(todo.md is empty — no task list yet)",
    "(decisions.md is empty — no decisions recorded yet)",
    "(skills created)",
  ];
  for (const p of real) assert.equal(kept(p), false, `#94 must drop the ack: ${p}`);
});

test("real work is never mistaken for an acknowledgement (#94)", () => {
  // the trade of matching a SHAPE: a genuine message that happened to be
  // entirely parenthesised would also go. These must not.
  for (const g of [
    "All files clean, running the final verification.",
    "leds-mt6320.c newline=OK trailing-ws=0",
    "════ FINAL ════ checkpatch: 0 errors, 718 lines checked",
    "Seven rejections with no stated gap. I stopped auditing the driver.",
    "The symbol is MFD_MT6397, not MFD_MT6320 — see drivers/mfd/Kconfig:1141",
  ])
    assert.equal(kept(g), true, `#94 must keep real work: ${g.slice(0, 40)}`);
});

test("harness acknowledgements do not consume a slot (#94)", () => {
  for (const a of [
    "decision recorded to decisions.md",
    "progress recorded",
    "goal saved",
    "memory saved",
    "read_memory",
  ])
    assert.equal(kept(a), false, `#94: ${a}`);
});

test("real findings are kept (#94)", () => {
  // the regression this could have caused: filtering too eagerly and reporting
  // an empty window, which tells the parent nothing at all
  for (const good of [
    "All files clean. Let me run the complete final verification.",
    "════ FINAL ════ checkpatch: total: 0 errors, 0 warnings, 718 lines checked",
    "leds-mt6320.c newline=OK trailing-ws=0",
    "Seven rejections with no stated gap. I stopped auditing the driver.",
  ])
    assert.equal(kept(good), true, `#94 must keep: ${good.slice(0, 40)}`);
});

/* ---------- wired into the real capture ---------- */

test("captureRecentTurns drops placeholders and acknowledgements (#94)", () => {
  const i = src.indexOf("private async captureRecentTurns()");
  assert.notEqual(i, -1, "the method must exist (#94)");
  const body = src.slice(i, src.indexOf("\n  }", i));
  assert.match(
    body,
    /PLACEHOLDER_TEXT\.test\(text\)/,
    "placeholders must be filtered (#94) — they were half the window in the real log",
  );
  assert.match(body, /HARNESS_ACK\.test\(text\)/, "harness acks must be filtered (#94)");
});

test("the filters are anchored, not substring matches (#94)", () => {
  // Behavioural, not a regex-over-source check: the real log contained a
  // 3,600-char finding, and a loose match that dropped it merely because it
  // mentioned "memory" would be worse than not filtering at all.
  const longFinding =
    "I fixed the driver. The memory layout was wrong and I had to re-read the " +
    "datasheet twice before I understood the decision recorded in the log.";
  assert.equal(
    kept(longFinding),
    true,
    `a real finding must not be dropped for CONTAINING an ack phrase (#94): ${longFinding.slice(0, 50)}`,
  );
  assert.equal(kept("this (tool call) appears mid-sentence"), true, "only a WHOLE placeholder (#94)");
});

test("the window is still bounded (#94)", () => {
  const i = src.indexOf("private async captureRecentTurns()");
  const body = src.slice(i, src.indexOf("\n  }", i));
  assert.match(body, /recent\.length < \d+/, "the window must stay bounded (#94)");
});
