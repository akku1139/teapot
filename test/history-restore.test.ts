import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { dataOf } from "./helpers/event-data.ts";

function mk(ws: string, sd: string, chatFn: unknown): Agent {
  return new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
    chatFn,
    autoContinue: false,
  } as any);
}
const texts = (a: Agent) => (a.conversation as any[]).map((m) => m.content ?? "").filter(Boolean);

async function converse(a: Agent, prompts: string[]) {
  let n = 0;
  (a as any).opts.chatFn = async () => ({
    message: { role: "assistant" as const, content: `reply${++n}` },
  });
  for (const p of prompts) {
    a.enqueuePrompt(p, "user");
    a.start("t");
    await a.settled();
  }
}

test("editing a prompt: live and restored agree (#69)", async () => {
  await useTempDirs(["h69a-", "h69b-"], async ([ws, sd]) => {
    const a = mk(ws!, sd!, null);
    await a.init();
    await converse(a, ["Q1", "Q2", "Q3"]);

    const events = await readEvents(a.log.filePath);
    const q2 = events.find((e) => e.type === "prompt" && String(dataOf(e).text) === "Q2")!;
    await a.editPromptAt(q2.id, "Q2-EDITED", "discard");
    const live = texts(a);
    await a.dispose();

    const b = mk(ws!, sd!, null);
    await b.init();
    await b.load();
    const restored = texts(b);
    await b.dispose();

    assert.deepEqual(live, ["Q1", "reply1", "Q2-EDITED"], "precondition: the edit dropped the tail");
    assert.deepEqual(
      restored,
      live,
      "RESTORED MUST EQUAL LIVE — the discarded Q2/reply2/Q3/reply3 must not come back (#69)",
    );
  });
});

test("forking: live and restored agree (#69)", async () => {
  await useTempDirs(["h69c-", "h69d-"], async ([ws, sd]) => {
    const a = mk(ws!, sd!, null);
    await a.init();
    await converse(a, ["A", "B", "C"]);
    await a.fork();
    const live = texts(a);
    await a.dispose();

    const b = mk(ws!, sd!, null);
    await b.init();
    await b.load();
    const restored = texts(b);
    await b.dispose();

    assert.equal(live.length, 6, "precondition: the fork inherited the whole history");
    assert.deepEqual(
      restored,
      live,
      "a fork must restore its history — it previously restored an EMPTY list (#69)",
    );
  });
});

test("a fork restores onto the NEW branch, not the old one (#69)", async () => {
  await useTempDirs(["h69e-", "h69f-"], async ([ws, sd]) => {
    const a = mk(ws!, sd!, null);
    await a.init();
    await converse(a, ["A", "B"]);
    const forked = await a.fork();
    await a.dispose();

    const b = mk(ws!, sd!, null);
    await b.init();
    await b.load();
    assert.equal(b.currentBranch, forked.branch, "restore must land on the fork's branch (#69)");
    await b.dispose();
  });
});

test("an edit after a fork still restores exactly (#69)", async () => {
  await useTempDirs(["h69g-", "h69h-"], async ([ws, sd]) => {
    const a = mk(ws!, sd!, null);
    await a.init();
    await converse(a, ["A", "B", "C"]);
    await a.fork();
    a.enqueuePrompt("D", "user");
    a.start("t");
    await a.settled();
    const live = texts(a);
    await a.dispose();

    const b = mk(ws!, sd!, null);
    await b.init();
    await b.load();
    const restored = texts(b);
    await b.dispose();
    assert.deepEqual(restored, live, "fork-then-continue must round-trip (#69)");
  });
});
