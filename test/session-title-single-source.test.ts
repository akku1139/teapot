import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Master } from "../src/master.ts";
import { useTempDirs } from "./helpers/tmp.ts";

/**
 * A session's title lives in ONE place: `<session>/session.json`.
 *
 * The reported bug: rename a session, `config.json` updates, and the UI keeps showing the
 * auto-generated name. The cause was double management — the title existed in `config.json` AND was
 * derivable from `chat.jsonl`, and `recordSession()` deleted the config copy whenever an agent moved
 * session. So a rename followed by any switch silently reverted to the derived name, and the restart
 * path never seeded the agent's field at all, so the snapshot had nothing to show.
 *
 * These pin the contract rather than the storage detail: the operator's name must survive a restart
 * and must not be replaced by a freshly derived one.
 */
const boot = async (dataDir: string) => {
  const cfgPath = path.join(dataDir, "config.json");
  const cfg = {
    port: 0,
    dataDir,
    llm: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
    providers: { p: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" } },
    defaultProvider: "p",
    agents: [{ id: "t1", workspace: dataDir, provider: "p", session: "t1", model: "m" }],
  };
  await fs.writeFile(cfgPath, JSON.stringify(cfg));
  const m = new Master(cfg as never, cfgPath);
  await m.start();
  return m;
};

const seedSession = async (dataDir: string, text: string) => {
  const dir = path.join(dataDir, "sessions", "t1");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "session.json"),
    JSON.stringify({ v: 1, agentId: "t1" }),
  );
  await fs.writeFile(
    path.join(dir, "chat.jsonl"),
    JSON.stringify({
      v: 1, id: "e1", seq: 1, ts: "2026-01-01T00:00:00Z",
      agent: "t1", session: "t1", branch: "br0",
      type: "prompt", data: { source: "user", text },
    }) + "\n",
  );
};

test("a rename is stored with the session, and config keeps no copy (#title)", async () => {
  await useTempDirs(["st1-", "st2-"], async ([dataDir]) => {
    await seedSession(dataDir!, "auto generated from this prompt");
    const m = await boot(dataDir!);
    await m.renameSession("t1", "t1", "OPERATOR NAME");
    const manifest = JSON.parse(await fs.readFile(path.join(dataDir!, "sessions", "t1", "session.json"), "utf8"));
    assert.equal(manifest.title, "OPERATOR NAME", "the session's own manifest holds it");
    const saved = JSON.parse(await fs.readFile(path.join(dataDir!, "config.json"), "utf8"));
    assert.equal(saved.agents[0].sessionTitle, undefined, "and config holds no second copy");
    await m.stopAllAgents();
  });
});

test("the operator's name survives a restart, and beats the derived one (#title)", async () => {
  await useTempDirs(["st3-", "st4-"], async ([dataDir]) => {
    await seedSession(dataDir!, "auto generated from this prompt");
    const m1 = await boot(dataDir!);
    await m1.renameSession("t1", "t1", "KEPT ACROSS RESTART");
    await m1.stopAllAgents();

    // a fresh Master = what a restart does
    const m2 = await boot(dataDir!);
    const snap = m2.agents.get("t1")?.snapshot();
    assert.equal(
      snap?.sessionTitle,
      "KEPT ACROSS RESTART",
      "the UI reads the snapshot, so a restart must re-seed it from the session",
    );
    await m2.stopAllAgents();
  });
});

test("a session with no title derives one ONCE and writes it down (#title)", async () => {
  await useTempDirs(["st5-", "st6-"], async ([dataDir]) => {
    await seedSession(dataDir!, "derive me from this line");
    const m = await boot(dataDir!);
    const manifest = JSON.parse(await fs.readFile(path.join(dataDir!, "sessions", "t1", "session.json"), "utf8"));
    assert.match(
      String(manifest.title ?? ""),
      /derive me from this line/,
      "written once, so no caller has to scan chat.jsonl per session",
    );
    await m.stopAllAgents();
  });
});
