import test from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { readEvents } from "../src/log/events.ts";
import { executeTool, killBgShells } from "../src/agent/tools.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const dataOf = (e: { data?: unknown }) => (e.data ?? {}) as Record<string, unknown>;
const reply = (content: string): LlmResult => ({ message: { role: "assistant", content } });
/** a round that only writes text counts as an IDLE round, which ends the loop for its own reason */
const work = (id: string): LlmResult => ({
  message: {
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function" as const, function: { name: "get_todo", arguments: "{}" } }],
  },
});

test("a sibling's background job does not suppress THIS agent's auto-continue", async () => {
  /**
   * Raised by a code review: `hasRunningBgShells(cwd)` ignores the owner, so a sub-agent's `sleep 300` in the SHARED
   * workspace suppressed the parent's auto-continue — and the resume path is owner-scoped (`ctx.onBackgroundExit`
   * notifies only the agent that launched the job), so the parent had no way back. `isLive()` already asked the
   * owner-scoped question; the two agent-level sites now agree.
   */
  await useTempDirs(["acbg-", "acbg2-"], async ([ws, sd]) => {
    const other = await executeTool(
      "bash",
      JSON.stringify({ command: "sleep 30", background: true }),
      { cwd: ws!, defaultTimeoutMs: 5_000, maxOutputBytes: 2_000, agentId: "someone-else" } as never,
    );
    assert.ok(other.ok, other.result);

    let turns = 0;
    const a = new Agent({
      id: "me",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (): Promise<LlmResult> => {
        turns += 1;
        return turns < 3 ? work(`t${turns}`) : reply("all done");
      },
      autoContinue: true,
    } as never) as InstanceType<typeof Agent>;
    try {
      await a.init();
      await a.setGoal("keep going");
      a.enqueuePrompt("start", "user");
      a.start("test");
      const deadline = Date.now() + 10_000;
      let events: Awaited<ReturnType<typeof readEvents>> = [];
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        events = await readEvents(`${sd}/chat.jsonl`);
        if (turns >= 3) break;
      }
      assert.ok(turns >= 3, `the agent must keep going past its first stop (turns: ${turns})`);
      assert.equal(
        events.some((e) => e.type === "system_note" && dataOf(e).event === "auto-continue-suppressed"),
        false,
        "another agent's background job must not read as this agent's reason to wait",
      );
    } finally {
      killBgShells(ws!);
      await a.dispose().catch(() => {});
    }
  });
});
