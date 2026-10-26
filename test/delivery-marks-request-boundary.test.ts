import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

interface Ev {
  seq: number;
  type: string;
  data?: Record<string, unknown>;
}

async function drive(
  ws: string,
  sd: string,
  opts: { budget?: number; prefill?: boolean } = {},
): Promise<{ events: Ev[]; calls: number }> {
  let calls = 0;
  const a = new Agent({
    id: "p",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    contextTokenBudget: opts.budget,
    chatFn: async () => {
      calls++;
      return calls > 1 && opts.budget
        ? { message: { role: "assistant" as const, content: "SUMMARY" } }
        : { message: { role: "assistant" as const, content: "ok" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  await a.setGoal("g");
  if (opts.prefill) {
    a.conversationForTest.push({ role: "user", content: "x".repeat(4000) });
    a.conversationForTest.push({ role: "assistant", content: "y".repeat(4000) });
  }
  a.enqueuePrompt("do the thing", "user");
  a.start("t");
  await new Promise((r) => setTimeout(r, 900));
  return { events: (await readEvents(`${sd}/chat.jsonl`)) as Ev[], calls };
}

const deliveredSeq = (evs: Ev[]) =>
  evs.find((e) => e.type === "system_note" && e.data?.event === "prompt-delivered")?.seq ?? -1;
const turnStartSeq = (evs: Ev[]) =>
  evs.find((e) => e.type === "state" && String(e.data?.detail ?? "").includes("llm turn start"))?.seq ?? -1;
const compactionSeq = (evs: Ev[]) => evs.find((e) => e.type === "compaction")?.seq ?? -1;

test("prompt-delivered is recorded when the request starts, not when queued (#37)", async () => {
  await useTempDirs(["t37a-", "t37b-"], async ([ws, sd]) => {
    const { events } = await drive(ws!, sd!);
    const d = deliveredSeq(events);
    const t = turnStartSeq(events);
    assert.notEqual(d, -1, "precondition: the marker is logged (#37)");
    assert.notEqual(t, -1, "precondition: the turn start is logged (#37)");
    assert.ok(
      d > t,
      `the marker must follow the request it describes (#37): delivered seq=${d}, turn start seq=${t}`,
    );
  });
});

test("a compaction request precedes the marker (#37)", async () => {
  await useTempDirs(["t37c-", "t37d-"], async ([ws, sd]) => {
    const { events, calls } = await drive(ws!, sd!, { budget: 400, prefill: true });
    assert.ok(calls > 1, `precondition: compaction must run (#37); calls=${calls}`);
    const c = compactionSeq(events);
    assert.notEqual(c, -1, "precondition: the compaction is logged (#37)");
    const d = deliveredSeq(events);
    assert.ok(d > c, `the marker must follow the compaction request (#37): compaction seq=${c}, delivered seq=${d}`);
  });
});

test("a retry does not move the marker (#37)", async () => {
  await useTempDirs(["t37e-", "t37f-"], async ([ws, sd]) => {
    let calls = 0;
    const a = new Agent({
      id: "p",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("boom"), { name: "ProviderError" });
        return { message: { role: "assistant" as const, content: "ok" } };
      },
      autoContinue: false,
    } as never) as Agent;
    await a.init();
    await a.setGoal("g");
    a.enqueuePrompt("go", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 7_000));
    const events = (await readEvents(`${sd}/chat.jsonl`)) as Ev[];
    const markers = events.filter(
      (e) => e.type === "system_note" && e.data?.event === "prompt-delivered",
    );
    assert.ok(calls >= 2, `precondition: a retry must happen (#37); calls=${calls}`);
    assert.equal(
      markers.length,
      1,
      `one request, one marker (#37); got ${markers.length}`,
    );
  });
});

