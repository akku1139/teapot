import { test } from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

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
    onError: "retry", 
  } as never) as Agent;
  return { a, calls: () => calls };
}

async function parkedAgent(retryDelayMs: number) {
  const { a, calls } = retryingAgent(retryDelayMs);
  const internals = a as unknown as {
    maybeCompact(force?: boolean): Promise<void>;
    sleepInterruptible(ms: number): Promise<void>;
  };
  internals.maybeCompact = async () => {
    throw new Error("LLM API error 400: invalid request error");
  };
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
  const { a, calls } = await parkedAgent(600_000); 
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
  const ws = mkdtempInRootSync("inflight-");
  const sd = mkdtempInRootSync("inflights-");
  let aborted = false;
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
    retryDelayMs: 60_000, 
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
    onError: "stop",
  } as never);
  let inAppend = false;
  const log = (a as unknown as { log: { append: (...x: unknown[]) => Promise<unknown> } }).log;
  const origAppend = log.append.bind(log);
  log.append = async (...args: unknown[]) => {
    const data = args[3] as { event?: string } | undefined;
    if (data?.event === "llm-retry") {
      inAppend = true;
      await new Promise((r) => setTimeout(r, 1200)); 
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
