/**
 * #144 — an interrupted boot could EMPTY config.json.
 *
 * ## The report
 *
 * After updating to v0.28.1, boot printed dozens of
 *
 *     [teapot] session <id> for <agent> is gone; starting a new one
 *
 * lines before `master listening on …`. Pressing Ctrl-C during that window left a
 * **zero-length config.json**, and the operator reported that restoring it "takes
 * an hour".
 *
 * ## Two independent causes
 *
 * **1. The write was not atomic.** `saveConfig` used a bare `writeFileSync`, which
 * TRUNCATES the target before writing. Any interruption during the write — a
 * signal, a crash, a full disk — lands on an empty file. `config.json` holds every
 * agent, provider and scheduled task, so the next boot reads `{}`.
 *
 * It is now write-temp → `fsync` → `rename`, and `rename` is atomic within a
 * filesystem: the file is either the old content or the new, never empty.
 *
 * **2. Boot rewrote the file once per agent.** Every agent whose recorded session
 * is gone mints a new one, and minting calls `recordSession` → `saveConfig`. So ~30
 * agents meant ~30 full rewrites of a 148KB file before the server listened. That
 * is what made the window long enough to hit by accident.
 *
 * Writes are now deferred during boot and flushed ONCE, in a `finally` so a throw
 * mid-boot still persists what it changed — a deferred write that never flushes
 * would describe the PREVIOUS boot, which is its own silent data loss.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Master, type AgentConfig } from "../src/master.ts";

/**
 * write a config file with `n` agents, and return { path, agents }
 *
 * Each agent records a session that DOES NOT EXIST, which is the user's reported
 * condition — their log was full of "session … is gone; starting a new one".
 * That is what makes boot mint a new session per agent, and minting is what
 * persists, so without it the write-counting test measures a boot that never
 * writes at all (which is correct behaviour, and not what #144 is about).
 *
 * `workspace` is required: addAgent rejects an entry without one, and a rejected
 * entry is skipped with a log line rather than loaded — so an agent list missing
 * it silently produces zero agents and the test asserts nothing.
 */
function cfg(dataDir: string, n = 4): { path: string; agents: AgentConfig[] } {
  const ws = path.join(dataDir, "ws");
  mkdirSync(ws, { recursive: true });
  const agents: AgentConfig[] = Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    provider: "p",
    workspace: ws,
    session: `gone-${i}`, // points at a directory that does not exist
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

// The Master's OPTIONS are the config in production (`loadConfig` feeds them), so
// the agents must be passed there — writing them only to the file, with
// `agents: []` in the options, loads nothing and the test measures the wrong thing.
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

/* ---------- the file is never left empty ---------- */

test("saveConfig leaves a complete, parseable file (#144)", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "t144a-"));
  const { path: p, agents } = cfg(dataDir, 5);
  const m = master(p, dataDir, agents);
  m.saveConfig();
  const body = readFileSync(p, "utf8");
  assert.ok(body.length > 0, "config.json must never be empty after a save (#144)");
  const parsed = JSON.parse(body) as { agents?: unknown[] };
  assert.equal(parsed.agents?.length, 5, "and must parse back to the full agent list (#144)");
});

test("the write is atomic — a new inode, not an in-place rewrite (#144)", async () => {
  // rename() lands a DIFFERENT inode; an in-place truncate+write keeps the same
  // one, which is exactly what leaves a window for an empty file
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "t144b-"));
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
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "t144c-"));
  const { path: p, agents } = cfg(dataDir, 3);
  const m = master(p, dataDir, agents);
  m.saveConfig();
  m.saveConfig();
  const leftovers = readdirSync(dataDir).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, [], `a crashed write would leave these behind (#144): ${leftovers}`);
});

/* ---------- boot writes once, not once per agent ---------- */

test("booting N agents performs ONE write, not N (#144)", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "t144d-"));
  const ws = mkdtempSync(path.join(os.tmpdir(), "t144w-"));
  const { path: p, agents } = cfg(dataDir, 6);
  const m = master(p, dataDir, agents);

  // count writes by inode changes — each rename-based save produces a new one
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
  // a deferred write that never flushes would leave config.json describing the
  // PREVIOUS boot — silent data loss of a different kind
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "t144e-"));
  const ws = mkdtempSync(path.join(os.tmpdir(), "t144x-"));
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
  // outside boot a save must be immediate, or an operator's rename would be lost
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "t144f-"));
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
