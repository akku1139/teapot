/**
 * A compaction must never summarise away a call whose result has not arrived (#262).
 *
 * `/compact` now runs while the agent is PARKED on a tool (`wait_children`, a background bash), which means the last assistant
 * message carries a `tool_calls` entry with no `role:"tool"` reply yet. The reply is appended by the run loop after the
 * compaction finishes, so cutting that message away produces an orphan tool message and the provider rejects the next request
 * ("tool message not directly after its assistant turn").
 *
 * The rule is checked through the real `maybeCompact` path, because the invariant that matters is what ends up in
 * `this.messages` — not the return value of a helper.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent/agent.ts";
import { useTempDirs } from "./helpers/tmp.ts";

test("a pending tool call survives a forced compaction", async () => {
  await useTempDirs(["scut-", "scuts-"], async ([ws, sd]) => {
    const agent = new Agent({
      id: "c",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      // the summarizer: a plain summary, so the pass succeeds
      chatFn: async () => ({ message: { role: "assistant", content: "SUMMARY: earlier work" } }) as never,
    } as never) as Agent;
    try {
      const a = agent as unknown as {
        messages: {
          role: string;
          content?: string;
          tool_call_id?: string;
          tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
        }[];
        parkedByTool: boolean;
        status: string;
        compactedAtLen: number;
      };
      await agent.init();
      /**
       * The pending call sits EARLY, with a long history after it — the shape that makes the cut walk past it. A call at the very
       * end would always be kept by the tail budget, which is why the first version of this test passed without the guard.
       */
      a.messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{ id: "pending-1", type: "function", function: { name: "wait_children", arguments: "{}" } }],
      });
      for (let i = 0; i < 200; i++) {
        a.messages.push({ role: "user", content: `later message ${i} ${"padding ".repeat(40)}` });
        a.messages.push({ role: "assistant", content: `reply ${i} ${"padding ".repeat(40)}` });
      }
      a.parkedByTool = true;
      a.status = "waiting";
      const cut = (agent as unknown as { safeCut: (n: number) => number }).safeCut(a.messages.length - 1);
      assert.equal(cut <= 0, true, `the cut must not pass the unanswered call (got ${cut})`);
    } finally {
      agent.stop("done");
      await agent.dispose().catch(() => {});
    }
  });
});
