/**
 * A prompt sent while the completion audit runs must be delivered, not stranded (#262 follow-up).
 *
 * The API is the important half: it skipped `start()` when the status was `running`, and during an audit the status IS
 * `running` while the run is about to end. `start()`'s own early return already covers "a round really is in flight", so the
 * caller does not need to guess.
 *
 * `finish(goalComplete)` spends a long time inside its own handler — the audit runs there — and a prompt sent during that window
 * is queued in `pendingPrompts`. The loop then returned straight away on `"end"`, so nothing ever drained that prompt: it stayed
 * queued, the agent stayed `waiting`, and the work never happened. Reported as "audit中にプロンプトを送るとaudit完了してもwaiting
 * ステータスが切れずにデッドロックしてそう".
 *
 * The audit is held open by the fixture so the prompt lands inside the window, which is the timing the report describes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent/agent.ts";
import { useTempDirs } from "./helpers/tmp.ts";

test("a prompt queued during the audit is delivered after it", async () => {
  await useTempDirs(["aud-", "auds-"], async ([ws, sd]) => {
    let call = 0;
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    const agent = new Agent({
      id: "c",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (_c: unknown, messages: unknown[]) => {
        const last = String((messages.at(-1) as { content?: string })?.content ?? "");
        if (/independent completion AUDITOR/.test(last)) {
          await gate;
          return { message: { role: "assistant", content: "APPROVED: ok" } } as never;
        }
        call++;
        if (call === 1)
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "f1", type: "function", function: { name: "finish", arguments: JSON.stringify({ goalComplete: true, summary: "done" }) } },
              ],
            },
          } as never;
        return { message: { role: "assistant", content: "handled your message" } } as never;
      },
      autoContinue: false,
    } as never) as Agent;
    try {
      await agent.init();
      await agent.setGoal("g");
      (agent as unknown as { goal: { verify?: string } }).goal.verify = "must hold";
      agent.enqueuePrompt("go", "user");
      agent.start("t");
      await new Promise((r) => setTimeout(r, 250));

      // the audit is now blocked; this is the reported window
      agent.enqueuePrompt("a message while the audit runs", "user");
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(agent.isLive(), true, "the agent is live while a prompt is queued");

      release({});
      await new Promise((r) => setTimeout(r, 1200));
      const delivered = (agent as unknown as { messages: { content?: string }[] }).messages.some((m) =>
        String(m.content ?? "").includes("while the audit"),
      );
      assert.equal(delivered, true, "the queued prompt must reach the model after the audit");
      assert.equal(agent.isLive(), false, "and nothing is left queued afterwards");
    } finally {
      agent.stop("done");
      await agent.dispose().catch(() => {});
    }
  });
});
