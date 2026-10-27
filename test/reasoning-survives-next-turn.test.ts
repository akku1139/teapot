import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { useTempDirs } from "./helpers/tmp.ts";
import { waitFor } from "./helpers/wait-for.ts";

/**
 * The thinking a model produces must still be there on the NEXT turn (#187).
 *
 * Sending `reasoning_content` is only half the fix: the message pushed into the agent's own history has
 * to carry it too. MEASURED: `res.reasoning` went to the log for the timeline while
 * `this.messages.push(m)` stored a message without it, so the second request — built from that
 * history — had no reasoning to send back and Beam rejected it with 400.
 */
test("the second request carries the first turn's reasoning (#187)", async () => {
  await useTempDirs(["rsn-", "rsnd-"], async ([ws, sd]) => {
    const seen: { role: string; reasoning_content?: string }[][] = [];
    let call = 0;
    const agent = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      chatFn: async (_cfg, messages) => {
        call++;
        seen.push(messages as never);
        if (call === 1) {
          // a TOOL CALL is what forces a second request in the same round
          return {
            message: {
              role: "assistant" as const,
              content: "thinking about it",
              tool_calls: [
                { id: "c1", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: "x.txt" }) } },
              ],
            },
            reasoning: "I need to inspect the parser before answering",
          };
        }
        return { message: { role: "assistant" as const, content: "done" } };
      },
      autoContinue: true,
      continueDelayMs: 10,
    });
    await agent.init();
    agent.enqueuePrompt("look at the parser", "user");
    agent.start("t");
    await waitFor(() => seen.length >= 2, { what: "a second LLM call" });

    const history = seen[1]!;
    const assistant = history.filter((m) => m.role === "assistant");
    assert.ok(assistant.length > 0, "the first turn must be in the history");
    /**
     * `chatFn` sees the INTERNAL shape; `sanitize()` turns `reasoning` into `reasoning_content` on the
     * wire (covered by test/reasoning-content-sent-back.test.ts). What matters here is that the history
     * the agent builds still HAS it — dropping it at push time is what broke #187.
     */
    assert.equal(
      (assistant[0] as { reasoning?: string }).reasoning,
      "I need to inspect the parser before answering",
      "the thinking must ride along, or a provider that requires it rejects the turn",
    );
    await agent.dispose();
  });
});

test("restoring from the log keeps the reasoning (#187)", async () => {
  await useTempDirs(["rsn2-", "rsn2d-"], async ([ws, sd]) => {
    // a session whose log recorded reasoning, as every session does
    await fs.mkdir(sd!, { recursive: true });
    await fs.writeFile(
      path.join(sd!, "chat.jsonl"),
      [
        { v: 1, id: "e1", seq: 1, ts: "2026-01-01T00:00:00Z", agent: "t", session: "s", branch: "br0", type: "prompt", data: { source: "user", text: "go" } },
        { v: 1, id: "e2", seq: 2, ts: "2026-01-01T00:00:01Z", agent: "t", session: "s", branch: "br0", type: "message", data: { role: "assistant", content: "answered", reasoning: "the thinking from before" } },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    let history: { role: string; reasoning_content?: string }[] | null = null;
    const agent = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      chatFn: async (_c, messages) => {
        history = messages as never;
        return { message: { role: "assistant" as const, content: "ok" } };
      },
      autoContinue: false,
    });
    await agent.init();
    agent.enqueuePrompt("again", "user");
    agent.start("t");
    await waitFor(() => history !== null, { what: "the restored request" });
    const assistant = history!.filter((m) => m.role === "assistant");
    assert.equal(
      (assistant[0] as { reasoning?: string } | undefined)?.reasoning,
      "the thinking from before",
      "a restored session must rebuild it too, or every resumed conversation 400s",
    );
    await agent.dispose();
  });
});
