/**
 * Where compaction spends information, and in which order.
 *
 * The operator's report on v0.29.27:
 *
 *   "compactで最初に過去履歴を落としてるけど、デフォルトはcontext window 75%で
 *    auto-compactで、25%余ってるから多分あまりそれする必要ないと思った"
 *
 * Both halves were real:
 *
 *   1. `maybePrune()` ran at the TOP of `maybeCompact()` on EVERY turn, gated at
 *      `budget * 0.6`. The budget is itself 75% of the model's window, so history
 *      was being clipped at **45% of the real window** — well over a quarter was
 *      still free. Pruning is destructive (a clipped tool result leaves the model's
 *      context; the log keeps it, but the model cannot see it without re-issuing the
 *      call), so doing it that early traded information for room nobody needed.
 *   2. Even once over budget, clipping old tool output is the CHEAPEST thing that
 *      can be done — no LLM call, no history rewritten — yet the old code went on to
 *      the summarize/truncate step regardless of whether clipping alone had already
 *      brought the request back under budget.
 *
 * The fix is an ordering: prune only once a pass is genuinely over budget, and if
 * pruning ALONE suffices, stop there.
 *
 * These build the history IN MEMORY rather than through the log: the restore path
 * force-re-prunes (#50), so a seeded log would arrive already clipped and the test
 * would silently measure the load path instead of the compaction pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { mkdtempInRoot } from "./helpers/tmp-root.ts";
import { Agent } from "../src/agent/agent.ts";
import type { ChatMessage, LlmResult } from "../src/agent/llm.ts";
import { readEvents } from "../src/log/events.ts";

const reply = (content: string): LlmResult => ({ message: { role: "assistant", content } });

/**
 * 3 x 6000 chars of tool output. `estimateTokens()` is ~4 chars/token, so the
 * history measures ~4.5k tokens — comfortably over a 2000-token budget, and
 * reclaimable by clipping those three results down to their 400-char heads.
 *
 * The 400-char head is the key number: clipping keeps 400 chars per result, so it
 * can reclaim ~5.6k tokens but never less than ~0.7k, and the protected tail is
 * `budget * 2 = 4000` chars — less than the history, so the early results really
 * are candidates.
 */
const BIG = "Z".repeat(6_000);

/** 3 oversized bash results, then a short turn — the shape pruning targets */
function bigHistory(bigOut: string): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "user", content: "look around" } as ChatMessage];
  for (let i = 1; i <= 3; i++) {
    msgs.push({
      role: "assistant",
      content: "reading",
      tool_calls: [{ id: `c${i}`, type: "function", function: { name: "bash", arguments: "{}" } }],
    } as ChatMessage);
    msgs.push({ role: "tool", tool_call_id: `c${i}`, content: bigOut } as ChatMessage);
  }
  msgs.push({ role: "assistant", content: "done" } as ChatMessage);
  return msgs;
}

const charsOf = (a: Agent) =>
  (a.messages as ChatMessage[]).reduce((n, m) => n + (m.content?.length ?? 0), 0);

const setMessages = (a: Agent, msgs: ChatMessage[]) =>
  ((a as unknown as { messages: ChatMessage[] }).messages = msgs);

/** the `event` field lives on the event's PAYLOAD, not on the envelope */
const eventNames = async (agent: Agent): Promise<string[]> =>
  (await readEvents(agent.log.filePath)).map((e) => String((e as any).data?.event ?? ""));

/** an Agent with no history and a counting chatFn */
async function freshAgent(
  ws: string,
  sessionDir: string,
  budget: number,
  onChat: () => LlmResult,
) {
  const agent = new Agent({
    id: "t",
    workspace: ws,
    sessionDir,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
    chatFn: async () => onChat(),
    contextTokenBudget: budget,
    autoContinue: false,
  } as any);
  await agent.init();
  return agent;
}

