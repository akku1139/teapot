import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";

import { Master } from "../src/master.ts";
import { buildApp, serveApp } from "../src/server/api.ts";
import { freePort } from "./helpers/free-port.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

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
  const dataDir = mkdtempInRootSync("auth1-");
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  m.configFileExists = false;
  const app = buildApp(m);
  const port = await freePort();
  const server = serveApp(app, port, "127.0.0.1");
  try {
    const open = await call(port, "GET", "/api/config");
    assert.equal(open.status, 200, "with no password configured the API stays open");

    const setup = await call(port, "POST", "/api/setup", undefined, {
      baseUrl: "http://x",
      apiKey: "k",
      model: "m",
      password: "s3cret",
    });
    assert.equal(setup.status, 200, `setup must succeed: ${JSON.stringify(setup.json)}`);

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
