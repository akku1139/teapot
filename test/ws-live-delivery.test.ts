/**
 * #143 — no test ever opened a WebSocket to the running server.
 *
 * ## The hole this fills
 *
 * The whole product is driven by `/api/ws`: the timeline, the agent list, the
 * live bubble, the notification centre. And the suite could not tell if that
 * socket delivered **nothing at all**.
 *
 * Proven by mutation — deleting the fan-out outright:
 *
 *     bus.on("update", (raw) => { … send(ev); });   //  ← send removed
 *
 * leaves **1206 tests green**. Every event still reaches the JSONL log, every
 * REST route still works, and the UI would simply never update.
 *
 * `test/ws-guards.test.ts` claims to cover this area and is 100% source-shape —
 * it greps `api.ts` for the ping and the reaper. A grep cannot see whether the
 * socket is ever written to, which is the entire question.
 *
 * ## What this does instead
 *
 * Starts a REAL server with `serveApp`, connects a REAL `WebSocket`, and asserts
 * that an event produced by a real Agent arrives on the wire — with its payload
 * intact, since #54 made that payload the timeline's data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { Master } from "../src/master.ts";
import { buildApp, serveApp } from "../src/server/api.ts";
import { freePort } from "./helpers/free-port.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

/** a real HTTP+WS server, with one agent */
async function liveServer() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "t143a-"));
  const ws = mkdtempSync(path.join(os.tmpdir(), "t143w-"));
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  const app = buildApp(m);
  const agent = await m.addAgent({ id: "ev", workspace: ws }, { persist: false });
  const port = await freePort();
  const server = serveApp(app, port, "127.0.0.1");
  // the listening line is printed asynchronously; poll the port instead of racing it
  const base = `ws://127.0.0.1:${port}/api/ws`;
  const stop = async () => {
    await server.close();
    for (const a of [...m.agents.values()]) a.stop("done");
    for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
  };
  return { m, agent, port, base, stop };
}

/** connect and collect frames until `stop` says so */
function collect(base: string, onReady: () => Promise<void>) {
  const frames: Record<string, unknown>[] = [];
  const sock = new WebSocket(base);
  const done = new Promise<void>((resolve, reject) => {
    sock.on("open", () => void onReady().then(resolve, reject));
    sock.on("error", reject);
    sock.on("message", (raw: Buffer) => {
      try {
        frames.push(JSON.parse(raw.toString()));
      } catch {
        /* a non-JSON frame is itself worth seeing, but not fatal */
      }
    });
  });
  return { frames, done, close: () => sock.close() };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the socket opens and is greeted with an authoritative snapshot (#143)", async () => {
  const { base, stop } = await liveServer();
  const c = collect(base, async () => {});
  try {
    await c.done;
    await wait(200);
    const hello = c.frames.find((f) => f.kind === "hello");
    assert.ok(hello, "the server must send a `hello` frame on connect (#143); got " + JSON.stringify(c.frames.map((f) => f.kind)));
    assert.ok(
      Array.isArray((hello as { agents?: unknown[] }).agents),
      "and it must carry the agent snapshot (#143)",
    );
  } finally {
    c.close();
    await stop();
  }
});

test("an event produced by an agent REACHES the socket (#143)", async () => {
  // THE mutation this file exists for: delete `send(ev)` and this fails.
  const { base, agent, stop } = await liveServer();
  const c = collect(base, async () => {
    await agent.enqueuePrompt("hello from the test");
  });
  try {
    await c.done;
    await wait(400);
    const ev = c.frames.find(
      (f) => f.kind === "event" && (f as { event?: { type?: string } }).event?.type === "prompt",
    ) as { event?: { type?: string; data?: { text?: string } } } | undefined;
    assert.ok(
      ev,
      `a prompt event must reach the socket (#143); got frames: ${JSON.stringify(c.frames.map((f) => f.kind))}`,
    );
    // #54 made the payload the timeline's data, so the TEXT has to be on the wire
    assert.equal(
      ev.event?.data?.text,
      "hello from the test",
      `the payload must be intact (#143); got ${JSON.stringify(ev.event?.data)}`,
    );
  } finally {
    c.close();
    await stop();
  }
});

test("a tool_call also reaches the socket (#143)", async () => {
  // a different event type, so the previous test cannot be passing on one branch
  const { base, agent, stop } = await liveServer();
  const c = collect(base, async () => {
    await agent.enqueuePrompt("hi");
  });
  try {
    await c.done;
    await wait(300);
    const kinds = c.frames
      .map((f) => (f as { event?: { type?: string } }).event?.type)
      .filter(Boolean);
    assert.ok(
      kinds.length > 0,
      `at least one event must arrive (#143); frames: ${JSON.stringify(c.frames.map((f) => f.kind))}`,
    );
  } finally {
    c.close();
    await stop();
  }
});

test("two connections each receive the stream (#143)", async () => {
  // the fan-out is per-connection; a single-client test cannot see it collapse
  const { base, agent, stop } = await liveServer();
  const a = collect(base, async () => {});
  const b = collect(base, async () => {});
  try {
    await Promise.all([a.done, b.done]);
    await agent.enqueuePrompt("broadcast me");
    await wait(400);
    for (const [name, c] of [["A", a], ["B", b]] as const) {
      const got = c.frames.some(
        (f) => f.kind === "event" && (f as { event?: { type?: string } }).event?.type === "prompt",
      );
      assert.ok(got, `connection ${name} must receive the broadcast (#143)`);
    }
  } finally {
    a.close();
    b.close();
    await stop();
  }
});

test("a closed socket stops receiving, without harming the others (#143)", async () => {
  const { base, agent, stop } = await liveServer();
  const a = collect(base, async () => {});
  const b = collect(base, async () => {});
  try {
    await Promise.all([a.done, b.done]);
    a.close();
    await wait(200); // let the server observe the close
    await agent.enqueuePrompt("after one left");
    await wait(400);
    assert.ok(
      b.frames.some(
        (f) => f.kind === "event" && (f as { event?: { type?: string } }).event?.type === "prompt",
      ),
      "the surviving connection must still receive events (#143)",
    );
  } finally {
    b.close();
    await stop();
  }
});
