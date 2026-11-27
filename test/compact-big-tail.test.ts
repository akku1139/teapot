/**
 * A manual `/compact` must not be blocked by ONE big message at the tail (#288).
 *
 * Reported: "さっきフォアグラウンドbash実行中に /compact を実行したら nothing to compact yet が出た … manual compact では Immediate か
 * compact queued の2択しかありえない". The compaction did run later, but the ANSWER said the history had nothing to compact — about a session
 * hundreds of thousands of tokens long.
 *
 * MEASURED: `maybeCompact(force)` walks back from the tail keeping messages that fit in `KEEP_RECENT_TOKENS` (15k) and cuts before
 * them. One message bigger than that window ends the walk on its first step, so `cut` stayed -1 and the function returned without
 * doing anything. A 60KB tool result — the `maxOutputBytes` cap, i.e. an ordinary `bash`/`read_file` output — is about 15k tokens, so
 * this was reachable in any session that had ever read a large file.
 *
 * The cost is not only a wrong message: the AUTOMATIC path takes the same branch, so with a big tail the context grew past its budget
 * and compaction never fired at all.
 *
 * The fix keeps that message and compacts everything BEFORE it — the tail the model is working from is not what needs shrinking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

function agentFor(ws: string, sd: string): Agent {
  return new Agent({
    id: "bigtail",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => ({ message: { role: "assistant", content: "a summary of the work" } }) as never,
  } as never) as Agent;
}

test("a huge tail message does not make a manual compaction a no-op", async () => {
  await useTempDirs(["bt-", "bts-"], async ([ws, sd]) => {
    const a = agentFor(ws!, sd!);
    try {
      await a.init();
      (a as unknown as { messages: unknown[] }).messages = [
        { role: "user", content: "early question ".repeat(200) },
        { role: "assistant", content: "early answer ".repeat(200) },
        { role: "user", content: "second question ".repeat(200) },
        { role: "assistant", content: "second answer ".repeat(200) },
        // ~30k tokens at the tail: more than KEEP_RECENT_TOKENS, i.e. one `bash` result at the output cap
        { role: "user", content: "X".repeat(120_000) },
      ];

      const answer = await a.compactNow();
      assert.equal(
        answer.ran || answer.queued,
        true,
        `the tail blocked the compaction, so /compact answered "nothing to compact yet": ${JSON.stringify(answer)}`,
      );
      assert.equal(answer.ran, true, "an idle agent compacts immediately rather than deferring");
      assert.ok(
        (a as unknown as { stats: { compactions: number } }).stats.compactions > 0,
        "and the compaction actually happened",
      );
    } finally {
      a.stop("done");
      await a.dispose().catch(() => {});
    }
  });
});

test("a tool call/result pair at the tail is never cut (the pair must survive together)", async () => {
  await useTempDirs(["bt2-", "bts2-"], async ([ws, sd]) => {
    const a = agentFor(ws!, sd!);
    try {
      await a.init();
      (a as unknown as { messages: unknown[] }).messages = [
        { role: "user", content: "older ".repeat(400) },
        { role: "assistant", content: "older answer ".repeat(400) },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "Y".repeat(120_000) },
      ];

      const answer = await a.compactNow();
      assert.equal(answer.ran || answer.queued, true, "the tail must not block compaction here either");
      const messages = (a as unknown as { messages: { role: string; tool_call_id?: string; tool_calls?: unknown }[] }).messages;
      const idx = messages.findIndex((m) => m.tool_call_id === "c1");
      assert.ok(idx > 0, "the tool result must still be in the history");
      assert.equal(
        messages[idx - 1]?.tool_calls !== undefined,
        true,
        "cutting between a tool call and its result is what `safeCut` exists to prevent",
      );
    } finally {
      a.stop("done");
      await a.dispose().catch(() => {});
    }
  });
});
