import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent, AUTO_CONTINUE_NUDGE, autoContinueNudge } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { dataOf } from "./helpers/event-data.ts";

test("the nudge is prefixed [harness] (#136)", () => {
  assert.ok(
    AUTO_CONTINUE_NUDGE.startsWith("[harness] "),
    `every injected instruction carries the prefix, or the model reads it as operator text (#136): ${AUTO_CONTINUE_NUDGE.slice(0, 40)}`,
  );
});

test("the original instruction survives verbatim (#43)", () => {
  assert.match(
    AUTO_CONTINUE_NUDGE,
    /^\[harness\] Continue working toward the current goal\./,
    "the prefix is prepended, the sentence is unchanged (#43/#136)",
  );
  assert.match(AUTO_CONTINUE_NUDGE, /goalComplete=true/);
  assert.match(AUTO_CONTINUE_NUDGE, /goalComplete=false/);
});

test("the builder restates the goal (#136)", () => {
  const goal = "fix the code based on the current review and release the next version";
  const nudge = autoContinueNudge(goal);
  assert.ok(nudge.startsWith("[harness] "), "still prefixed (#136)");
  assert.ok(nudge.includes(goal), "and names the goal (#136)");
  assert.match(nudge, /Current goal:\n=====/, "with the delimiter the issue asked for (#136)");
  assert.ok(
    nudge.includes(AUTO_CONTINUE_NUDGE),
    "and composes the shared constant rather than restating it (#136)",
  );
});

test("an empty goal falls back to the bare nudge (#136)", () => {
  assert.equal(autoContinueNudge(""), AUTO_CONTINUE_NUDGE);
  assert.equal(autoContinueNudge("   \n "), AUTO_CONTINUE_NUDGE);
});

test("a huge goal is clipped, as the sub-agent nudge's is (#136)", () => {
  const nudge = autoContinueNudge("g".repeat(5000));
  assert.ok(nudge.length < 2000, `must be clipped (#136); got ${nudge.length} chars`);
});

test("the nudge a never-finishing agent receives names the goal (#136)", async () => {
  await useTempDirs(["t136a-", "t136b-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({ message: { role: "assistant" as const, content: "still working" } }),
      autoContinue: true,
      continueDelayMs: 5,
      maxConsecutiveIdleRounds: 3,
    } as never) as Agent;
    await a.init();
    await a.setGoal("fix the code based on the current review and release the next version");
    a.enqueuePrompt("go", "user");
    a.start("t");
    const deadline = Date.now() + 15_000;
    let nudges: Awaited<ReturnType<typeof readEvents>> = [];
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      nudges = (await readEvents(`${sd}/chat.jsonl`)).filter(
        (e) => e.type === "prompt" && dataOf(e).source === "harness",
      );
      if (nudges.length > 0) break;
    }
    try {
      assert.ok(nudges.length > 0, "precondition: the agent was auto-continued (#136)");
      const last = String(dataOf(nudges[nudges.length - 1]!).text ?? "");
      assert.ok(last.startsWith("[harness] "), `the injected nudge must be prefixed (#136); got ${last.slice(0, 40)}`);
      assert.ok(
        last.includes("fix the code based on the current review"),
        "and must name the goal it refers to (#136)",
      );
      assert.match(last, /=====/, "with the delimiter (#136)");
    } finally {
      a.stop("done");
      await a.settled().catch(() => {});
    }
  });
});

