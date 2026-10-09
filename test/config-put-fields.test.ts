/**
 * PUT /api/config が schema を通ったフィールドを捨てている。
 *
 * ConfigPatchSchema は contextWindowTokens / maxTurnsPerRound / onError /
 * retryDelayMs を「有効」と判定して 200 を返すが、route は updateConfig に
 * それらを渡していない（updateConfig の型に contextWindowTokens 自体がない）。
 * 「保存しました」の後も GET /api/config は旧値 — 設定画面の context window
 * は永遠に反映されない。
 *
 * Required: PUT で入れた 4 フィールドが master.config と GET /api/config に
 * 反映され、config ファイルに persist されること。null で contextWindowTokens
 * を解除できること（contextTokenBudget と同じ契約）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Master } from "../src/master.ts";
import { buildApp, serveApp } from "../src/server/api.ts";
import { freePort } from "./helpers/free-port.ts";

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
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cfg1-"));
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

    // the running config actually changed
    const cfg = m.config as unknown as Record<string, unknown>;
    assert.equal(cfg.contextWindowTokens, 200_000, "contextWindowTokens must reach the config (was dropped)");
    assert.equal(cfg.maxTurnsPerRound, 7, "maxTurnsPerRound must reach the config (was dropped by the route)");
    assert.equal(cfg.onError, "retry", "onError must reach the config (was dropped by the route)");
    assert.equal(cfg.retryDelayMs, 2_000, "retryDelayMs must reach the config (was dropped by the route)");

    // and the GET the settings modal re-reads shows them
    const get = await call(port, "GET", "/api/config");
    assert.equal(get.json.contextWindowTokens, 200_000, "GET must show the saved window");

    // and the file was persisted
    const raw = JSON.parse(readFileSync(`${dataDir}/config.json`, "utf8"));
    assert.equal(raw.contextWindowTokens, 200_000, "the value survives a restart");
  } finally {
    await server.close();
  }
});

test("contextWindowTokens: null clears the pin (same contract as contextTokenBudget)", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cfg2-"));
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
