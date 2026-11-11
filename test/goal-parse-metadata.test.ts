/**
 * goal.md's metadata block must not become part of the goal TEXT (#253).
 *
 * "セッションリストアするとgoalが汚染される?" — the reader stripped `status:`/`updated:` only when they sat at the very END of
 * the file, and the writer appends `verify:` AFTER them. So on any goal with a verification contract the strip could not
 * remove anything, and the restored goal ended with `status: paused / updated: …` in its own text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

async function make(ws: string, sd: string, load = false) {
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (): Promise<LlmResult> => ({ message: { role: "assistant", content: "ok" } }),
    autoContinue: false,
  } as never) as InstanceType<typeof Agent>;
  await a.init();
  if (load) await a.load();
  return a;
}

test("a goal with a verification contract survives a restore without its metadata", async () => {
  await useTempDirs(["gp-", "gp-sd-"], async ([ws, sd]) => {
    const first = await make(ws!, sd!);
    await first.setGoal("- root を取る\n- ポーリングしない (通知を待つ)");
    await first.setGoalVerify("npm test passes; the note is in the log");
    await first.setGoalStatus("paused", "operator");
    first.stop("done");

    const second = await make(ws!, sd!, true);
    try {
      const goal = second.goal;
      assert.equal(goal.status, "paused", "the status comes from the metadata block");
      assert.doesNotMatch(goal.text, /status:\s*paused/, `the text must not contain the metadata (#253): ${goal.text}`);
      assert.doesNotMatch(goal.text, /updated:/, `nor the timestamp: ${goal.text}`);
      assert.match(goal.text, /root を取る/, "and the actual goal is intact");
      assert.match(String(goal.verify ?? ""), /npm test passes/, "the contract is parsed, not left in the text");
    } finally {
      second.stop("done");
    }
  });
});

test("a goal whose prose mentions 'status:' keeps it", async () => {
  await useTempDirs(["gp2-", "gp2-sd-"], async ([ws, sd]) => {
    const a = await make(ws!, sd!);
    try {
      await a.setGoal("explain the status: field to the operator");
      const again = await make(ws!, sd!, true);
      try {
        assert.match(again.goal.text, /status: field/, "prose is not metadata — only a real trailing block is stripped");
      } finally {
        again.stop("done");
      }
    } finally {
      a.stop("done");
    }
  });
});
