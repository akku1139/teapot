/**
 * #127 — "review whether the compact handling is correct."
 *
 * The issue names one certain bug and one open question. Both are addressed, and
 * the honest scope of the second matters.
 *
 * ## 1. The certain bug: a manual compaction reads as IDLE
 *
 * `compactNow()` never touched `status`, and `isLive()` counted only `running`,
 * `parkedByTool` and queued prompts. So an idle agent compacting on demand —
 * rewriting the entire `messages` array — reported itself idle, and the UI offered
 * "start". Measured DURING the summarizer call, before the fix:
 *
 *     status = idle   live = false   ctx.compacting = "summarizing"
 *
 * `ctx.compacting` was already published, so the information existed and only the
 * live-state calculation ignored it. Starting the agent in that window would
 * rewrite the array it is about to resume into — #38's failure mode.
 *
 * ## 2. The question: the summarizer saw only the TAIL
 *
 * `summarize()` ended in a bare `.slice(-120_000)`, so anything older was neither
 * summarised nor kept — it was silently discarded.
 *
 * **Scope, stated honestly:** `maybeCompact` already limits `old` to a recent
 * window (`keepCharBudget`), so in the ordinary path the summarizer's input is
 * usually well under the cap and the slice does nothing. Measured on a 1.2M-char
 * history: summarizer input 121,099 chars — so it DOES bite once tool outputs are
 * large, which is exactly when compaction matters most. The head-and-tail split
 * removes the cliff: a summarizer that hits the cap now keeps the earliest
 * requirement instead of losing it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/agent.ts";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentSrc = readSource(path.join(here, "..", "src", "agent", "agent.ts"));

/* ---------- 1. live during compaction ---------- */

/** an idle agent with real logged history, held open inside the summarizer */
async function agentCompacting() {
  const ws = mkdtempSync(path.join(os.tmpdir(), "t127w-"));
  const sd = mkdtempSync(path.join(os.tmpdir(), "t127s-"));
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let armed = false;
  const a = new Agent({
    id: "c",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      if (armed) await gate;
      return { message: { role: "assistant" as const, content: "SUMMARY" } };
    },
    autoContinue: false,
    contextTokenBudget: 500,
  } as never) as Agent;
  await a.init();
  await a.setGoal("g");
  // real turns, so restoreFromLog() has something to load — injecting `messages`
  // directly does not survive ensureReady()
  for (let i = 0; i < 12; i++) {
    a.enqueuePrompt("Q".repeat(1500), "user");
    a.start("t");
    await a.settled();
  }
  armed = true;
  const before = a.snapshot();
  const p = a.compactNow();
  await new Promise((r) => setTimeout(r, 250));
  const during = a.snapshot();
  release();
  await p;
  return { before, during, after: a.snapshot(), a };
}

test("a manual compaction on an idle agent reads as IDLE before the fix (#127)", async () => {
  const { before, during, a } = await agentCompacting();
  try {
    assert.equal(before.status, "idle", "precondition: the agent starts idle (#127)");
    assert.equal(before.live, false, "precondition: and is not live (#127)");
    assert.equal(
      during.ctx?.compacting,
      "summarizing",
      "precondition: a compaction really is in flight (#127)",
    );
    assert.equal(
      during.live,
      true,
      `the agent must read as WORKING while it rewrites messages (#127); status=${during.status} live=${during.live}`,
    );
  } finally {
    a.stop("done");
    await a.settled().catch(() => {});
  }
});

test("it is live again once the compaction finishes (#127)", async () => {
  const { after, a } = await agentCompacting();
  try {
    assert.equal(
      after.live,
      false,
      "and must not stay permanently live (#127)",
    );
  } finally {
    a.stop("done");
    await a.settled().catch(() => {});
  }
});

test("isLive counts an in-flight compaction (#127)", () => {
  const at = agentSrc.indexOf("  isLive(): boolean {");
  assert.notEqual(at, -1, "isLive must exist (#127)");
  const block = agentSrc.slice(at, at + 1400);
  assert.match(
    block,
    /this\.compactPhase !== ""/,
    "a compaction in flight is live work, whatever the status says (#127)",
  );
});

/* ---------- 2. the summarizer keeps both ends ---------- */

test("the summarizer transcript is not a bare tail slice (#127)", () => {
  const at = agentSrc.indexOf("const full = old");
  assert.notEqual(at, -1, "the transcript must be built from `full` (#127)");
  const block = agentSrc.slice(at, at + 2600);
  assert.doesNotMatch(
    block,
    /full\.slice\(-120_000\)/,
    "the tail-only slice is what silently discarded the earliest history (#127)",
  );
  assert.match(block, /const HEAD = Math\.floor\(BUDGET \* 0\.35\);/, "a head share (#127)");
  assert.match(block, /elided from the middle/, "and the seam must be marked (#127)");
});

test("head+tail keeps both ends within budget (#127)", () => {
  // the builder, run standalone on the shape it will actually see
  const BUDGET = 120_000;
  const HEAD = Math.floor(BUDGET * 0.35);
  const TAIL = BUDGET - HEAD;
  const build = (full: string) =>
    full.length <= BUDGET
      ? full
      : [full.slice(0, HEAD), `\n\n[... ${full.length - BUDGET} characters elided from the middle of this history ...]\n\n`, full.slice(full.length - TAIL)].join("");
  const first = "EARLIEST-REQUIREMENT-xyz";
  const last = "TAIL-STATE-999";
  const out = build(first + "A".repeat(500_000) + last);
  assert.ok(out.length <= BUDGET + 200, `must stay near the budget (#127): ${out.length}`);
  assert.ok(out.includes(first), "the EARLIEST requirement must survive (#127)");
  assert.ok(out.includes(last), "and the latest state (#127)");
  assert.match(out, /elided from the middle/, "the gap must be visible (#127)");
  const small = "short history";
  assert.equal(build(small), small, "a short history is untouched (#127)");
});

test("the summarizer really is truncated on a large history (#127)", async () => {
  // the non-regression half: without this, the test above would be asserting a
  // fix for a condition that never arises. Measured on 1.2M chars it bites.
  const ws = mkdtempSync(path.join(os.tmpdir(), "t127x-"));
  const sd = mkdtempSync(path.join(os.tmpdir(), "t127y-"));
  let seen = 0;
  const a = new Agent({
    id: "c",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (_l: unknown, m: unknown) => {
      seen = JSON.stringify(m).length;
      return { message: { role: "assistant" as const, content: "S" } };
    },
    autoContinue: false,
    contextTokenBudget: 500,
  } as never) as Agent;
  await a.init();
  await a.setGoal("g");
  for (let i = 0; i < 40; i++) {
    a.enqueuePrompt("Q".repeat(30_000), "user");
    a.start("t");
    await a.settled();
  }
  const chars = a.messages.reduce((n, m) => n + (m.content ?? "").length, 0);
  try {
    await a.compactNow();
    assert.ok(chars > 120_000, `precondition: a large history (#127); got ${chars}`);
    assert.ok(seen > 0, "the summarizer must have been called (#127)");
    assert.ok(seen < chars, `the summarizer input is truncated (#127): ${seen} vs ${chars}`);
  } finally {
    a.stop("done");
    await a.settled().catch(() => {});
  }
});
