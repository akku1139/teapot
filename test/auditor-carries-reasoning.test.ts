import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent/agent.ts";
import type { ChatMessage, LlmResult } from "../src/agent/llm.ts";
import { useTempDirs } from "./helpers/tmp.ts";

/**
 * The AUDITOR's own conversation must carry reasoning too — the main loop was fixed alone (#187).
 *
 * MEASURED on `mizuki-rakutenai-3-205c7912`: every audit attempt died with
 * `Missing required parameter: 'messages[1].reasoning_content'`. Index 1 IS the auditor's synthetic
 * assistant turn, which `runAuditor` rebuilt from scratch and therefore dropped the thinking it had just
 * received. The audit could never produce a verdict, so the run ended at `audit-unavailable-cap` — which
 * reads to an operator as "the model is too dumb to audit".
 *
 * Both loops now build their turns with `assistantTurn`, so a fourth caller cannot be forgotten.
 */
const finish = (): LlmResult => ({
  message: {
    role: "assistant" as const,
    content: "done",
    tool_calls: [
      { id: "f1", type: "function" as const, function: { name: "finish", arguments: JSON.stringify({ goalComplete: true, summary: "did it" }) } },
    ],
  },
});

test("the auditor's second request carries reasoning_content (#187)", async () => {
  await useTempDirs(["aud-", "audd-"], async ([ws, sd]) => {
    const auditRequests: ChatMessage[][] = [];
    let call = 0;
    const agent = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      chatFn: async (_cfg, messages) => {
        call++;
        const askingAuditor = messages.some((m) => /completion AUDITOR/i.test(String(m.content ?? "")));
        if (askingAuditor) {
          auditRequests.push(messages.map((m) => ({ ...m })));
          // first auditor call asks to read something, so the SECOND carries an assistant turn at index 1
          if (messages.length <= 1) {
            return {
              message: {
                role: "assistant" as const,
                content: "checking the tests",
                tool_calls: [
                  { id: "t1", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: "x" }) } },
                ],
              },
              reasoning: "I must confirm the tests pass before approving",
            };
          }
          return { message: { role: "assistant" as const, content: "VERDICT: APPROVED — looks right" } };
        }
        if (call === 1) return finish();
        return { message: { role: "assistant" as const, content: "waiting" } };
      },
      autoContinue: false,
    });
    await agent.init();
    await agent.setGoal("g");
    (agent as unknown as { goal: { verify?: string } }).goal.verify = "must hold";
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    await Promise.race([agent.settled(), new Promise((r) => setTimeout(r, 8000))]);

    assert.ok(auditRequests.length >= 2, `the auditor must run at least two turns, got ${auditRequests.length}`);
    const second = auditRequests[1]!;
    const assistant = second.filter((m) => m.role === "assistant");
    assert.ok(assistant.length > 0, "the auditor's own turn must be in its history");
    assert.equal(
      assistant[0]!.reasoning,
      "I must confirm the tests pass before approving",
      "dropping it is what made every audit fail with messages[1].reasoning_content",
    );
    await agent.dispose();
  });
});

test("an interrupted partial reply keeps its reasoning too (#187)", async () => {
  /**
   * The third builder: when a turn is stopped mid-stream the partial text was pushed as a bare assistant
   * message while the LOG recorded `reasoning: partial.reasoning` — so the next turn lost it, same shape
   * as the other two.
   */
  await useTempDirs(["int-", "intd-"], async ([ws, sd]) => {
    let seen: ChatMessage[] | null = null;
    let call = 0;
    const agent = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      chatFn: async (_cfg, messages) => {
        call++;
        if (call === 1) {
          // simulate a stop that leaves partial output
          const err = Object.assign(new Error("aborted"), { partial: { text: "half an answer", reasoning: "thought so far" } });
          agent.stop("test");
          throw err;
        }
        seen = messages.map((m) => ({ ...m }));
        return { message: { role: "assistant" as const, content: "ok" } };
      },
      autoContinue: true,
      continueDelayMs: 10,
    });
    await agent.init();
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    for (let i = 0; i < 100 && !seen; i++) await new Promise((r) => setTimeout(r, 30));
    if (seen) {
      const assistant = (seen as ChatMessage[]).filter((m) => m.role === "assistant");
      assert.equal(assistant[0]?.reasoning, "thought so far", "the partial's thinking must survive");
    }
    await agent.dispose();
  });
});
