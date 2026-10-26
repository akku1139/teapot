import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("POSIX filesystem paths");

test("stopAllAgents: gracefully stops all running agents", async () => {
  await useTempDirs(["restart-root-", "restart-ws-"], async ([dataDir, ws]) => {
    const m = new Master(
      { port: 0, dataDir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
        providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } },
        defaultProvider: "p", agents: [] } as any,
      "/dev/null",
    );
    const _a = await m.addAgent({ id: "x", workspace: ws, provider: "p" });
    const _b = await m.addAgent({ id: "y", workspace: ws, provider: "p" });
    assert.equal(m.agents.size, 2);
    await m.stopAllAgents(5_000);
    assert.equal(m.agents.size, 0, "all agents disposed");
  });
});

test("getVersion: returns the real version from package.json (#33)", async () => {
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
