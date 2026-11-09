/**
 * A compaction's re-context messages must survive a restart (#227).
 *
 * After a compaction the agent re-attaches memory.md, the goal + todo list, and recently-read files, so the model does
 * not lose what drives the work. Those messages were spliced into `messages` and NEVER logged — so a restore rebuilt the
 * conversation from the log without them: the resumed prompt differed from the one the model last saw, the prefix cache
 * died at the splice point, and the operator paid for the whole conversation again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

test("goal/todo and memory re-attachments are reproduced by a restore", async () => {
  await useTempDirs(["rac-", "rac-sd-"], async ([ws, sd]) => {
    let n = 0;
    const chatFn = async (): Promise<LlmResult> => {
      n += 1;
      return { message: { role: "assistant", content: `reply ${n} ${"z".repeat(700)}` } };
    };
    const mk = async (load = false) => {
      const a = new Agent({
        id: "t",
        workspace: ws!,
        sessionDir: sd!,
        llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
        chatFn,
        // large enough that a compaction actually CUTS (with a tiny budget nothing is kept, so nothing compacts)
        contextTokenBudget: 1_500,
        autoContinue: false,
      } as never) as InstanceType<typeof Agent>;
      await a.init();
      if (load) await a.load();
      return a;
    };

    const first = await mk();
    await first.setGoal("ship the queue fix");
    await first.setTodo("- [ ] fix the label\n- [ ] release");
    for (let i = 0; i < 8; i++) {
      first.enqueuePrompt(`go ${i}`, "user");
      first.start("t");
      await first.settled();
    }
    await first.compactNow();
    const before = JSON.stringify(first.conversation);
    assert.match(before, /re-attached after compaction/, "the run must actually re-attach context");
    first.stop("done");

    const second = await mk(true);
    try {
      assert.equal(
        JSON.stringify(second.conversation),
        before,
        "the restored conversation must contain the re-attached notes — otherwise the prefix cache is dead",
      );
    } finally {
      second.stop("done");
    }
  });
});
