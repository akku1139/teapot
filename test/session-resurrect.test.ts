/**
 * #39 — "create a new session in the same directory and a deleted session
 *        comes back to life, and you can no longer do anything with it"
 *
 * Sessions were discovered by scanning the sessions directory and sorting by
 * chat.jsonl mtime, and the agent config did not record which session it was
 * bound to. So on boot the master re-guessed by mtime — and a stale or deleted
 * directory whose log happened to be newer won, handing the agent a timeline
 * the operator had already moved off ("resurrected"). The UI then showed the
 * dead session while actions appended to the live one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master, type TeapotConfig } from "../src/master.ts";

function mkConfig(dataDir: string, workspaces: string[] = ["."]): TeapotConfig {
  return {
    port: 0,
    dataDir,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
    providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } },
    defaultProvider: "p",
    agents: workspaces.map((w) => ({ id: "proj", workspace: w, provider: "p" })),
  } as unknown as TeapotConfig;
}

/** make a session dir with a chat.jsonl of the given size, optionally aged */
function seedSession(sessionsRoot: string, id: string, bytes: number, mtimeSec?: number): string {
  const dir = path.join(sessionsRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "chat.jsonl"), "x".repeat(bytes));
  if (mtimeSec !== undefined) utimesSync(path.join(dir, "chat.jsonl"), mtimeSec, mtimeSec);
  return dir;
}

test("a restart reattaches to the RECORDED session, not the newest by mtime (#39)", async () => {
  await useTempDirs(["s39a-", "s39b-"], async ([dataDir, ws]) => {
    const sessionsRoot = path.join(dataDir, "sessions");
    // proj-OLD is the session the operator used and left; proj-NEW is newer on
    // disk but is NOT the one the agent was bound to.
    seedSession(sessionsRoot, "proj-old", 500);
    seedSession(sessionsRoot, "proj-new", 10);

    const cfg = mkConfig(dataDir);
    (cfg.agents[0] as { session?: string }).session = "proj-old"; // recorded

    const m = new Master(cfg, "/dev/null");
    const agent = await m.addAgent({ id: "proj", workspace: ws, provider: "p" }, { persist: false });
    assert.equal(
      agent.snapshot().session,
      "proj-old",
      "must reattach to the recorded session, not the newest dir (#39)",
    );
    await m.stopAllAgents(2_000);
  });
});

test("the recorded session id is persisted so the NEXT boot is deterministic (#39)", async () => {
  await useTempDirs(["s39c-", "s39d-"], async ([dataDir, ws]) => {
    const configPath = path.join(dataDir, "config.json");
    const sessionsRoot = path.join(dataDir, "sessions");
    seedSession(sessionsRoot, "proj-s1", 500);
    const cfg = mkConfig(dataDir);
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const m = new Master(cfg, configPath);
    const agent = await m.addAgent(
      { id: "proj", workspace: ws, provider: "p" },
      { persist: true },
    );
    const bound = agent.snapshot().session;
    assert.equal(bound, "proj-s1");

    // the config file on disk must now record it
    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as {
      agents: { id: string; session?: string }[];
    };
    assert.equal(
      onDisk.agents.find((a) => a.id === "proj")?.session,
      "proj-s1",
      "session id must be persisted (#39)",
    );
    await m.stopAllAgents(2_000);
  });
});

test("a session dir that no longer exists does not resurrect the agent (#39)", async () => {
  await useTempDirs(["s39e-", "s39f-"], async ([dataDir, ws]) => {
    const sessionsRoot = path.join(dataDir, "sessions");
    const gone = seedSession(sessionsRoot, "proj-deleted", 900); // newest on disk
    const cfg = mkConfig(dataDir);
    (cfg.agents[0] as { session?: string }).session = "proj-deleted";
    // the operator deleted it while the tab was open
    rmSync(gone, { recursive: true, force: true });

    const m = new Master(cfg, "/dev/null");
    const agent = await m.addAgent({ id: "proj", workspace: ws, provider: "p" }, { persist: false });
    assert.ok(
      existsSync(path.join(sessionsRoot, agent.snapshot().session)),
      "the bound session dir must actually exist (#39)",
    );
    assert.notEqual(
      agent.snapshot().session,
      "proj-deleted",
      "a deleted session must not be handed back to the agent (#39)",
    );
    await m.stopAllAgents(2_000);
  });
});

test("without a recorded session, discovery still picks a usable dir (#39)", async () => {
  await useTempDirs(["s39g-", "s39h-"], async ([dataDir, ws]) => {
    const sessionsRoot = path.join(dataDir, "sessions");
    seedSession(sessionsRoot, "proj-legacy", 500);
    const cfg = mkConfig(dataDir); // no recorded session — legacy path
    const m = new Master(cfg, "/dev/null");
    const agent = await m.addAgent({ id: "proj", workspace: ws, provider: "p" }, { persist: false });
    assert.ok(
      existsSync(path.join(sessionsRoot, agent.snapshot().session)),
      "legacy discovery must still resolve to a real dir",
    );
    await m.stopAllAgents(2_000);
  });
});

test("a fresh incarnation ignores the recorded session (#39)", async () => {
  await useTempDirs(["s39i-", "s39j-"], async ([dataDir, ws]) => {
    const sessionsRoot = path.join(dataDir, "sessions");
    seedSession(sessionsRoot, "proj-old", 500);
    const cfg = mkConfig(dataDir);
    (cfg.agents[0] as { session?: string }).session = "proj-old";
    const m = new Master(cfg, "/dev/null");
    const agent = await m.addAgent(
      { id: "proj", workspace: ws, provider: "p" },
      { persist: false, fresh: true },
    );
    assert.notEqual(
      agent.snapshot().session,
      "proj-old",
      "a NEW session must not reuse the recorded one (#39)",
    );
    await m.stopAllAgents(2_000);
  });
});
