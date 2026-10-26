import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { Master, type AgentConfig } from "../src/master.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

function cfg(dataDir: string, n = 4): { path: string; agents: AgentConfig[] } {
  const ws = path.join(dataDir, "ws");
  mkdirSync(ws, { recursive: true });
  const agents: AgentConfig[] = Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    provider: "p",
    workspace: ws,
    session: `gone-${i}`, 
  }));
  const p = path.join(dataDir, "config.json");
  writeFileSync(
    p,
    JSON.stringify(
      { agents, providers: { p: { baseUrl: "http://x" } }, defaultProvider: "p", tasks: [] },
      null,
      2,
    ),
  );
  return { path: p, agents };
}

function master(cfgPath: string, dataDir: string, agents: AgentConfig[]): Master {
  return new Master(
    {
      port: 0,
      dataDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      providers: { p: { baseUrl: "http://x" } } as never,
      agents,
    },
    cfgPath,
  );
}

test("saveConfig leaves a complete, parseable file (#144)", async () => {
  const dataDir = mkdtempInRootSync("t144a-");
  const { path: p, agents } = cfg(dataDir, 5);
  const m = master(p, dataDir, agents);
  m.saveConfig();
  const body = readFileSync(p, "utf8");
  assert.ok(body.length > 0, "config.json must never be empty after a save (#144)");
  const parsed = JSON.parse(body) as { agents?: unknown[] };
  assert.equal(parsed.agents?.length, 5, "and must parse back to the full agent list (#144)");
});

test("the write is atomic — a new inode, not an in-place rewrite (#144)", async () => {
  const dataDir = mkdtempInRootSync("t144b-");
  const { path: p, agents } = cfg(dataDir, 3);
  const m = master(p, dataDir, agents);
  const before = statSync(p).ino;
  m.saveConfig();
  assert.notEqual(
    statSync(p).ino,
    before,
    "the save must land via rename, so no window exists in which the file is empty (#144)",
  );
});

test("no temp files are left behind (#144)", async () => {
  const dataDir = mkdtempInRootSync("t144c-");
  const { path: p, agents } = cfg(dataDir, 3);
  const m = master(p, dataDir, agents);
  m.saveConfig();
  m.saveConfig();
  const leftovers = readdirSync(dataDir).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, [], `a crashed write would leave these behind (#144): ${leftovers}`);
});

test("booting N agents performs ONE write, not N (#144)", async () => {
  const dataDir = mkdtempInRootSync("t144d-");
  const _ws = mkdtempInRootSync("t144w-");
  const { path: p, agents } = cfg(dataDir, 6);
  const m = master(p, dataDir, agents);

  let writes = 0;
  let last = statSync(p).ino;
  const realWrite = (m as unknown as { writeConfigAtomic(b: string): void }).writeConfigAtomic.bind(m);
  (m as unknown as { writeConfigAtomic(b: string): void }).writeConfigAtomic = (b: string) => {
    realWrite(b);
    const ino = statSync(p).ino;
    if (ino !== last) {
      writes++;
      last = ino;
    }
  };

  await m.start();
  for (const a of [...m.agents.values()]) a.stop("done");
  for (const a of [...m.agents.values()]) await a.settled().catch(() => {});

  assert.ok(
    writes <= 1,
    `boot must persist config ONCE, not once per agent (#144); saw ${writes} writes for 6 agents`,
  );
  assert.ok(writes >= 1, "but it must still persist, or the boot would be discarded (#144)");
});

test("the flushed config still describes this boot (#144)", async () => {
  const dataDir = mkdtempInRootSync("t144e-");
  const _ws = mkdtempInRootSync("t144x-");
  const { path: p, agents } = cfg(dataDir, 3);
  const m = master(p, dataDir, agents);
  await m.start();
  for (const a of [...m.agents.values()]) a.stop("done");
  for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
  const parsed = JSON.parse(readFileSync(p, "utf8")) as {
    agents?: { id: string; session?: string }[];
  };
  const live = [...m.agents.keys()];
  assert.equal(parsed.agents?.length, live.length, `config must list every agent (#144): ${JSON.stringify(parsed.agents?.map((a) => a.id))}`);
  for (const id of live) {
    const entry = parsed.agents?.find((a) => a.id === id);
    assert.ok(entry, `${id} must be in the flushed config (#144)`);
  }
});

test("a deferred write is dropped once boot ends (#144)", async () => {
  const dataDir = mkdtempInRootSync("t144f-");
  const { path: p, agents } = cfg(dataDir, 2);
  const m = master(p, dataDir, agents);
  await m.start();
  for (const a of [...m.agents.values()]) a.stop("done");
  for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
  assert.equal(
    (m as unknown as { deferConfigWrites: boolean }).deferConfigWrites,
    false,
    "the defer must be lifted after boot (#144)",
  );
  const inoBefore = statSync(p).ino;
  m.saveConfig();
  assert.notEqual(statSync(p).ino, inoBefore, "and later saves must write immediately (#144)");
});
