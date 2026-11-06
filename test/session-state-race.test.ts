/**
 * `load()` promised a ready session, but the goal/todo read ran in the background.
 *
 * MEASURED as a CI-only failure of `test/storage.test.ts` ("sibling-prefix ids"): `kernel2.snapshot().sessionDir`
 * matched the expected directory, and `kernel2.goal.text` right after `load()` was `""` instead of the value on disk.
 * A second cause sat underneath it: `loadSessionState()` marked itself loaded BEFORE its first `await`, so a caller
 * arriving during the read got an immediately-resolved promise and still saw the empty goal.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const reply = (content: string): LlmResult => ({ message: { role: "assistant", content } });

test("load() resolves only after the session's goal is restored", async () => {
  await useTempDirs(["ssr-a-", "ssr-b-"], async ([ws, sd]) => {
    const make = () =>
      new Agent({
        id: "race",
        workspace: ws!,
        sessionDir: sd!,
        llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
        chatFn: async (): Promise<LlmResult> => reply("ok"),
        // what Master.addAgent() passes for every booted agent
        deferSessionReads: true,
      } as never) as InstanceType<typeof Agent>;

    const first = make();
    await first.init();
    await first.setGoal("restored from disk");
    await first.dispose();

    const again = make();
    await again.init();
    await again.load();
    assert.equal(again.goal.text, "restored from disk", "load() owns the session state, so the goal is there when it returns");
    await again.dispose();
  });
});

test("a second caller during the read waits for it instead of seeing an empty goal", async () => {
  await useTempDirs(["ssr-c-", "ssr-d-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "race2",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (): Promise<LlmResult> => reply("ok"),
      deferSessionReads: true,
    } as never) as InstanceType<typeof Agent>;
    await a.init();
    await a.setGoal("second caller sees this");
    await a.dispose();

    const b = new Agent({
      id: "race2",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (): Promise<LlmResult> => reply("ok"),
      deferSessionReads: true,
    } as never) as InstanceType<typeof Agent>;
    await b.init();
    /**
     * Two callers in the SAME tick, which is the shape the boolean got wrong: the first sets the flag and starts
     * three awaits, the second used to be handed an already-resolved promise and saw the empty goal. Awaiting the
     * second one is therefore a precise test — it must not resolve before the state is applied.
     */
    const loadState = (b as unknown as { loadSessionState: () => Promise<void> }).loadSessionState.bind(b);
    const first = loadState();
    const second = loadState();
    await second;
    assert.equal(
      b.goal.text,
      "second caller sees this",
      "the in-flight read is shared, so resolving it means the goal is applied — the flag-then-await version resolved early",
    );
    await first;
    await b.dispose();
  });
});
