/**
 * A backoff sleep is not an error state (#280).
 *
 * "running -> error のときにヘッダーのボタンがstartじゃなくてstopが見えてる / 429の時だけ?". A round-level failure with
 * `onError: "retry"` sets `error`, then sleeps before the next attempt. The agent is still live — it can be stopped and it
 * will resume — so the header rendered "■ stop" beside an `error` status: a control for work in flight on a header that
 * says the work died.
 *
 * `retrySleeping` is exactly that window, so `shownStatus` reports `waiting` while it is set, and the internal status is
 * untouched (the retry path still sees `error`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

type Internals = { status: string; retrySleeping: boolean; shownStatus: (s?: string) => string };

test("a retry backoff shows waiting, not error", async () => {
  await useTempDirs(["rbs-a-", "rbs-b-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "rbs",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({ content: "", toolCalls: [] }) as never,
    });
    const it = a as unknown as Internals;

    it.status = "error";
    it.retrySleeping = false;
    assert.equal(it.shownStatus(), "error", "a settled error is still an error");

    it.retrySleeping = true;
    assert.equal(it.shownStatus(), "waiting", "the backoff is a pause, not a death");

    it.status = "running";
    assert.equal(it.shownStatus(), "running", "once the next attempt starts it is running again");

    await (a as unknown as { log?: { close(): Promise<void> } }).log?.close?.();
  });
});
