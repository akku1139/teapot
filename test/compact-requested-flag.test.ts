/**
 * `/compact` is a FLAG, not a queued job (#262).
 *
 * Two reports, one cause: a compaction requested while a turn was in flight was enqueued on the agent's turn chain, so its
 * effect landed at an arbitrary later point with nothing recording that a compaction was pending — a second `/compact`
 * looked like it "did nothing", and the log could not say whether a compaction had been manual or automatic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { useTempDirs } from "./helpers/tmp.ts";

async function mkAgent(ws: string, sd: string) {
  const agent = new Agent({
    id: "c",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => ({ message: { role: "assistant", content: "ok" } }) as never,
  } as never) as Agent;
  await agent.init();
  return agent;
}

test("a compaction asked for during a turn is RECORDED and reported as queued, not as run", async () => {
  await useTempDirs(["crq-", "crqs-"], async ([ws, sd]) => {
    const agent = await mkAgent(ws!, sd!);
    try {
      // pretend a turn is in flight: that is the case the report came from
      (agent as unknown as { status: string }).status = "running";
      const first = await agent.compactNow();
      assert.deepEqual(first, { ran: false, queued: true }, "nothing compacted yet, and the request is pending");
      const second = await agent.compactNow();
      assert.deepEqual(second, { ran: false, queued: true }, "a second request joins the pending one instead of stacking");
      const requested = (agent as unknown as { compactRequested: boolean }).compactRequested;
      assert.equal(requested, true, "the pending request is a FLAG the turn boundary consumes");
    } finally {
      agent.stop("done");
      await agent.dispose().catch(() => {});
    }
  });
});

/**
 * A compaction asked for while the agent is PARKED must run, not wait for a boundary that may be minutes away (#262).
 *
 * `wait_children` suspends the run loop inside `executeTool` for up to an hour, and the flag-and-wait path only runs at a turn
 * boundary — so `/compact` during a wait was accepted and then never fired. `parkedByTool` is the signal: `status === "waiting"`
 * also covers a compaction in progress and the display translation of an idle-but-live agent, and neither is a suspended run.
 */
test("a parked agent (wait_children / a background bash) compacts immediately", async () => {
  await useTempDirs(["crq3-", "crqs3-"], async ([ws, sd]) => {
    const agent = await mkAgent(ws!, sd!);
    try {
      const a = agent as unknown as {
        parkedByTool: boolean;
        status: string;
        messages: { role: string; content: string }[];
        compactedAtLen: number;
        compactRequested: boolean;
        stats: { compactions: number };
        maybeCompact: (force?: boolean) => Promise<void>;
      };
      a.status = "waiting";
      a.parkedByTool = true;
      a.messages.push({ role: "user", content: "some earlier work to compact" });
      a.messages.push({ role: "assistant", content: "and its answer" });
      let forced = 0;
      const realMaybe = a.maybeCompact.bind(agent);
      a.maybeCompact = async (force?: boolean) => {
        if (force) forced++;
        return realMaybe(force);
      };
      const r = await agent.compactNow();
      assert.equal(forced, 1, "the parked agent must compact NOW, not defer to a turn boundary");
      assert.equal(r.queued, false, "and it reports that it ran rather than being queued");
      assert.equal((agent as unknown as { compactRequested: boolean }).compactRequested, false, "no flag is left behind for a boundary that may never come");
    } finally {
      agent.stop("done");
      await agent.dispose().catch(() => {});
    }
  });
});

test("an idle agent compacts immediately and reports that it ran", async () => {
  await useTempDirs(["crq2-", "crqs2-"], async ([ws, sd]) => {
    const agent = await mkAgent(ws!, sd!);
    try {
      agent.enqueuePrompt("hello", "user");
      await new Promise((r) => setTimeout(r, 200));
      const r = await agent.compactNow();
      assert.equal(r.queued, false, "nothing was waiting, so this was not deferred");
    } finally {
      agent.stop("done");
      await agent.dispose().catch(() => {});
    }
  });
});
