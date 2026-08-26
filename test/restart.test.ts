import { test } from "node:test";
import assert from "node:assert/strict";
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

test("getVersion: returns the bundled version string", async () => {
  // the version is injected at build time (or stays as the literal sentinel
  // in dev). The endpoint must always return a string the client can compare.
  await useTempDirs(["ver-root-", "ver-ws-"], async ([dataDir, ws]) => {
    const m = new Master(
      { port: 0, dataDir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
        providers: {}, agents: [] } as any,
      "/dev/null",
    );
    const v = m.getVersion();
    assert.equal(typeof v, "string");
    assert.ok(v.length > 0, "version string is non-empty");
  });
});
