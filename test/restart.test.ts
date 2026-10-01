import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";

test("stopAllAgents: gracefully stops all running agents", async () => {
  // regression: live-update must NOT lose data — every running agent must
  // be given a chance to flush its log + close subprocesses before the
  // server restarts. The endpoint just calls stopAllAgents().
  await useTempDirs(["restart-root-", "restart-ws-"], async ([dataDir, ws]) => {
    const m = new Master(
      { port: 0, dataDir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
        providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } },
        defaultProvider: "p", agents: [] } as any,
      "/dev/null",
    );
    const a = await m.addAgent({ id: "x", workspace: ws, provider: "p" });
    const b = await m.addAgent({ id: "y", workspace: ws, provider: "p" });
    assert.equal(m.agents.size, 2);
    await m.stopAllAgents(5_000);
    assert.equal(m.agents.size, 0, "all agents disposed");
  });
});

test("getVersion: returns the real version from package.json (#33)", async () => {
  // regression #33: the settings panel rendered the literal
  // "current version: __APP_VERSION__". `__APP_VERSION__` is substituted by
  // *vite* only, so the tsc-built backend shipped the raw placeholder. The
  // version must now be read from package.json at runtime, in every context
  // (built app, `pnpm dev`, node --test — none of which necessarily run vite).
  const expected = (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;
  assert.equal(Master.VERSION, expected, "matches package.json");
  await useTempDirs(["ver-root-", "ver-ws-"], async ([dataDir, ws]) => {
    const m = new Master(
      { port: 0, dataDir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
        providers: {}, agents: [] } as any,
      "/dev/null",
    );
    const v = m.getVersion();
    assert.equal(typeof v, "string");
    assert.ok(v.length > 0, "version string is non-empty");
    assert.notEqual(v, "__APP_VERSION__", "the vite placeholder never leaks (#33)");
    assert.match(v, /^\d+\.\d+\.\d+/, "looks like a semver, not a placeholder");
  });
});
