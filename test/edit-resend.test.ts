import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

test("after an edit the agent is startable (#96)", async () => {
  await useTempDirs(["er1-", "er2-"], async ([ws, sd]) => {
    let n = 0;
    const agent = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        n++;
        return { message: { role: "assistant" as const, content: `reply ${n}` } };
      },
      autoContinue: false,
    } as never) as Agent;
    await agent.init();
    agent.enqueuePrompt("Q1", "user");
    agent.start("t");
    await agent.settled();
    agent.enqueuePrompt("Q2", "user");
    agent.start("t");
    await agent.settled();
    agent.stop("user stopped it");
    await agent.settled();
    await new Promise((r) => setTimeout(r, 80));

    const events = await readEvents(agent.log.filePath);
    const q1 = events.find((e) => e.type === "prompt" && String((e.data as { text?: string })?.text) === "Q1")!;
    await agent.editPromptAt(q1.id, "Q1-EDITED", "discard");

    agent.start("controls start");
    await agent.settled();
    await new Promise((r) => setTimeout(r, 150));
    assert.notEqual(
      agent.status,
      "stopped",
      `start after an edit must not be refused (#96); status=${agent.status}`,
    );
    await agent.dispose();
  });
});

test("the edited prompt is what the agent is asked to work on (#96)", async () => {
  await useTempDirs(["er3-", "er4-"], async ([ws, sd]) => {
    const seen: string[] = [];
    let n = 0;
    const agent = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (_c: unknown, messages: { content?: string }[]) => {
        for (const m of messages) if (m.content) seen.push(String(m.content));
        n++;
        return { message: { role: "assistant" as const, content: "ok" } };
      },
      autoContinue: false,
      maxTurnsPerRound: 1,
    } as never) as Agent;
    await agent.init();
    agent.enqueuePrompt("ORIGINAL", "user");
    agent.start("t");
    await agent.settled();
    await new Promise((r) => setTimeout(r, 60));
    agent.stop("user");
    await agent.settled();

    const events = await readEvents(agent.log.filePath);
    const first = events.find((e) => e.type === "prompt")!;
    await agent.editPromptAt(first.id, "THE EDITED TEXT", "discard");
    agent.start("edited prompt resent");
    await agent.settled();
    await new Promise((r) => setTimeout(r, 150));

    assert.ok(
      seen.some((c) => c.includes("THE EDITED TEXT")),
      `the agent must be sent the EDITED text (#96)`,
    );
    await agent.dispose();
  });
});
