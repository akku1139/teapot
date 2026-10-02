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
 * code path — the exact failure mode this rewrite exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isOwnLiveWork } from "../frontend/live-buffer.ts";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

/** FEED_TYPES, read from the real source so the test cannot drift from it */
function feedTypes(): Set<string> {
  const block = app.slice(app.indexOf("const FEED_TYPES"), app.indexOf("const FEED_TYPES") + 500);
  const body = block.slice(block.indexOf("["), block.indexOf("]"));
  return new Set([...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!));
}

/** the `real` filter, as it behaves: non-FEED_TYPES rows are dropped */
const passesFilter = (e: { type: string }) => feedTypes().has(e.type);

/** the expansion loop from App.tsx, reproduced exactly */
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

/* ---------- the defect ---------- */

test("mirrored sub-agent rows survive the feed filter (#40)", () => {
  // THE regression. `sub` missing from FEED_TYPES meant the mirroring the
  // master performs was silently discarded by the UI.
  assert.ok(
    feedTypes().has("sub"),
    `"sub" must be in FEED_TYPES or mirrored child activity never renders (#40): got [${[...feedTypes()].join(", ")}]`,
  );
  for (const e of mixedLog()) {
    assert.ok(passesFilter(e), `a ${e.type} row must pass the filter (#40)`);
  }
});

test("a child's rows are rendered AND attributed to the child (#40)", () => {
  const rows = expand(mixedLog().filter(passesFilter));
  const actors = rows.map((r) => r.data?.actor ?? null);
  assert.deepEqual(
    actors,
    [null, null, "kid", "kid"],
    `only the mirrored rows carry an actor (#40): ${JSON.stringify(actors)}`,
  );
  // the child's own text is now visible in the parent's feed, which is the
  // feature the master was written for
  assert.ok(
    rows.some((r) => String(r.data?.content ?? "").includes("CHILD TEXT")),
    `the child's message must render in the parent's feed (#40): ${JSON.stringify(rows)}`,
  );
});

test("a child's row is NOT the selected agent's own live work (#40)", () => {
  // the gate b150cae added, finally with something to judge
  const rows = expand(mixedLog().filter(passesFilter));
  const own = rows.map(isOwnLiveWork);
  assert.deepEqual(
    own,
    [true, true, false, false],
    `the parent's own rows stay live; the child's do not (#40): ${JSON.stringify(own)}`,
  );
});

test("the gate is no longer a no-op on a REAL feed (#40)", () => {
  // The previous test only grepped the source for the expansion line, so it
  // passed while the path was dead. This one asserts the gate CHANGES an
  // outcome on real data: with `sub` filtered out, every row is "own" and the
  // gate does nothing at all.
  const withSub = expand(mixedLog().filter(passesFilter));
  const withoutSub = expand(mixedLog().filter((e) => e.type !== "sub"));
  assert.equal(
    withoutSub.every((r) => isOwnLiveWork(r)),
    true,
    "precondition: without `sub` rows the gate is inert (#40)",
  );
  assert.equal(
    withSub.some((r) => !isOwnLiveWork(r)),
    true,
    "with them it must actually gate something (#40)",
  );
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

test("a grandchild's row is attributed to the agent that acted (#40)", () => {
  // The master UNWRAPS a nested mirror before re-emitting it: for an incoming
  // `sub` it takes `inner.sub` as the actor and `inner.type`/`inner.data` as
  // the payload, so a `sub` whose `type` is itself `sub` is never written to
  // any log. A grandchild therefore reaches the top-level parent's feed as a
  // FLAT `sub` row already carrying the grandchild's id.
  //
  // This matters for attribution: the feed must show @grandchild, not the
  // intermediate child, or the operator is told the wrong agent did the work.
  const asMasterWritesIt = { type: "sub", data: { sub: "leaf", type: "message", data: { content: "x" } } };
  const rows = expand([asMasterWritesIt]);
  assert.equal(rows[0]!.data.actor, "leaf", "the acting agent is named (#40)");

  // and the unwrapping is what keeps the log single-level: assert the master
  // does it, so a future change cannot start nesting them
  const master = readFileSync(new URL("../src/master.ts", import.meta.url), "utf8");
  assert.match(
    master,
    /const actor = inner\?\.sub \?\? ac\.id;/,
    "a nested mirror must be re-emitted under the original actor (#40)",
  );
  assert.match(
    master,
    /type: inner\.type, data: inner\.data/,
    "and flattened, so a log never holds a sub-of-a-sub (#40)",
  );
});

/* ---------- wiring: the gate must still be in place ---------- */

test("agentActive consults the provenance gate (#40)", () => {
  assert.match(
    app,
    /agentActive=\{\s*isSelLive\(\) && isOwnLiveWork\(e\)\s*\}/,
    "the gate must survive (#40)",
  );
  assert.match(app, /if \(e\.data\?\.actor\) return \{ name: `@\$\{String\(e\.data\.actor\)\}`/, "and the author must be shown (#40)");
});
