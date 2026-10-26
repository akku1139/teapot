import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function sessionDir(dataDir: string, id: string, opts: { log?: string[]; manifest?: unknown }): string {
  const dir = path.join(dataDir, "sessions", id);
  mkdirSync(dir, { recursive: true });
  if (opts.log?.length) writeFileSync(path.join(dir, "chat.jsonl"), opts.log.join("\n") + "\n");
  if (opts.manifest !== undefined)
    writeFileSync(path.join(dir, "session.json"), JSON.stringify(opts.manifest));
  return dir;
}

function loggedEvent(agent: string, session: string, seq = 1): string {
  return JSON.stringify({
    v: 1,
    id: `e${seq}`,
    seq,
    ts: "2026-01-01T10:00:00.000Z",
    agent,
    session,
    branch: "br0",
    parent: null,
    type: "prompt",
    data: { source: "user", text: "hello" },
  });
}

test("a WRONG manifest does not make boot abandon the session's history (#143)", async () => {
  await useTempDir("ownfix-", async (dataDir) => {
    const sid = "worker-aaaaaaaa";
    sessionDir(dataDir, sid, {
      log: [loggedEvent("worker", sid)],
      manifest: { v: 1, agentId: "x" },
    });
    const m = new Master(
      { port: 0, dataDir, llm: LLM, providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } }, agents: [] },
      path.join(dataDir, "config.json"),
    );
    m.config.agents.push({ id: "worker", workspace: dataDir, provider: "p", session: sid } as never);

    const agent = await m.addAgent(m.config.agents[0]!, { fresh: false });
    assert.equal(
      path.dirname(agent.log.filePath),
      path.join(dataDir, "sessions", sid),
      "the log says this dir is `worker`'s — a wrong manifest must not move it",
    );
    assert.equal(
      m.config.agents[0]!.session,
      sid,
      "and the config pointer must be left alone, not rewritten to a new session",
    );
    const repaired = JSON.parse(
      (await import("node:fs")).readFileSync(path.join(dataDir, "sessions", sid, "session.json"), "utf8"),
    );
    assert.equal(repaired.agentId, "worker", "a provably wrong manifest must be repaired");
    await agent.dispose();
  });
});

test("a MISSING manifest does not abandon history either (#143)", async () => {
  await useTempDir("ownfix-", async (dataDir) => {
    const sid = "worker-bbbbbbbb";
    sessionDir(dataDir, sid, { log: [loggedEvent("worker", sid)] }); 
    const m = new Master(
      { port: 0, dataDir, llm: LLM, providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } }, agents: [] },
      path.join(dataDir, "config.json"),
    );
    m.config.agents.push({ id: "worker", workspace: dataDir, provider: "p", session: sid } as never);
    const agent = await m.addAgent(m.config.agents[0]!, { fresh: false });
    assert.equal(path.dirname(agent.log.filePath), path.join(dataDir, "sessions", sid));
    assert.equal(m.config.agents[0]!.session, sid, "the pointer must not move");
    await agent.dispose();
  });
});

test("a genuinely foreign session is still refused (#39)", async () => {
  await useTempDir("ownfix-", async (dataDir) => {
    const sid = "someoneelse-cccccccc";
    sessionDir(dataDir, sid, {
      log: [loggedEvent("someoneelse", sid)],
      manifest: { v: 1, agentId: "someoneelse" },
    });
    const m = new Master(
      { port: 0, dataDir, llm: LLM, providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } }, agents: [] },
      path.join(dataDir, "config.json"),
    );
    m.config.agents.push({ id: "worker", workspace: dataDir, provider: "p", session: sid } as never);
    const agent = await m.addAgent(m.config.agents[0]!, { fresh: false });
    assert.notEqual(
      path.dirname(agent.log.filePath),
      path.join(dataDir, "sessions", sid),
      "a foreign dir must not be adopted",
    );
    assert.notEqual(m.config.agents[0]!.session, sid, "and the pointer must move off it");
    await agent.dispose();
  });
});
