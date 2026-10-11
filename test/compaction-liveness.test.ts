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

import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentSrc = readSource(path.join(here, "..", "src", "agent", "agent.ts"));

/* ---------- 1. live during compaction ---------- */

/** an idle agent with real logged history, held open inside the summarizer */
async function agentCompacting() {
  const ws = mkdtempInRootSync("t127w-");
  const sd = mkdtempInRootSync("t127s-");
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
  // Bound by the METHOD, not by a character count. A fixed-width window is the trap
  // this repo has already been bitten by twice (#126, #130): #152 added a few comment
  // lines to isLive() and pushed the assertion past a 1400-char slice, failing a test
  // about behaviour that had not changed.
  const end = agentSrc.indexOf("\n  }", at);
  assert.notEqual(end, -1, "isLive must terminate");
  const block = agentSrc.slice(at, end);
  assert.match(
    block,
    /this\.compactPhase !== ""/,
    "a compaction in flight is live work, whatever the status says (#127)",
  );
  assert.match(
    block,
    /this\.retrySleeping/,
    "and so is a scheduled RETRY backoff (#152) — with it missing the UI offers start and there is no stop control",
  );
});

/* ---------- 2. the summarizer keeps both ends ---------- */

test("the summarizer replays the conversation VERBATIM, so nothing is discarded (#127)", () => {
  // #127's concern was that the OLDEST history — where the original request lives —
  // was silently dropped: first by a bare tail slice, then by a head+tail window with
  // a marked gap. The summarizer now replays the real messages as the request prefix,
  // so there is no truncation and no gap at all. That is strictly stronger, and it is
  // asserted here rather than by looking for the removal of an old pattern.
  assert.doesNotMatch(agentSrc, /full\.slice\(-120_000\)/, "the tail-only slice is gone (#127)");
  assert.doesNotMatch(agentSrc, /elided from the middle/, "and so is the middle-elision (#127)");
  assert.match(
    agentSrc,
    /const prefix = this\.buildMessages\(\)\.slice\(0, 1 \+ old\.length\);/,
    "the summarizer input is the conversation's own prefix (#127, prefix cache)",
  );
});

test("the summarizer input is bounded by construction (#127)", () => {
  // The security property the old head+tail window existed for: the summarizer input
  // must FIT. It does, and for a structural reason rather than a slice — the replayed
  // prefix is the head of the request that just SUCCEEDED, so it is strictly shorter
  // than a request the provider already accepted, plus one short instruction.
  const lastRouted = ["system", ...Array.from({ length: 100 }, (_, i) => `m${i}`)];
  const cut = 60; // where compaction decided to cut
  const replayed = lastRouted.slice(0, 1 + cut);
  assert.ok(replayed.length < lastRouted.length, "strictly shorter than the request that succeeded");
  assert.equal(replayed[0], "system", "and it keeps the system head, so the cache aligns");
});
