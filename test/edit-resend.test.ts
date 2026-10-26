/**
 * #96 — "edit a message and press fork&resend, but the AI never starts (it does
 * not go running). Starting it from the controls does not work either."
 *
 * The button is labelled "⑂ fork & **resend**". Nothing resent.
 * `editPromptAt` rewrites history and returns; the route returns; the client
 * refreshes and re-selects. The edited prompt sits in the timeline looking sent
 * while the model has never seen it, and the only way forward is to notice that
 * and press start yourself.
 *
 * `start()` is called on the SERVER rather than the client: the route already
 * knows the edit succeeded, and a client that simply failed to call it would
 * leave the agent silently idle with no error anywhere to explain why.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

test("after an edit the agent is startable (#96)", async () => {
  // the second symptom from the report. editPromptAt REFUSES while the agent is
  // running, so the edit happens from a stopped agent — and in that state the
  // controls' start already worked. Pinned so a future change that leaves a
  // stale "running" status after the edit cannot silently reintroduce it.
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
    await agent.editPromptAt(q1.id, "Q1-EDITED");

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
  // the point of "resend": the model must SEE the edit, not the original
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
    await agent.editPromptAt(first.id, "THE EDITED TEXT");
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
