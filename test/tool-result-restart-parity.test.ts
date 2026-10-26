import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("drives the bash tool, which still spawns /bin/bash (#110 item 2)");

const LOG_RESULT_CAP = 8000;

function bigThenFinish() {
  let n = 0;
  return async () => {
    n++;
    if (n === 1)
      return {
        message: {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            {
              id: "big1",
              type: "function" as const,
              function: {
                name: "bash",
                arguments: JSON.stringify({
                  command: `for i in $(seq 1 900); do printf "line %s aaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n" $i; done`,
                }),
              },
            },
          ],
        },
      };
    return {
      message: {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "f1",
            type: "function" as const,
            function: { name: "finish", arguments: JSON.stringify({ goalComplete: true, summary: "done" }) },
          },
        ],
      },
    };
  };
}

function opts(ws: string, sd: string, chatFn: unknown) {
  return {
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: chatFn as never,
    autoContinue: false,
  };
}

test("the live tool result and the logged one are the SAME length (#109)", async () => {
  await useTempDirs(["r109a-", "r109b-"], async ([ws, sd]) => {
    const a = new Agent(opts(ws!, sd!, bigThenFinish()) as never) as Agent;
    await a.init();
    await a.setGoal("g");
    a.enqueuePrompt("go", "user");
    a.start("t");
    await a.settled();
    await new Promise((r) => setTimeout(r, 120));

    const live = (a as unknown as { messages: { role: string; content?: string }[] }).messages.find(
      (m) => m.role === "tool",
    );
    const events = await readEvents(`${sd}/chat.jsonl`);
    const logged = String(
      (events.find((e) => e.type === "tool_result")?.data as { result?: string })?.result ?? "",
    );
    const liveLen = (live?.content ?? "").length;
    console.log(`  live=${liveLen} logged=${logged.length}`);
    await (a as unknown as { log: { close(): Promise<void> } }).log.close();

    assert.ok(liveLen > 400, `precondition: the fixture must exceed the prune floor (#109); got ${liveLen}`);
    assert.ok(logged.length > 400, `precondition: the log must hold a real result (#109); got ${logged.length}`);
    assert.equal(
      liveLen,
      logged.length,
      `a restart must not change what the model sees (#109): live ${liveLen} vs logged ${logged.length}`,
    );
  });
});

test("both views respect the 8000-byte log clip (#109)", async () => {
  await useTempDirs(["r109c-", "r109d-"], async ([ws, sd]) => {
    const a = new Agent(opts(ws!, sd!, bigThenFinish()) as never) as Agent;
    await a.init();
    await a.setGoal("g");
    a.enqueuePrompt("go", "user");
    a.start("t");
    await a.settled();
    await new Promise((r) => setTimeout(r, 120));
    const live = String(
      (a as unknown as { messages: { role: string; content?: string }[] }).messages.find(
        (m) => m.role === "tool",
      )?.content ?? "",
    );
    const events = await readEvents(`${sd}/chat.jsonl`);
    const logged = String(
      (events.find((e) => e.type === "tool_result")?.data as { result?: string })?.result ?? "",
    );
    await (a as unknown as { log: { close(): Promise<void> } }).log.close();
    console.log(`  live=${live.length} logged=${logged.length} cap=${LOG_RESULT_CAP}`);
    assert.ok(live.length <= LOG_RESULT_CAP, `the live view must obey the clip (#109); got ${live.length}`);
    assert.ok(logged.length <= LOG_RESULT_CAP, `the log must obey the clip (#109); got ${logged.length}`);
  });
});

test("a restart replays the tool result unchanged (#109)", async () => {
  await useTempDirs(["r109e-", "r109f-"], async ([ws, sd]) => {
    const a = new Agent(opts(ws!, sd!, bigThenFinish()) as never) as Agent;
    await a.init();
    await a.setGoal("g");
    a.enqueuePrompt("go", "user");
    a.start("t");
    await a.settled();
    const live = String(
      (a as unknown as { messages: { role: string; content?: string }[] }).messages.find(
        (m) => m.role === "tool",
      )?.content ?? "",
    );
    await (a as unknown as { log: { close(): Promise<void> } }).log.close();

    const b = new Agent(opts(ws!, sd!, async () => ({ message: { role: "assistant" as const, content: "ok" } })) as never) as Agent;
    await b.init();
    await b.load();
    const after = String(
      (b as unknown as { messages: { role: string; content?: string }[] }).messages.find(
        (m) => m.role === "tool",
      )?.content ?? "",
    );
    await b.dispose();
    console.log(`  live=${live.length} afterRestart=${after.length}`);
    assert.equal(after.length, live.length, `a restart must not shorten the result (#109)`);
  });
});
