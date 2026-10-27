import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Master } from "../src/master.ts";
import { useTempDir } from "./helpers/tmp.ts";

/**
 * Every runtime control in the settings panel must reach `config.json` — and a SECOND change must too.
 *
 * Reported as "設定のruntime欄の progress interval (min) が機能してなくない? 少なくともconfig.jsonには
 * 書き込まれてない".
 *
 * `saveConfig()` mirrored a whitelist into `this.raw`, and it was wrong in two ways that both look like
 * "the setting does not work":
 *
 *   - `progressIntervalMs` / `progressMinChars` were written only when `raw` did not already have them
 *     (`this.raw.X === undefined`), so the FIRST save persisted and every later change was silently
 *     dropped — which is exactly what the operator saw: the field had a value in the file and the UI no
 *     longer agreed with it;
 *   - six more keys (`contextTokenBudget`, `contextWindowTokens`, `maxSpawnDepth`, `maxTurnsPerRound`,
 *     `onError`, `retryDelayMs`) were mirrored in `updateConfig` instead, so the two owners disagreed.
 *
 * The list now lives in ONE place and is written unconditionally; `undefined` deletes the key so that
 * clearing a control in the UI clears it on disk.
 */
const boot = async (dataDir: string) => {
  const cfgPath = path.join(dataDir, "config.json");
  const cfg = {
    port: 0,
    dataDir,
    llm: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
    providers: { p: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" } },
    defaultProvider: "p",
    agents: [],
  };
  await fs.writeFile(cfgPath, JSON.stringify(cfg));
  const m = new Master(cfg as never, cfgPath);
  await m.start();
  return { m, cfgPath };
};

const read = async (cfgPath: string) => JSON.parse(await fs.readFile(cfgPath, "utf8")) as Record<string, unknown>;

test("a runtime setting is written, and a SECOND change overwrites it (#config)", async () => {
  await useTempDir("rt-", async (dataDir) => {
    const { m, cfgPath } = await boot(dataDir!);

    m.updateConfig({ progressIntervalMs: 600_000 });
    assert.equal((await read(cfgPath)).progressIntervalMs, 600_000, "the first save must persist");

    // THE REGRESSION: raw already had a value, so the old guard skipped this write entirely
    m.updateConfig({ progressIntervalMs: 120_000 });
    assert.equal((await read(cfgPath)).progressIntervalMs, 120_000, "a later change must overwrite it");

    m.updateConfig({ progressMinChars: 2500 });
    m.updateConfig({ progressMinChars: 900 });
    assert.equal((await read(cfgPath)).progressMinChars, 900);
    await m.stopAllAgents();
  });
});

test("every runtime control reaches the file (#config)", async () => {
  await useTempDir("rt2-", async (dataDir) => {
    const { m, cfgPath } = await boot(dataDir!);
    m.updateConfig({
      progressIntervalMs: 300_000,
      progressMinChars: 1234,
      contextTokenBudget: 250_000,
      contextWindowTokens: 400_000,
      maxSpawnDepth: 5,
      maxTurnsPerRound: 40,
      retryDelayMs: 7000,
      shortContext: true,
    });
    const saved = await read(cfgPath);
    assert.equal(saved.progressIntervalMs, 300_000);
    assert.equal(saved.progressMinChars, 1234);
    assert.equal(saved.contextTokenBudget, 250_000);
    assert.equal(saved.contextWindowTokens, 400_000);
    assert.equal(saved.maxSpawnDepth, 5);
    assert.equal(saved.maxTurnsPerRound, 40);
    assert.equal(saved.retryDelayMs, 7000);
    assert.equal(saved.shortContext, true);
    await m.stopAllAgents();
  });
});

test("clearing a control removes the key instead of leaving a stale value (#config)", async () => {
  await useTempDir("rt3-", async (dataDir) => {
    const { m, cfgPath } = await boot(dataDir!);
    m.updateConfig({ contextTokenBudget: 250_000 });
    assert.equal((await read(cfgPath)).contextTokenBudget, 250_000);

    // the UI sends 0 for "derive it per model"; the key must go away, or the old cap keeps applying
    m.updateConfig({ contextTokenBudget: 0 });
    assert.equal(
      "contextTokenBudget" in (await read(cfgPath)),
      false,
      "an undefined value must DELETE the key",
    );
    await m.stopAllAgents();
  });
});

test("the progress interval is actually pushed to a live agent (#config)", async () => {
  /**
   * Persisting is half of "works". The interval is read from the agent's own opts, so a running agent
   * has to be updated or the setting only takes effect after a restart.
   */
  await useTempDir("rt4-", async (dataDir) => {
    const cfgPath = path.join(dataDir!, "config.json");
    const cfg = {
      port: 0,
      dataDir,
      llm: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
      providers: { p: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" } },
      defaultProvider: "p",
      agents: [{ id: "a", workspace: dataDir, provider: "p", session: "a", model: "m" }],
    };
    await fs.writeFile(cfgPath, JSON.stringify(cfg));
    const m = new Master(cfg as never, cfgPath);
    await m.start();

    m.updateConfig({ progressIntervalMs: 90_000 });
    const agent = m.agents.get("a") as unknown as { opts: { progressIntervalMs: number } };
    assert.equal(agent.opts.progressIntervalMs, 90_000, "a live agent must see the new interval");
    await m.stopAllAgents();
  });
});
