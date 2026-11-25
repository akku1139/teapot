/**
 * Which agent owns a session directory — `config.json` answers, and the manifest is only a cache of that answer.
 *
 * Incident this comes from: an accidental in-place `addAgent()` run rewrote 813 manifests to the same bogus owner.
 * Ownership was decided FROM the manifest, so `inferSessionOwner` rejected every directory, `findLatestSessionDir` returned
 * null, boot minted a fresh empty session for all 493 agents and `recordSession` wrote those new pointers into config.json.
 * Nothing warned; the real logs stayed on disk, unreachable.
 *
 * The order of trust is:
 *
 *   1. `config.agents[].session` — the agent states which session it points at, so it answers this exactly;
 *   2. the directory NAME (`<agentId>-<hash>`) — for a directory no agent points at, i.e. an orphan being recovered;
 *   3. the manifest — never. It is a cache of 1 and 2, and it is the thing that got corrupted.
 *
 * MEASURED on the operator's data: 774 pointers, none disagreeing with the directory name; 321 directories no agent points
 * at, 315 of which name a known agent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

/** a data dir laid out like the real one: sessions/<id>/chat.jsonl + session.json */
function sessionDir(dataDir: string, id: string, opts: { log?: boolean; manifest?: unknown }): string {
  const dir = path.join(dataDir, "sessions", id);
  mkdirSync(dir, { recursive: true });
  if (opts.log) writeFileSync(path.join(dir, "chat.jsonl"), oneEvent(1));
  if (opts.manifest !== undefined)
    writeFileSync(path.join(dir, "session.json"), JSON.stringify(opts.manifest));
  return dir;
}

/** one logged line, exactly as EventLog writes it (no id/agent/session/v — those are derived) */
function oneEvent(seq: number): string {
  return (
    JSON.stringify({
      seq,
      ts: "2026-01-01T10:00:00.000Z",
      branch: "br0",
      parent: seq > 1 ? `e${seq - 1}` : null,
      type: "prompt",
      data: { source: "user", text: "hello" },
    }) + "\n"
  );
}

function manifestOf(dataDir: string, sid: string): { agentId?: string } {
  return JSON.parse(readFileSync(path.join(dataDir, "sessions", sid, "session.json"), "utf8")) as {
    agentId?: string;
  };
}

test("the config pointer keeps the history, whatever the manifest says (#143)", async () => {
  await useTempDir("ownfix-", async (dataDir) => {
    const sid = "worker-aaaaaaaa";
    sessionDir(dataDir, sid, { log: true, manifest: { v: 1, agentId: "x" } });
    const m = new Master(
      { port: 0, dataDir, llm: LLM, providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } }, agents: [] },
      path.join(dataDir, "config.json"),
    );
    m.config.agents.push({ id: "worker", workspace: dataDir, provider: "p", session: sid } as never);

    const agent = await m.addAgent(m.config.agents[0]!, { fresh: false });
    assert.equal(
      path.dirname(agent.log.filePath),
      path.join(dataDir, "sessions", sid),
      "the config pointer is the agent's answer; a wrong manifest must not move it",
    );
    assert.equal(m.config.agents[0]!.session, sid, "and the pointer must be left alone");
    assert.equal(manifestOf(dataDir, sid).agentId, "worker", "the stale cache is repaired to agree with it");
    await agent.dispose();
  });
});

test("a MISSING manifest does not abandon history either (#143)", async () => {
  await useTempDir("ownfix-", async (dataDir) => {
    const sid = "worker-bbbbbbbb";
    sessionDir(dataDir, sid, { log: true });
    const m = new Master(
      { port: 0, dataDir, llm: LLM, providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } }, agents: [] },
      path.join(dataDir, "config.json"),
    );
    m.config.agents.push({ id: "worker", workspace: dataDir, provider: "p", session: sid } as never);
    const agent = await m.addAgent(m.config.agents[0]!, { fresh: false });
    assert.equal(path.dirname(agent.log.filePath), path.join(dataDir, "sessions", sid));
    assert.equal(m.config.agents[0]!.session, sid, "the pointer must not move");
    assert.equal(manifestOf(dataDir, sid).agentId, "worker", "and the missing cache is filled in");
    await agent.dispose();
  });
});

test("an ORPHAN directory is attributed by its name, which is how history is recovered (#143)", async () => {
  await useTempDir("ownfix-", async (dataDir) => {
    // no agent points at this session: the directory name is the only evidence left
    const sid = "worker-dddddddd";
    sessionDir(dataDir, sid, { log: true });
    const m = new Master(
      { port: 0, dataDir, llm: LLM, providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } }, agents: [] },
      path.join(dataDir, "config.json"),
    );
    m.config.agents.push({ id: "worker", workspace: dataDir, provider: "p", session: "" } as never);

    const agent = await m.addAgent(m.config.agents[0]!, { fresh: false });
    assert.equal(
      path.dirname(agent.log.filePath),
      path.join(dataDir, "sessions", sid),
      "a session named after the agent is taken back rather than replaced with an empty one",
    );
    await agent.dispose();
  });
});

test("a BARE-name directory is not evidence of ownership — the manifest is", async () => {
  /**
   * `teapot` mints `<agentId>-<hash>`; a bare `<agentId>` directory is the agent's own default dir, which any caller can
   * create, so its name proves nothing. MEASURED as a regression while making config authoritative: a planted
   * `sessions/worker` whose manifest said `{agentId:"impostor"}` was adopted on restart because the name matched.
   */
  await useTempDir("ownfix-", async (dataDir) => {
    const sid = "worker"; // bare: no hash
    sessionDir(dataDir, sid, { log: true, manifest: { v: 1, agentId: "impostor" } });
    const m = new Master(
      { port: 0, dataDir, llm: LLM, providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } }, agents: [] },
      path.join(dataDir, "config.json"),
    );
    m.config.agents.push({ id: "worker", workspace: dataDir, provider: "p", session: "" } as never);

    const agent = await m.addAgent(m.config.agents[0]!, { fresh: false });
    assert.notEqual(
      path.dirname(agent.log.filePath),
      path.join(dataDir, "sessions", sid),
      "a bare name plus a manifest naming someone else is not ours",
    );
    await agent.dispose();
  });
});

test("a session another agent points at is NOT stolen (#39)", async () => {
  await useTempDir("ownfix-", async (dataDir) => {
    const sid = "someoneelse-cccccccc";
    sessionDir(dataDir, sid, { log: true, manifest: { v: 1, agentId: "someoneelse" } });
    const m = new Master(
      { port: 0, dataDir, llm: LLM, providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } }, agents: [] },
      path.join(dataDir, "config.json"),
    );
    // the OTHER agent owns it in config, so `worker` must not take it (and must not rewrite its pointer)
    m.config.agents.push({ id: "someoneelse", workspace: dataDir, provider: "p", session: sid } as never);
    m.config.agents.push({ id: "worker", workspace: dataDir, provider: "p", session: "" } as never);

    const agent = await m.addAgent(m.config.agents[1]!, { fresh: false });
    assert.notEqual(
      path.dirname(agent.log.filePath),
      path.join(dataDir, "sessions", sid),
      "config says it is someone else's",
    );
    assert.equal(manifestOf(dataDir, sid).agentId, "someoneelse", "and its manifest is untouched");
    await agent.dispose();
  });
});
