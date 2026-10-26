/**
 * #105 — "tool calls execute AFTER finish() reports completion".
 *
 * The `finish` branch in the tool-call loop ended with `continue`, which advances
 * that loop — not the turn loop. So every later call in the SAME assistant
 * message still ran. A model emitting `finish()` plus one more tool call got real
 * filesystem writes after it had reported `final: true` and the goal was already
 * `done`, so a parent was told the work was finished while the workspace was
 * still being mutated.
 *
 * Reproduced before the fix: the event order was
 *
 *     FINAL at index 8 | write_file result at index 12 | after.txt exists? true
 *
 * The fix answers whatever is still outstanding and leaves the tool loop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

interface Ev {
  id: string;
  type: string;
  data?: Record<string, unknown>;
}

async function runFinishThenTool(ws: string, sd: string) {
  let call = 0;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      call++;
      if (call === 1)
        return {
          message: {
            role: "assistant" as const,
            content: "",
            tool_calls: [
              {
                id: "f1",
                type: "function" as const,
                function: {
                  name: "finish",
                  arguments: JSON.stringify({ goalComplete: true, summary: "DONE" }),
                },
              },
              {
                id: "w1",
                type: "function" as const,
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "after.txt", content: "written AFTER finish" }),
                },
              },
            ],
          },
        };
      return { message: { role: "assistant" as const, content: "ok" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  await a.setGoal("g");
  a.enqueuePrompt("go", "user");
  a.start("t");
  await a.settled();
  await new Promise((r) => setTimeout(r, 150));
  const events = (await readEvents(a.log.filePath)) as Ev[];
  await a.dispose();
  return { events, wrote: existsSync(path.join(ws, "after.txt")) };
}

test("no tool runs after finish() reports the goal complete (#105)", async () => {
  await useTempDirs(["f105a-", "f105b-"], async ([ws, sd]) => {
    const { events, wrote } = await runFinishThenTool(ws!, sd!);
    assert.equal(wrote, false, "write_file ran AFTER finish() — the goal was already done (#105)");
    const finalIdx = events.findIndex(
      (e) => e.type === "message" && e.data?.final === true,
    );
    const writeIdx = events.findIndex(
      (e) => e.type === "tool_call" && e.data?.name === "write_file",
    );
    assert.ok(finalIdx !== -1, "the finish summary must still be logged (#105)");
    assert.equal(writeIdx, -1, `write_file must not be called at all (#105); was at index ${writeIdx}`);
  });
});

test("every tool_call is still answered, so the next request is valid (#105)", async () => {
  // #76: an assistant tool_call with no tool_result makes the provider reject the
  // next request. Ending the batch early must not reintroduce that.
  await useTempDirs(["f105c-", "f105d-"], async ([ws, sd]) => {
    const { events } = await runFinishThenTool(ws!, sd!);
    const calls = events
      .filter((e) => e.type === "tool_call")
      .map((e) => String(e.data?.callId ?? ""));
    const results = new Set(
      events.filter((e) => e.type === "tool_result").map((e) => String(e.data?.callId ?? "")),
    );
    const orphans = calls.filter((c) => c && !results.has(c));
    assert.deepEqual(orphans, [], `unanswered tool_calls break the next request (#105/#76)`);
  });
});

test("finish() alone still works normally (#105)", async () => {
  // the fix must not break the ordinary single-call path
  await useTempDirs(["f105e-", "f105f-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({
        message: {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            {
              id: "f1",
              type: "function" as const,
              function: {
                name: "finish",
                arguments: JSON.stringify({ goalComplete: true, summary: "ALL DONE" }),
              },
            },
          ],
        },
      }),
      autoContinue: false,
    } as never) as Agent;
    await a.init();
    await a.setGoal("g");
    a.enqueuePrompt("go", "user");
    a.start("t");
    await a.settled();
    const events = (await readEvents(a.log.filePath)) as Ev[];
    await a.dispose();
    const final = events.find((e) => e.type === "message" && e.data?.final === true);
    assert.ok(final, "the finish summary must be logged (#105)");
    assert.equal(a.goal.status, "done", "the goal must still be marked done (#105)");
  });
});
