import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";

function mkMaster(dataDir: string): Master {
  return new Master(
    {
      port: 0,
      dataDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      providers: {},
      agents: [],
    },
    "/dev/null",
  );
}

test("TEAPOT_API_TOKEN gates /api/* with bearer auth; unset keeps it open", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "auth-root-"));
  const master = mkMaster(dataDir);

  // open by default
  const openApp = buildApp(master);
  assert.equal((await openApp.request("/api/agents")).status, 200);

  // token set → 401 without, 200 with
  process.env.TEAPOT_API_TOKEN = "sekrit";
  try {
    const gated = buildApp(master); // reads env at build time
    assert.equal((await gated.request("/api/agents")).status, 401);
    assert.equal(
      (await gated.request("/api/agents", { headers: { authorization: "Bearer sekrit" } })).status,
      200,
    );
    assert.equal((await gated.request("/api/agents?token=wrong")).status, 401);
    assert.equal((await gated.request("/api/agents?token=sekrit")).status, 200);
  } finally {
    delete process.env.TEAPOT_API_TOKEN;
  }
});