test("a context with room left is NOT pruned (#compact-order)", async () => {
  // THE REGRESSION, sized to sit between the two bars.
  //
  // One 6000-char tool result measures ~1500 ESTIMATED TOKENS. Against a 2000-token
  // budget that is:
  //   - over the OLD bar (0.6 * 2000 = 1200)  -> clipped on every single turn
  //   - under the NEW bar (0.95 * 2000 = 1900) -> left alone, because it fits
  //
  // In production the budget is itself 75% of the model's window, so the old 0.6
  // factor clipped at 45% of the real window — precisely the "25%余ってる" the
  // operator saw. Pruning there destroys information (a clipped tool result leaves
  // the model's context; it must re-issue the call to see it again) to buy room
  // that is already free.
  await useTempDirs(["corder-a-", "corder-as-"], async ([ws, sessionDir]) => {
    let chatCalls = 0;
    const agent = await freshAgent(ws!, sessionDir!, 4_000, () => {
      chatCalls++;
      return reply("ok");
    });

    // Two guards have to hold at once, and they pull in opposite directions:
    //   - the oversized result must be OUTSIDE the protected tail, or pruning is not
    //     even a candidate (`budget * 2` chars measured back from the end), and
    //   - the total must stay UNDER the new bar (0.95 of budget), or the pass is
    //     genuinely over budget and pruning is correct.
    // So the budget is 4000: old bar 2400, new bar 3800, protected tail 8000 chars.
    // 3100 chars of result (> PRUNE_MIN's exclusive 3000) + 8200 chars of trailing
    // turns = ~11.3k chars ≈ 3050 estimated tokens — inside (2400, 3800).
    setMessages(agent, [
      { role: "user", content: "look around" } as ChatMessage,
      {
        role: "assistant",
        content: "reading",
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
      } as ChatMessage,
      { role: "tool", tool_call_id: "c1", content: "Z".repeat(3_100) } as ChatMessage,
      ...Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
        content: `turn ${i}: ${"y".repeat(400)}`,
      })),
    ]);

    const before = charsOf(agent);
    const est = (agent as any).contextSizeForBudgeting();
    // PRECONDITIONS that pin the fixture BETWEEN the bars — without these the test
    // could pass on the old code too, by never reaching either threshold.
    assert.ok(
      est > 2_400 && est < 3_800,
      `precondition: the estimate must lie between the old bar (2400) and the new one (3800); got ${est}`,
    );
    const prunable = (agent.messages as any[]).some(
      (m) => m.role === "tool" && String(m.content ?? "").length > 3_000,
    );
    assert.ok(prunable, "precondition: an oversized tool result must be present");

    // CANDIDACY, proved rather than computed. The protected tail is `budget * 2`
    // chars walked back from the END, so whether the result falls inside it depends
    // on the exact fixture; asserting the arithmetic would just restate the source.
    // Instead: a forced prune on a COPY must clip it. If it does not, the result is
    // inside the tail and the assertion below would pass no matter what the bar is.
    // a SEPARATE session dir: the probe writes `context-pruned` to its log, and
    // sharing the agent's would make the assertion below read the probe's own work
    const probeDir = await mkdtempInRoot("corder-a-probe-");
    const probe = new Agent({
      ...(agent as any).opts,
      sessionDir: probeDir,
      chatFn: async () => reply("ok"),
    } as any);
    await probe.init();
    (probe as any).messages = (agent.messages as any[]).map((m) => ({ ...m }));
    const clipped = await (probe as any).maybePrune(true);
    await probe.dispose();
    assert.ok(
      clipped > 0,
      "precondition: the oversized result must be OUTSIDE the protected tail, or nothing could prune it",
    );

    await (agent as any).maybeCompact(false);

    assert.equal(
      charsOf(agent),
      before,
      `a context that FITS must be left alone (was ${before}, became ${charsOf(agent)})`,
    );
    const events = await eventNames(agent);
    assert.ok(
      !events.includes("context-pruned"),
      "nothing may be pruned while there is room — pruning is destructive",
    );
    assert.equal(chatCalls, 0, "and no summarize call may be made either");
    await agent.dispose();
  });
});

