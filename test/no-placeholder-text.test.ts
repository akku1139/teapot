/**
 * `(tool call)` / `(no content)` are REQUEST-BUILDING placeholders and must never reach the log or the wire (#279).
 *
 * Reported as "謎 / Inkling 2 Small が thinking ストリーム中に tool call する?" with a timeline screenshot — a row whose content read like the
 * placeholder. The suspicion was that the harness stores or sends it.
 *
 * MEASURED: it does neither. `sanitize()` substitutes the placeholder only while BUILDING a request, because an OpenAI-compatible
 * server rejects an assistant message with empty content, and `assistantTurn`'s log write strips it back to `""` before appending — so
 * `chat.jsonl` carries `content: ""` with `toolCalls`, which is what the timeline renders as a tool row. Both halves are asserted here,
 * because either one alone would let the other rot: a log write that stopped stripping, or a `buildMessages` path that copied the
 * placeholder back into `this.messages`.
 *
 * A row that already carries the text from an older version is left alone — history is never rewritten.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { readEvents } from "../src/log/events.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const tc = (id: string, name: string) => ({ id, type: "function" as const, function: { name, arguments: "{}" } });

test("an empty assistant turn is stored as empty, and no placeholder is ever sent", async () => {
  await useTempDirs(["ph1-", "ph1b-"], async ([ws, sd]) => {
    let n = 0;
    const sent: unknown[] = [];
    const agent = new Agent({
      id: "ph",
      workspace: ws!,
      sessionDir: sd!,
      autoContinue: false,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (_cfg: unknown, messages: unknown): Promise<LlmResult> => {
        n++;
        // deep copy: the request array is mutated by later turns
        sent.push(JSON.parse(JSON.stringify(messages)));
        if (n === 1) {
          // a turn whose ONLY content is a tool call — the shape the placeholder exists for
          return { message: { role: "assistant", content: "", tool_calls: [tc("c1", "bash")] } };
        }
        if (n === 2) return { message: { role: "assistant", content: "" } }; // no content, no calls
        return { message: { role: "assistant", content: "done" } };
      },
    } as never) as Agent;

    try {
      await agent.init();
      agent.enqueuePrompt("go");
      agent.start("t");
      await agent.settled();

      const disk = JSON.stringify(await readEvents(agent.log.filePath));
      assert.ok(!disk.includes("(tool call)"), "the log must carry an EMPTY content, not the request placeholder");
      assert.ok(!disk.includes("(no content)"), "and not the no-content placeholder either");

      // the assistant turn is still recoverable: empty content WITH its call is how a tool row renders
      const events = await readEvents(agent.log.filePath);
      const assistant = events.filter((e) => e.type === "message" && (e.data as { role?: string }).role === "assistant");
      assert.ok(assistant.length > 0, "the assistant turns must be logged");
      assert.equal(
        (assistant[0]!.data as { content?: string }).content,
        "",
        "an empty-content turn is stored as empty",
      );

      for (const request of sent) {
        const wire = JSON.stringify(request);
        assert.ok(!wire.includes("(tool call)"), `a request carried the placeholder: ${wire.slice(0, 200)}`);
        assert.ok(!wire.includes("(no content)"), `a request carried the no-content placeholder: ${wire.slice(0, 200)}`);
      }
    } finally {
      agent.stop("done");
      await agent.dispose().catch(() => {});
    }
  });
});
