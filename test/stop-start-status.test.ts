import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

const mk = (ws: string, sd: string, chatFn: unknown) =>
  new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
    chatFn,
    autoContinue: false,
  } as any);

function traceStates(a: Agent): string[] {
  const seen: string[] = [];
  (a as any).log.onEvent = (e: { type: string; data?: { to?: unknown } }) => {
    if (e.type === "state") seen.push(String(e.data?.to));
  };
  return seen;
}

test("a start after a stop does not flash 'stopped' (#86)", async () => {
  await useTempDirs(["s86a-", "s86b-"], async ([ws, sd]) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    const agent = mk(
      ws!,
      sd!,
      async () => {
        n++;
        if (n === 1) await gate;
        return { message: { role: "assistant" as const, content: "ok" } };
      },
    );
    const seen = traceStates(agent);
    await agent.init();
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    await new Promise((r) => setTimeout(r, 40));
    agent.stop("stopped via api");
    agent.start("controls start");
    release();
    await agent.settled();
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(
      !seen.includes("stopped"),
      `a start after a stop must not flash "stopped" (#86); got ${seen.join(" -> ")}`,
    );
    assert.ok(seen.includes("running"), `and it must actually run (#86); got ${seen.join(" -> ")}`);
    await agent.dispose();
  });
});

test("a genuine stop still reports 'stopped' (#86)", async () => {
  await useTempDirs(["s86c-", "s86d-"], async ([ws, sd]) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const agent = mk(ws!, sd!, async () => {
      await gate;
      return { message: { role: "assistant" as const, content: "ok" } };
    });
    await agent.init();
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    await new Promise((r) => setTimeout(r, 40));
    agent.stop("stopped via api");
    release();
    await agent.settled();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(agent.status, "stopped", "a real stop must still land (#86)");
    await agent.dispose();
  });
});

test("stop() with no following start still stops (#86)", async () => {
  await useTempDirs(["s86e-", "s86f-"], async ([ws, sd]) => {
    const agent = mk(ws!, sd!, async () => ({ message: { role: "assistant" as const, content: "ok" } }));
    await agent.init();
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    await agent.settled();
    agent.stop("stopped via api");
    await agent.settled();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(agent.status, "stopped", "the ordinary path is unchanged (#86)");
    await agent.dispose();
  });
});
