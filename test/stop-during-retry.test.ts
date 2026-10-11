/**
 * #152 — "pressing stop during an error retry does not stop it".
 *
 * MEASURED root cause: the ROUND-level retry backoff sets `status = "error"` while it
 * sleeps ("… — retrying in 60s"), and `error` is deliberately not a live status — so
 * `isLive()` was false, the UI rendered "▶ start", and there was NO stop control at
 * all. The operator pressed what was there and nothing stopped, because nothing could.
 *
 * The INNER retry loop (`llm-retry`, 5s/5s/30s) keeps `status = "running"`, so it was
 * already interruptible; the gap was only the round-level sleep. Measured before the
 * fix: `isLive() === false` mid-backoff. After: `isLive() === true`, stop settles in
 * 0 ms, and no further request is issued.
 *
 * Note on what is NOT the bug, since it is the obvious guess: `stop()` has always
 * called `wake()` and `abort()`, and the sleep itself was always interrupted in ~1 ms.
 * The button simply was not offered.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

/** an agent whose LLM always answers the report's 400, so it retries forever */
function retryingAgent(retryDelayMs: number) {
  const ws = mkdtempSync(path.join(os.tmpdir(), "stop-"));
  const sd = mkdtempSync(path.join(os.tmpdir(), "stops-"));
  let calls = 0;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (): Promise<LlmResult> => {
      calls++;
      const err = new Error(
        'LLM API error 400: {"message":"invalid request error","type":"invalid_request_error"}',
      ) as Error & { status: number };
      err.status = 400;
      throw err;
    },
    autoContinue: false,
    retryDelayMs,
    onError: "retry", // the report's setting: keep going across failures
  } as never) as Agent;
  return { a, calls: () => calls };
}

/**
 * Park the agent in the ROUND-level retry backoff.
 *
 * Reaching it through the inner staircase means waiting out 5s + 5s + 30s of hardcoded
 * production delays, which made these two tests ~40s each. The staircase is not what is
 * under test — the STATE it ends in is — so the failure is injected at the round loop's
 * first seam (`maybeCompact`, which runs at the top of every turn) and the round handler
 * arms the backoff immediately. `sleepInterruptible` is then held open, because that is
 * exactly where a real backoff parks the agent.
 *
 * No production knob is added for this: the injection is entirely on the test side.
 */
async function parkedAgent(retryDelayMs: number) {
  const { a, calls } = retryingAgent(retryDelayMs);
  const internals = a as unknown as {
    maybeCompact(force?: boolean): Promise<void>;
    sleepInterruptible(ms: number): Promise<void>;
  };
  internals.maybeCompact = async () => {
    throw new Error("LLM API error 400: invalid request error");
  };
  // Hold the backoff open, then RELEASE it on stop/dispose. An unresolvable sleep
  // parked the agent so thoroughly that `dispose()` could never drain the run chain and
  // the whole file timed out — the test must be able to clean up after itself.
  let armed = false;
  let release!: () => void;
  internals.sleepInterruptible = async () => {
    armed = true;
    await new Promise<void>((r) => {
      release = r;
    });
  };
  const origStop = a.stop.bind(a);
  a.stop = (reason?: string) => {
    release?.();
    return origStop(reason);
  };
  await a.init();
  a.enqueuePrompt("go");
  a.start("t");
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (armed && a.status === "error") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return { a, calls };
}

test("the round-level retry backoff still offers STOP (#152)", async () => {
  const { a } = await parkedAgent(60_000);
  try {
    assert.equal(
      a.status,
      "error",
      `precondition: parked in the round backoff; got ${a.status} ${a.statusReason}`,
    );
    assert.equal(
      a.isLive(),
      true,
      "an agent waiting to RETRY is work in flight — with isLive() false the UI shows start and there is NO stop control (#152)",
    );
    assert.match(a.statusReason, /retrying/i, "while still showing the operator WHAT failed");
  } finally {
    a.stop("test done");
    await a.settled().catch(() => {});
    await a.dispose();
  }
});

test("stop() during that backoff stops it promptly and for good (#152)", async () => {
  const { a, calls } = await parkedAgent(600_000); // a 10-minute backoff
  try {
    assert.equal(a.status, "error", "precondition: parked");
    const before = calls();
    const t0 = Date.now();
    a.stop("user pressed stop");
    await a.settled().catch(() => {});
    assert.ok(Date.now() - t0 < 3_000, `stop must not wait out a backoff: ${Date.now() - t0}ms`);
    assert.equal(a.status, "stopped");
    assert.equal(calls(), before, "and no attempt may be issued after it");
  } finally {
    await a.dispose();
  }
});

test("stop() also lands mid-call, while the provider is still thinking (#152)", async () => {
  // the other half: a slow request in flight must be aborted, not waited out
  const ws = mkdtempSync(path.join(os.tmpdir(), "inflight-"));
  const sd = mkdtempSync(path.join(os.tmpdir(), "inflights-"));
  let aborted = false;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: (_c: unknown, _m: unknown, _t: unknown, signal?: AbortSignal) =>
      new Promise<LlmResult>((_res, rej) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      }),
    autoContinue: false,
    retryDelayMs: 30_000,
    onError: "retry",
  } as never) as Agent;
  await a.init();
  a.enqueuePrompt("go");
  a.start("t");
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  a.stop("test stop");
  await a.settled().catch(() => {});
  assert.ok(aborted, "the in-flight call must receive the abort (#152)");
  assert.ok(Date.now() - t0 < 3_000, `stop must return promptly: ${Date.now() - t0}ms`);
  await a.dispose();
});
