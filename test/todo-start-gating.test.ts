
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";

import { Master } from "../src/master.ts";
import { buildApp, serveApp } from "../src/server/api.ts";
import { freePort } from "./helpers/free-port.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };
const chatFn = async () => ({ message: { role: "assistant" as const, content: "ok" } });

function post(port: number, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/api/agents/t/todo", method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

async function server() {
  const dataDir = mkdtempInRootSync("t123-");
  const ws = mkdtempInRootSync("t123w-");
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  const app = buildApp(m);
  const agent = await m.addAgent({ id: "t", workspace: ws, chatFn, autoContinue: false }, { persist: false });
  const port = await freePort();
  const httpServer = serveApp(app, port, "127.0.0.1");
  const close = async () => {
    await httpServer.close();
    for (const a of [...m.agents.values()]) a.stop("done");
    for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
  };
  return { m, agent, port, close };
}

test("notify:false saves the list without starting the agent (#123 residual)", async () => {
  const { agent, port, close } = await server();
  try {
    assert.equal(await post(port, { text: "1. do the thing\n2. then this", notify: false }), 200);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(agent.status, "stopped", `notify:false must not boot the agent; got ${agent.status}`);
  } finally {
    await close();
  }
});

test("an EMPTY task list does not start the agent either (#123 residual)", async () => {
  const { agent, port, close } = await server();
  try {
    assert.equal(await post(port, { text: "", notify: true }), 200);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(agent.status, "stopped", "nothing to notify about — no boot (#123 residual)");
  } finally {
    await close();
  }
});

test("a notification-bearing save still starts an idle agent (the fixed #123)", async () => {
  const { agent, port, close } = await server();
  try {
    assert.equal(await post(port, { text: "1. do the thing" }), 200);
    await new Promise((r) => setTimeout(r, 400));
    assert.notEqual(
      agent.status,
      "stopped",
      "the queued prompt must actually wake the agent (#123 original)",
    );
  } finally {
    await close();
  }
});
