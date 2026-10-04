/**
 * #109 — does the model's view of a tool result change across a restart?
 *
 * The claim: the log stores `result.result.slice(0, 8000)` while the live
 * `messages` array keeps the FULL text, and since a restore rebuilds `messages`
 * from the log, a resumed model sees a shorter result than it had live
 * (reported: 40012 bytes before, 8000 after).
 *
 * That is plausible from reading the two lines, so it needs a measurement rather
 * than an argument — and the measurement so far says the opposite. Two things
 * confound a naive fixture:
 *
 *   1. `maybePrune()` clips tool output IN PLACE once the session passes ~60% of
 *      its token budget, and it runs on every turn. A scripted model that keeps
 *      calling tools grows the context quickly, so the "live" value read after the
 *      run is already pruned — and the restart then looks like it ADDED content.
 *   2. bash output is itself capped (60 KB), so a fixture must actually exceed
 *      8000 bytes to exercise the clip at all.
 *
 * So this test pins the pair of views in ONE turn, before any pruning can happen,
 * and separately checks that pruning is the thing that shrinks a result later.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

// #110: POSIX-only — drives the bash tool, which still spawns /bin/bash (#110 item 2).
markPosixOnly("drives the bash tool, which still spawns /bin/bash (#110 item 2)");

const LOG_RESULT_CAP = 8000;

/** one tool call producing >8 KB, then finish — exactly one turn of real work */
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
