/**
 * 初回セットアップの password が、プロセス再起動まで 401 ゲートを有効化しない。
 *
 * `apiToken` は buildApp() 実行時に一度だけ評価される。初回起動は password
 * 未設定なので apiToken==="" でミドルウェア自体が付かず、その後 /api/setup
 * が config.password を書いてもゲートは再構築されない。
 *
 * Required:
 *   - password 未設定 → /api/* は開いている（既存契約）
 *   - /api/setup で password 設定 → 同プロセス内で直ちに 401 ゲートが効く
 *   - 正しい Bearer なら通る
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Master } from "../src/master.ts";
import { buildApp, serveApp } from "../src/server/api.ts";
import { freePort } from "./helpers/free-port.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function call(port: number, method: string, p: string, token?: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
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

test("a password set through /api/setup gates /api/* in the SAME process (setup auth)", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "auth1-"));
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  // the first-boot state: no config file was read (index.ts sets this from the
  // filesystem; a direct construction keeps the default true)
  m.configFileExists = false;
  const app = buildApp(m);
  const port = await freePort();
  const server = serveApp(app, port, "127.0.0.1");
  try {
    // first boot: no password anywhere — the API is open (existing contract)
    const open = await call(port, "GET", "/api/config");
    assert.equal(open.status, 200, "with no password configured the API stays open");

    // the wizard writes a password (and no agent workspace, to keep it simple)
    const setup = await call(port, "POST", "/api/setup", undefined, {
      baseUrl: "http://x",
      apiKey: "k",
      model: "m",
      password: "s3cret",
    });
    assert.equal(setup.status, 200, `setup must succeed: ${JSON.stringify(setup.json)}`);

    // the gate must be LIVE immediately — no process restart
    const noToken = await call(port, "GET", "/api/config");
    assert.equal(noToken.status, 401, "after setup, an unauthenticated request must be rejected");
    const badToken = await call(port, "GET", "/api/config", "wrong");
    assert.equal(badToken.status, 401, "a wrong token must be rejected");
    const goodToken = await call(port, "GET", "/api/config", "s3cret");
    assert.equal(goodToken.status, 200, "the configured password must authenticate");
  } finally {
    await server.close();
  }
});