test("clipping alone stops the pass — no summarize, no truncate (#compact-order)", async () => {
  // Over budget, and the bulk is re-issuable tool output. Clipping brings the
  // request back under budget, so the pass must STOP: the alternative is paying for
  // a full-history LLM call (or truncating) to reclaim room it already has.
  await useTempDirs(["corder-b-", "corder-bs-"], async ([ws, sessionDir]) => {
    let chatCalls = 0;
    const agent = await freshAgent(ws!, sessionDir!, 2_000, () => {
      chatCalls++;
      return reply("## Current work\nSUMMARY THAT SHOULD NOT BE ASKED FOR");
    });

    setMessages(agent, bigHistory(BIG));
    const before = charsOf(agent);
    assert.ok(before > 18_000, `precondition: fixture must be large; got ${before}`);

    // an AUTO pass — a manual /compact means "write me notes", so it is exempt
    await (agent as any).maybeCompact(false);
    const after = charsOf(agent);

    assert.ok(after < before, `the pass must reclaim room (was ${before}, became ${after})`);

    const events = await eventNames(agent);
    assert.ok(
      events.includes("context-pruned"),
      "old tool output must have been clipped — that is the cheap path",
    );
    assert.ok(
      events.includes("context-pruned-enough"),
      "the pass must RECORD that clipping alone brought it back under budget",
    );
    assert.ok(
      !events.includes("context-compaction-skipped-summarize"),
      "clipping sufficed, so a summarize was never even considered",
    );
    assert.equal(chatCalls, 0, "no LLM call may be made when clipping alone suffices");
    await agent.dispose();
  });
});

test("a MANUAL pass still summarizes even when clipping would suffice (#compact-order)", async () => {
  // `/compact` is the operator asking for notes, not for room. Exempting it keeps
  // the command meaning what it says, and it is the only way to get a checkpoint for
  // a history that is merely bulky rather than overflowing.
  await useTempDirs(["corder-c-", "corder-cs-"], async ([ws, sessionDir]) => {
    let chatCalls = 0;
    const agent = await freshAgent(ws!, sessionDir!, 2_000, () => {
      chatCalls++;
      return reply("## Current work\nlooked around");
    });

    setMessages(agent, bigHistory(BIG));
    await (agent as any).maybeCompact(true);

    assert.ok(chatCalls > 0, "a manual compaction must actually ask the model for notes");
    assert.ok(
      (agent.messages as ChatMessage[]).some((m) =>
        String(m.content ?? "").includes("## Current work"),
      ),
      "the summary must land in the history a manual pass rewrites",
    );
    await agent.dispose();
  });
});

test("short-context mode prunes EARLY, inside the budget (#161)", async () => {
  // #161: "262k tokenとかのモデルを使おうと思ったら積極的な過去tool履歴ドロップとかして
  // いかないと厳しい". The mode must prune while the context still FITS, which is the
  // opposite of what the default path does — so the property to test is that the
  // default leaves the history alone at a size where the short mode clips it.
  await useTempDirs(["corder-sc-", "corder-scs-"], async ([ws, sessionDir]) => {
    // Budget 4000: short mode's bar is 0.6 * 4000 = 2400, so a ~2400-estimate history
    // sits just above it — UNDER the budget (where the default path returns early) and
    // OVER the short bar. That gap is the whole point of the mode.
    const agent = await freshAgent(ws!, sessionDir!, 4_000, () => reply("ok"));
    (agent as any).opts.shortContext = true;

    setMessages(agent, bigHistory("Z".repeat(3_100)));
    const before = charsOf(agent);
    const est = (agent as any).contextSizeForBudgeting();
    assert.ok(
      est > 2_400 && est < 4_000,
      `precondition: the estimate must be between short mode's bar (2400) and the budget (4000); got ${est}`,
    );

    await (agent as any).maybeCompact(false);
    const after = charsOf(agent);

    assert.ok(
      after < before,
      `short mode must prune while there is still room (was ${before}, became ${after})`,
    );
    // and it must be a PRUNE, not a summarize/truncate — no LLM call for this
    const events = await eventNames(agent);
    assert.ok(events.includes("context-pruned"), `expected a prune: ${JSON.stringify(events)}`);
    await agent.dispose();
  });
});

test("the default mode does NOT prune at that same size (#161)", async () => {
  // the control: without the flag, the identical history is left alone. Without this
  // the test above would pass against code that always pruned, which is the bug the
  // earlier fix (#172 line) removed.
  await useTempDirs(["corder-df-", "corder-dfs-"], async ([ws, sessionDir]) => {
    const agent = await freshAgent(ws!, sessionDir!, 4_000, () => reply("ok"));
    setMessages(agent, bigHistory("Z".repeat(3_100)));
    const before = charsOf(agent);
    await (agent as any).maybeCompact(false);
    assert.equal(charsOf(agent), before, "the default mode must leave a fitting context alone");
    const events = await eventNames(agent);
    assert.ok(!events.includes("context-pruned"), "and must emit no prune event");
    await agent.dispose();
  });
});
