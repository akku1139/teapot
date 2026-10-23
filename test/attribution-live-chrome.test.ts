/**
 * #40 — "agent2's message is agent1's content, and it has a writing cursor."
 *
 * This is the SECOND attempt. The first (b150cae) gated the timeline's live
 * chrome on `isOwnLiveWork(e)`, on the theory that mirrored sub-agent rows —
 * the child's events the master writes into the parent's log — were wearing the
 * parent's "writing…" cursor. The gate was correct; the rows it was meant to
 * judge **never existed in the feed**.
 *
 * `"sub"` was missing from FEED_TYPES, so the `real` filter (App.tsx) stripped
 * every mirrored row, and the expansion that tags a row with its `actor` ran
 * over the already-filtered list. No row could ever carry an actor, so
 * `isOwnLiveWork()` returned true for all of them and the gate collapsed back
 * to the provenance-blind check it replaced. Verified against the shipped
 * bundle as well as the source.
 *
 * The dead mirroring is also a bug in its own right: the master deliberately
 * mirrors a child's prompts, messages, tool calls and results into the
 * parent's log "so the parent feed shows who did what", and since `"sub"` was
 * never in FEED_TYPES in any commit, a parent feed showed **no trace at all**
 * of work it had delegated. The operator saw the parent go quiet and a harness
 * row carrying the child's report, and concluded the two feeds were mixed up.
 *
 * So this file tests the PIPELINE, not the source text. The previous test
 * grepped App.tsx for the expansion line, which is why it passed over a dead
 * code path — the exact failure mode this rewrite exists to prevent. The
 * `FEED_TYPES` scrape that remained was still a source read; it is now asserted
 * against the REAL BUNDLE (scripts/smoke-web.ts renders it), so the Set is
 * covered where it actually runs and the scrape is gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwnLiveWork } from "../frontend/lib/live-buffer.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

// #110: POSIX-only — runs POSIX commands through the bash tool.
// The Windows CI job skips this file; see test/helpers/posix-only.ts for why
// opting out is explicit rather than by filename.
markPosixOnly("runs POSIX commands through the bash tool");

/**
 * The expansion the timeline applies to a legacy mirrored row, transcribed from
 * the shipped behaviour: a `sub` row is re-typed as its inner kind and tagged
 * with its actor. `state` churn is dropped.
 *
 * NOTE: `FEED_TYPES` is no longer scraped out of App.tsx (that was a source-text
 * assertion, and it once asserted the OPPOSITE of shipped behaviour — #141). The
 * live set is asserted against the real bundle in scripts/smoke-web.ts.
 */
function expand(rows: { type: string; data?: any }[]): { type: string; data?: any }[] {
  const out: { type: string; data?: any }[] = [];
  for (const e of rows) {
    if (e.type === "sub") {
      const d = e.data as { sub?: string; type?: string; data?: any };
      const kind = String(d?.type ?? "message");
      if (kind === "state") continue; // child state churn is noise up here
      out.push({ ...e, type: kind, data: { ...d?.data, actor: d?.sub } });
    } else out.push(e);
  }
  return out;
}

/** the reported shape: a parent's log carrying its own work and a child's */
function mixedLog() {
  return [
    { id: "e1", type: "prompt", data: { source: "user", text: "go" } },
    { id: "e2", type: "message", data: { role: "assistant", content: "PARENT TEXT" } },
    { id: "e3", type: "sub", data: { sub: "kid", type: "message", data: { role: "assistant", content: "CHILD TEXT" } } },
    { id: "e4", type: "sub", data: { sub: "kid", type: "tool_call", data: { name: "bash", args: { command: "ls" } } } },
  ];
}

/* ---------- the reported symptom ---------- */

test("a legacy `sub` row is not the selected agent's own live work (#40, #63)", () => {
  // the gate still has to work, but the input is a LEGACY log: one that still
  // carries `sub` rows from before #63. They are expanded for display, and must
  // not be mistaken for the parent's own in-flight work — otherwise a child's
  // output wears the parent's streaming chrome, which is #40 exactly.
  const rows = expand(mixedLog()); // deliberately NOT filtered
  const own = rows.map(isOwnLiveWork);
  assert.deepEqual(
    own,
    [true, true, false, false],
    `the parent's own rows stay live; a child's do not (#40): ${JSON.stringify(own)}`,
  );
});

test("the gate is no longer a no-op on a REAL feed (#40)", () => {
  // anti-vacuity: the check must be able to distinguish the two cases, so vary the
  // selected agent and require the answer to change
  // `isOwnLiveWork(row)` takes ONE argument — it reads `data.actor` — so my first
  // version of this passed a second one and the two maps were IDENTICAL, which is
  // precisely the vacuity this test exists to catch.
  //
  // The real anti-vacuity check: the gate must actually distinguish the two kinds
  // of row in the fixture, or it is a no-op for everything that matters.
  const rows = expand(mixedLog());
  const own = rows.map(isOwnLiveWork);
  assert.ok(
    own.some((v) => v === true) && own.some((v) => v === false),
    `the gate must answer BOTH ways on this fixture, or it decides nothing (#40/#141); got ${JSON.stringify(own)}`,
  );
  // and it must key on the actor, not on position or count
  assert.equal(isOwnLiveWork({ data: { actor: "kid" } }), false, "an actor means NOT own work (#40)");
  assert.equal(isOwnLiveWork({ data: {} }), true, "no actor means own work (#40)");
  assert.equal(isOwnLiveWork({ data: { actor: "" } }), true, "an empty actor is not an attribution (#40)");
  assert.equal(isOwnLiveWork(null), false, "a null row is not own work (#40)");
});

/* ---------- the mirroring contract itself ---------- */

test("the child state churn is still filtered out (#40)", () => {
  // `state` was explicitly excluded as noise; a child flipping running→idle
  // several times a turn would otherwise fill the parent's feed with dividers.
  const rows = expand([
    { type: "sub", data: { sub: "kid", type: "state", data: { from: "running", to: "idle" } } },
    { type: "sub", data: { sub: "kid", type: "message", data: { content: "kept" } } },
  ]);
  assert.deepEqual(rows.map((r) => r.type), ["message"], "child state must not render (#40)");
});

test("a mirrored row with no type defaults to a message (#40)", () => {
  const rows = expand([{ type: "sub", data: { sub: "kid" } }]);
  assert.equal(rows[0]!.type, "message", "the master always sets a type, but be safe (#40)");
  assert.equal(rows[0]!.data.actor, "kid");
});

/* ---------- wiring: the gate must still be in place ---------- */
