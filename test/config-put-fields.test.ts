import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { Master } from "../src/master.ts";
import { buildApp, serveApp } from "../src/server/api.ts";
import { freePort } from "./helpers/free-port.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function call(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json" } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: (() => { try { return JSON.parse(buf); } catch { return buf; } })() }));
      },
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test("PUT /api/config persists the fields it validates (context window, rounds, error policy)", async () => {
  const dataDir = mkdtempInRootSync("cfg1-");
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  const app = buildApp(m);
  const port = await freePort();
  const server = serveApp(app, port, "127.0.0.1");
  try {
    const put = await call(port, "PUT", "/api/config", {
      contextWindowTokens: 200_000,
      maxTurnsPerRound: 7,
      onError: "retry",
      retryDelayMs: 2_000,
    });
    assert.equal(put.status, 200, `PUT must succeed: ${JSON.stringify(put.json)}`);

    const cfg = m.config as unknown as Record<string, unknown>;
    assert.equal(cfg.contextWindowTokens, 200_000, "contextWindowTokens must reach the config (was dropped)");
    assert.equal(cfg.maxTurnsPerRound, 7, "maxTurnsPerRound must reach the config (was dropped by the route)");
    assert.equal(cfg.onError, "retry", "onError must reach the config (was dropped by the route)");
    assert.equal(cfg.retryDelayMs, 2_000, "retryDelayMs must reach the config (was dropped by the route)");

    const get = await call(port, "GET", "/api/config");
    assert.equal(get.json.contextWindowTokens, 200_000, "GET must show the saved window");

    const raw = JSON.parse(readFileSync(`${dataDir}/config.json`, "utf8"));
    assert.equal(raw.contextWindowTokens, 200_000, "the value survives a restart");
  } finally {
    await server.close();
  }
});

test("contextWindowTokens: null clears the pin (same contract as contextTokenBudget)", async () => {
  const dataDir = mkdtempInRootSync("cfg2-");
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  const app = buildApp(m);
  const port = await freePort();
  const server = serveApp(app, port, "127.0.0.1");
  try {
    await call(port, "PUT", "/api/config", { contextWindowTokens: 200_000 });
    await call(port, "PUT", "/api/config", { contextWindowTokens: null });
    assert.equal(
      (m.config as unknown as Record<string, unknown>).contextWindowTokens,
      undefined,
      "an explicit null must return to per-model inference",
    );
  } finally {
    await server.close();
  }
});

test("PUT /api/config persists the whole apiKeys pool, not just the first key (#170)", async () => {
  const dataDir = mkdtempInRootSync("cfg-keys-");
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  const app = buildApp(m);
  const port = await freePort();
  const server = serveApp(app, port, "127.0.0.1");
  try {
    const pool = ["key-AAA", "key-BBB", "key-CCC"];
    const put = await call(port, "PUT", "/api/config", {
      providers: { probe: { baseUrl: "https://example.test/v1", apiKeys: pool, model: "m1" } },
    });
    assert.equal(put.status, 200, `PUT must succeed: ${JSON.stringify(put.json)}`);

    const raw = JSON.parse(readFileSync(`${dataDir}/config.json`, "utf8"));
    assert.deepEqual(
      raw.providers.probe.apiKeys,
      pool,
      "all three keys must persist — dropping them is how 'I added 3 keys but it still " +
        "rate-limits' happens (#170)",
    );
    assert.equal(raw.providers.probe.apiKey, "key-AAA", "the legacy field stays in step with [0]");

    const get = await call(port, "GET", "/api/config");
    const shown = get.json.providers.probe;
    assert.equal(shown.apiKeys?.length, 3, "GET must return the pool it is asking the UI to edit (#170)");
    for (const [i, k] of shown.apiKeys.entries()) {
      assert.match(
        k,
        /^•••/,
        `key ${i} must be masked — the UI must never receive a plaintext credential`,
      );
      assert.ok(k.endsWith(pool[i].slice(-3)), `key ${i} must still identify WHICH stored key it is`);
    }

    await call(port, "PUT", "/api/config", {
      providers: { probe: { baseUrl: shown.baseUrl, apiKey: shown.apiKey, apiKeys: shown.apiKeys, model: shown.model } },
    });
    assert.deepEqual(
      JSON.parse(readFileSync(`${dataDir}/config.json`, "utf8")).providers.probe.apiKeys,
      pool,
      "an untouched masked pool means 'the stored values' — a round trip must not corrupt them (#170)",
    );

    const edited = [...shown.apiKeys];
    edited[1] = "key-NEW";
    await call(port, "PUT", "/api/config", {
      providers: { probe: { baseUrl: shown.baseUrl, apiKeys: edited, model: shown.model } },
    });
    assert.deepEqual(
      JSON.parse(readFileSync(`${dataDir}/config.json`, "utf8")).providers.probe.apiKeys,
      ["key-AAA", "key-NEW", "key-CCC"],
      "a mask must resolve POSITIONALLY, or editing one key rewrites the rest (#170)",
    );
  } finally {
    await server.close();
  }
});
