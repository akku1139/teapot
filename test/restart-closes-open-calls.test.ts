import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("runs POSIX commands through the bash tool");

async function restart(
  ws: string,
  sd: string,
  chatFn: (n: number) => unknown,
): Promise<{ calls: number; orphans: string[] }> {
  const first = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => chatFn(1) as never,
    autoContinue: false,
  } as never) as Agent;
  await first.init();
  first.enqueuePrompt("go", "user");
  first.start("t");
  await new Promise((r) => setTimeout(r, 200));
  await (first as unknown as { log: { close(): Promise<void> } }).log.close();

  const second = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
    autoContinue: false,
  } as never) as Agent;
  await second.init();
  await second.load();
  const events = await readEvents(second.log.filePath);
  const calls = events
    .filter((e) => e.type === "tool_call")
    .map((e) => String((e.data as { callId?: unknown })?.callId));
  const results = new Set(
    events.filter((e) => e.type === "tool_result").map((e) => String((e.data as { callId?: unknown })?.callId)),
  );
  await second.dispose();
  return { calls: calls.length, orphans: calls.filter((c) => !results.has(c)) };
}

const issuingBash = () => ({
  message: {
    role: "assistant" as const,
    content: "",
    tool_calls: [
      {
        id: "orphan1",
        type: "function" as const,
        function: { name: "bash", arguments: JSON.stringify({ command: "sleep 0.2" }) },
      },
    ],
  },
});

test("a restart closes a tool call the log left open (#54)", async () => {
  await useTempDirs(["rc1-", "rc2-"], async ([ws, sd]) => {
    const r = await restart(ws!, sd!, issuingBash);
    assert.equal(r.calls, 1, "precondition: the call is in the log (#54)");
    assert.deepEqual(r.orphans, [], `a restart must close what it inherits (#54); got ${JSON.stringify(r.orphans)}`);
  });
});

test("the closing result says the agent restarted (#54)", async () => {
  await useTempDirs(["rc3-", "rc4-"], async ([ws, sd]) => {
    const first = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => issuingBash() as never,
      autoContinue: false,
    } as never) as Agent;
    await first.init();
    first.enqueuePrompt("go", "user");
    first.start("t");
    await new Promise((r) => setTimeout(r, 200));
    await (first as unknown as { log: { close(): Promise<void> } }).log.close();

    const second = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
      autoContinue: false,
    } as never) as Agent;
    await second.init();
    await second.load();
    const events = await readEvents(second.log.filePath);
    const closed = events.find(
      (e) => e.type === "tool_result" && String((e.data as { callId?: unknown })?.callId) === "orphan1",
    );
    assert.ok(closed, "the restored call must be answered (#54)");
    const d = closed!.data as { result?: string; synthesized?: boolean; ok?: boolean };
    assert.equal(d.ok, false, "and reported as not completed (#54)");
    assert.equal(d.synthesized, true, "flagged as synthesized so it is distinguishable from a real result (#54)");
    assert.match(String(d.result), /restart/i, "and the reason must name the restart (#54)");
    await second.dispose();
  });
});

test("a call that ALREADY has a result is left alone (#54)", async () => {
  await useTempDirs(["rc5-", "rc6-"], async ([ws, sd]) => {
    let turn = 0;
    const first = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        turn++;
        if (turn === 1)
          return {
            message: {
              role: "assistant" as const,
              content: "",
              tool_calls: [
                {
                  id: "done1",
                  type: "function" as const,
                  function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) },
                },
              ],
            },
          };
        return { message: { role: "assistant" as const, content: "all done" } };
      },
      autoContinue: false,
      maxTurnsPerRound: 2,
    } as never) as Agent;
    await first.init();
    first.enqueuePrompt("go", "user");
    first.start("t");
    await first.settled();
    await new Promise((r) => setTimeout(r, 100));
    await (first as unknown as { log: { close(): Promise<void> } }).log.close();

    const second = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
      autoContinue: false,
    } as never) as Agent;
    await second.init();
    await second.load();
    const events = await readEvents(second.log.filePath);
    const results = events.filter(
      (e) => e.type === "tool_result" && String((e.data as { callId?: unknown })?.callId) === "done1",
    );
    await second.dispose();
    assert.equal(results.length, 1, `a completed call must not gain a second result (#54); got ${results.length}`);
  });
});
