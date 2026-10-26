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

import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

/** an agent whose LLM always answers the report's 400, so it retries forever */
function retryingAgent(retryDelayMs: number) {
  const ws = mkdtempInRootSync("stop-");
  const sd = mkdtempInRootSync("stops-");
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
  const ws = mkdtempInRootSync("inflight-");
  const sd = mkdtempInRootSync("inflights-");
  let aborted = false;
  /** set the moment the provider call is entered, so the test can POLL instead of sleeping */
  let entered = false;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: (_c: unknown, _m: unknown, _t: unknown, signal?: AbortSignal) =>
      new Promise<LlmResult>((_res, rej) => {
        entered = true;
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
  /**
   * POLL for the in-flight call, do not sleep a fixed 300ms.
   *
   * A loaded CI runner (measured on windows-latest) had not reached the LLM call when the timer
   * expired, so `stop()` arrived before there was anything to abort and the assertion failed with
   * no hint that the test had merely run out of clock.
   */
  const started = Date.now();
  while (!entered && Date.now() - started < 5_000) await new Promise((r) => setTimeout(r, 5));
  assert.ok(entered, "precondition: the LLM call must be in flight before stop() is called");
  const t0 = Date.now();
  a.stop("test stop");
  await a.settled().catch(() => {});
  assert.ok(aborted, "the in-flight call must receive the abort (#152)");
  assert.ok(Date.now() - t0 < 3_000, `stop must return promptly: ${Date.now() - t0}ms`);
  await a.dispose();
});

test("stop() lands even when it arrives BEFORE the backoff sleep is armed (#158 follow-up)", async () => {
  // Reported: "stop ボタンが仕事してない可能性がある / 少なくともLLM APIエラーリトライ中は
  // stopが効かなかった".
  //
  // The existing tests above park the agent AFTER the backoff is armed, which is why
  // they were green while this failed. The gap is the await BEFORE the sleep:
  //
  //     await this.log.append("error-retry", …)   <- stop lands HERE
  //     setStatus("error", "retrying in 60s")
  //     retrySleeping = true
  //     await this.sleepInterruptible(wait)        <- now nothing can cancel it
  //
  // `stop()` releases the sleep through `this.wake`, a SINGLE slot that does not
  // exist until the sleep starts — so a stop inside that window woke nothing, and
  // the sleep it was meant to cancel began afterwards and ran to full term.
  // MEASURED before the fix: TIMEOUT after 6000ms, `status=error`, `live=false`.
  //
  // This is deterministic rather than a race: `log.append` is slowed to model a real
  // disk write, and the stop is issued while that await is provably in flight.
  const ws = mkdtempInRootSync("prearm-");
  const sd = mkdtempInRootSync("prearms-");
  let calls = 0;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (): Promise<LlmResult> => {
      calls++;
      const err = new Error("LLM API error 400: invalid request error") as Error & { status: number };
      err.status = 400;
      throw err;
    },
    autoContinue: false,
    retryDelayMs: 60_000, // long enough that waiting it out is unambiguous failure
    onError: "retry",
  } as never);
  const internals = a as unknown as { maybeCompact(f?: boolean): Promise<void> };
  internals.maybeCompact = async () => {
    throw new Error("LLM API error 400: invalid request error");
  };
  let inAppend = false;
  const log = (a as unknown as { log: { append: (...x: unknown[]) => Promise<unknown> } }).log;
  const origAppend = log.append.bind(log);
  log.append = async (...args: unknown[]) => {
    const data = args[3] as { event?: string } | undefined;
    if (data?.event === "error-retry") {
      inAppend = true;
      await new Promise((r) => setTimeout(r, 1500));
      inAppend = false;
    }
    return origAppend(...args);
  };
  await a.init();
  a.enqueuePrompt("go");
  a.start("t");
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !inAppend) await new Promise((r) => setTimeout(r, 5));
    assert.ok(inAppend, "precondition: the stop must land DURING the pre-sleep await");
    const callsBefore = calls;
    const t0 = Date.now();
    a.stop("user pressed stop");
    await Promise.race([
      a.settled(),
      // 6s is 1/10th of the backoff: settling means it was CANCELLED, not waited out
      new Promise((_, rej) => setTimeout(() => rej(new Error("stop did not settle")), 6_000)),
    ]);
    assert.equal(a.status, "stopped");
    assert.equal(a.isLive(), false);
    assert.ok(Date.now() - t0 < 3_000, `stop must not wait out the backoff: ${Date.now() - t0}ms`);
    assert.equal(calls, callsBefore, "and no attempt may be issued after it");
  } finally {
    await a.dispose();
  }
});

test("stop() lands during the INNER llm-retry staircase, pre-arm window included", async () => {
  // The inner staircase (`llm-retry`, 5s/5s/30s) has the SAME shape as the round
  // backoff — a `log.append` await immediately before the sleep — so it carried the
  // same swallowed-stop window. It is covered by the one fix in
  // `sleepInterruptible`; this pins that, because the report named the LLM API retry
  // path specifically and a future refactor must not reintroduce it here alone.
  const ws = mkdtempInRootSync("inner-");
  const sd = mkdtempInRootSync("inners-");
  let calls = 0;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (): Promise<LlmResult> => {
      calls++;
      const err = new Error("LLM API error 500: upstream unavailable") as Error & { status: number };
      err.status = 500;
      throw err;
    },
    autoContinue: false,
    // onError is NOT "retry": the inner staircase is the only retry in play, so this
    // isolates it from the round-level backoff the tests above cover
    onError: "stop",
  } as never);
  let inAppend = false;
  const log = (a as unknown as { log: { append: (...x: unknown[]) => Promise<unknown> } }).log;
  const origAppend = log.append.bind(log);
  log.append = async (...args: unknown[]) => {
    const data = args[3] as { event?: string } | undefined;
    if (data?.event === "llm-retry") {
      inAppend = true;
      await new Promise((r) => setTimeout(r, 1200)); // the inner window
      inAppend = false;
    }
    return origAppend(...args);
  };
  await a.init();
  a.enqueuePrompt("go");
  a.start("t");
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !inAppend) await new Promise((r) => setTimeout(r, 5));
    assert.ok(inAppend, "precondition: the stop must land during the llm-retry await");
    const callsBefore = calls;
    const t0 = Date.now();
    a.stop("user pressed stop");
    await Promise.race([
      a.settled(),
      // the first inner wait is 5s; 6s would mean it was WAITED OUT, not cancelled
      new Promise((_, rej) => setTimeout(() => rej(new Error("stop did not settle")), 8_000)),
    ]);
    assert.equal(a.status, "stopped");
    assert.equal(a.isLive(), false);
    assert.ok(Date.now() - t0 < 3_000, `stop must not wait out the 5s retry: ${Date.now() - t0}ms`);
    assert.equal(calls, callsBefore, "no further attempt may be issued after a stop");
  } finally {
    await a.dispose();
  }
});
