import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDir } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("POSIX filesystem paths");

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
  await useTempDir("auth-root-", async (dataDir) => {
    const master = mkMaster(dataDir);

    const openApp = buildApp(master);
    assert.equal((await openApp.request("/api/agents")).status, 200);

    process.env.TEAPOT_API_TOKEN = "sekrit";
    try {
      const gated = buildApp(master); 
      assert.equal((await gated.request("/api/agents")).status, 401);
      assert.equal(
        (await gated.request("/api/agents", { headers: { authorization: "Bearer sekrit" } })).status,
        200,
      );
      assert.equal((await gated.request("/api/agents?token=wrong")).status, 401);
      assert.equal(
        (await gated.request("/api/agents?token=sekrit")).status,
        401,
        "?token= must NOT authenticate an ordinary API route (#79)",
      );
      assert.equal(
        (await gated.request("/api/agents?token=sekrit", { headers: { authorization: "Bearer sekrit" } }))
          .status,
        200,
        "the header remains the way to authenticate a normal route (#79)",
      );
      assert.notEqual(
        (await gated.request("/api/ws?token=wrong")).status,
        200,
        "a wrong ?token= must still fail on the socket route (#79)",
      );
    } finally {
      delete process.env.TEAPOT_API_TOKEN;
    }
  });
});

test("the WebSocket routes reject a bad ?token= and nothing else (#79)", async () => {
  await useTempDir("auth-ws-", async (dataDir) => {
    const master = mkMaster(dataDir);
    process.env.TEAPOT_API_TOKEN = "sekrit";
    try {
      const gated = buildApp(master);
      assert.equal((await gated.request("/api/ws")).status, 401, "no token must fail (#79)");
      assert.equal((await gated.request("/api/ws?token=nope")).status, 401, "a wrong ?token= must fail (#79)");
      assert.equal(
        (await gated.request("/api/agents/some-agent/term?token=nope")).status,
        401,
        "a wrong ?token= must fail on the terminal socket too (#79)",
      );
      assert.notEqual(
        (await gated.request("/api/ws", { headers: { authorization: "Bearer sekrit" } })).status,
        401,
        "the header must still authenticate a socket route (#79)",
      );
    } finally {
      delete process.env.TEAPOT_API_TOKEN;
    }
  });
});

