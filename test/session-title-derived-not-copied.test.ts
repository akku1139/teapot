import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Master } from "../src/master.ts";
import { useTempDir } from "./helpers/tmp.ts";

/**
 * A session's name is DERIVED from `config.sessionTitles`, not copied onto the agent.
 *
 * Reported: "新しいセッションでconfig.jsonにチャットタイトルが生成されているのに表示が内部IDになってる"
 * (`hono-ja-58f5d7b2`). MEASURED in the operator's config: `sessionTitles["hono-ja-58f5d7b2"]` held the
 * real name while the agent's own `sessionTitle` still held the id it was seeded with at creation.
 *
 * A new session is named LATER than its agent is created (from its first prompt), so the copy is
 * necessarily stale for a while, and any writer that forgets to push leaves it stale forever. The field
 * is gone: `snapshot()` asks the map every time, so there is nothing to keep in sync.
 */
const boot = async (dataDir: string, sessionTitles: Record<string, string> = {}) => {
  /**
   * The session directory must EXIST, or `addAgent` cannot attach to the configured session and mints a
   * fresh id — the test would then be asserting about a different session than the one it named.
   */
  const sessDir = path.join(dataDir, "sessions", "hono-ja-58f5d7b2");
  await fs.mkdir(sessDir, { recursive: true });
  await fs.writeFile(path.join(sessDir, "session.json"), JSON.stringify({ v: 1, agentId: "hono-ja" }));
  await fs.writeFile(
    path.join(sessDir, "chat.jsonl"),
    JSON.stringify({
      v: 1, id: "e1", seq: 1, ts: "2026-01-01T00:00:00Z",
      agent: "hono-ja", session: "hono-ja-58f5d7b2", branch: "br0",
      type: "prompt", data: { source: "user", text: "origin/sync ブランチをマージして" },
    }) + "\n",
  );
  const cfgPath = path.join(dataDir, "config.json");
  const cfg = {
    port: 0,
    dataDir,
    llm: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
    providers: { p: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" } },
    defaultProvider: "p",
    agents: [{ id: "hono-ja", workspace: dataDir, provider: "p", session: "hono-ja-58f5d7b2", model: "m" }],
    sessionTitles,
  };
  await fs.writeFile(cfgPath, JSON.stringify(cfg));
  const m = new Master(cfg as never, cfgPath);
  await m.start();
  return { m, cfgPath };
};

test("the panel shows the map's title, not the internal id (#title)", async () => {
  await useTempDir("tt-", async (dataDir) => {
    const { m } = await boot(dataDir!, { "hono-ja-58f5d7b2": "origin/sync ブランチをマージして" });
    assert.equal(
      m.agents.get("hono-ja")?.snapshot().sessionTitle,
      "origin/sync ブランチをマージして",
      "the map is the master; the agent holds no copy to go stale",
    );
    await m.stopAllAgents();
  });
});

test("a title written AFTER the agent exists is visible immediately (#title)", async () => {
  /**
   * This is the reported sequence, exactly: the agent is created (map empty), and the name arrives later.
   * With a copied field the second assertion needed a restart — or the push that was missing.
   */
  await useTempDir("tt2-", async (dataDir) => {
    const { m, cfgPath } = await boot(dataDir!);
    assert.equal(m.agents.get("hono-ja")?.snapshot().sessionTitle, "hono-ja-58f5d7b2", "no entry → the id");

    // rename through the public path; this is what a derived title or a rename does
    await m.renameSession("hono-ja", "hono-ja-58f5d7b2", "実名のタイトル");
    assert.equal(
      m.agents.get("hono-ja")?.snapshot().sessionTitle,
      "実名のタイトル",
      "a later write must be visible without a restart",
    );
    // and it is on disk, in ONE place
    const saved = JSON.parse(await fs.readFile(cfgPath, "utf8")) as Record<string, never>;
    assert.equal(saved.sessionTitles!["hono-ja-58f5d7b2"], "実名のタイトル");
    await m.stopAllAgents();
  });
});

test("no per-agent title copy is written to the config (#title)", async () => {
  // the field was removed by migration; nothing may reintroduce it
  await useTempDir("tt3-", async (dataDir) => {
    const { m, cfgPath } = await boot(dataDir!);
    await m.renameSession("hono-ja", "hono-ja-58f5d7b2", "名前");
    const saved = JSON.parse(await fs.readFile(cfgPath, "utf8")) as { agents: Record<string, unknown>[] };
    assert.equal("sessionTitle" in saved.agents[0]!, false, "one owner only");
    await m.stopAllAgents();
  });
});
