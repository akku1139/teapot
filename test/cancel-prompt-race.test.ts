/**
 * #108 — cancelling a just-sent prompt silently fails.
 *
 * `enqueuePrompt` pushes into `pendingPrompts` inside an async `.then()` that runs
 * AFTER `ensureReady()` resolves, but `cancelPrompt` reads the array
 * SYNCHRONOUSLY. So a cancel issued before the push lands finds nothing:
 *
 *     cancelPrompt returned: null
 *     pendingPrompts now:    ["TO CANCEL"]
 *
 * The API answers 409, the UI discards the draft, and the message is DELIVERED —
 * the operator sees a withdrawn prompt that the model then acts on.
 *
 * The narrow version needs a same-tick cancel. The realistic one is far worse:
 * with the agent still restoring a 4,000-event session log, `ensureReady()` holds
 * the push for real wall-clock time and the cancel always loses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

function makeAgent(ws: string, sd: string, opts: Record<string, unknown> = {}) {
  return new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
    autoContinue: false,
    ...opts,
  } as never) as Agent;
}

test("a prompt can be cancelled immediately after sending (#108)", async () => {
  await useTempDirs(["c108a-", "c108b-"], async ([ws, sd]) => {
    const a = makeAgent(ws!, sd!);
    await a.init();
    const id = a.enqueuePrompt("TO CANCEL", "user");
    // no await between: this is the tightest realistic window
    const got = a.cancelPrompt(id);
    const queued = (a as unknown as { pendingPrompts: { text: string }[] }).pendingPrompts.map(
      (p) => p.text,
    );
    console.log(`  cancel returned: ${JSON.stringify(got)} | pending: ${JSON.stringify(queued)}`);
    await a.dispose();
    assert.equal(
      got,
      "TO CANCEL",
      `cancelPrompt must return the text so the UI can restore the draft (#108); got ${JSON.stringify(got)}`,
    );
    assert.deepEqual(queued, [], "and the prompt must be gone, not silently delivered (#108)");
  });
});

test("cancelling an unknown id still returns null (#108)", async () => {
  await useTempDirs(["c108c-", "c108d-"], async ([ws, sd]) => {
    const a = makeAgent(ws!, sd!);
    await a.init();
    assert.equal(a.cancelPrompt("nope"), null, "an unknown id must be a no-op (#108)");
    await a.dispose();
  });
});

test("cancelling does not disturb a different prompt (#108)", async () => {
  await useTempDirs(["c108e-", "c108f-"], async ([ws, sd]) => {
    const a = makeAgent(ws!, sd!);
    await a.init();
    const keep = a.enqueuePrompt("KEEP THIS", "user");
    const drop = a.enqueuePrompt("DROP THIS", "user");
    assert.equal(a.cancelPrompt(drop), "DROP THIS", "the right prompt is withdrawn (#108)");
    const queued = (a as unknown as { pendingPrompts: { text: string }[] }).pendingPrompts.map(
      (p) => p.text,
    );
    assert.ok(queued.includes("KEEP THIS"), `the other prompt must survive (#108); got ${JSON.stringify(queued)}`);
    assert.ok(!queued.includes("DROP THIS"), "and the cancelled one must not (#108)");
    assert.ok(keep !== drop, "ids must differ (#108)");
    await a.dispose();
  });
});
