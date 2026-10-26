import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { buildApp } from "../src/server/api.ts";
import { Master } from "../src/master.ts";
import path from "node:path";

const appWith = (dataDir: string) =>
  buildApp(
    new Master(
      {
        port: 0,
        dataDir,
        llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
        providers: {},
        agents: [],
      } as never,
      path.join(dataDir, "config.json"),
    ),
  );

test("a cross-origin WRITE is refused even with no token configured (#security)", async () => {
  const app = appWith(mkdtempInRootSync("sec-"));
  const res = await app.request("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example", host: "127.0.0.1:7789" },
    body: JSON.stringify({ password: "pwned" }),
  });
  assert.equal(
    res.status,
    403,
    "a page on another origin must not be able to write, or it can set the password and take over",
  );
});

test("same-origin and non-browser clients are NOT blocked (#security)", async () => {
  const app = appWith(mkdtempInRootSync("sec2-"));

  const sameOrigin = await app.request("/api/agents/nope/prompt", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:7789", host: "127.0.0.1:7789" },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.notEqual(sameOrigin.status, 403, "the UI's own origin must be allowed");

  const noOrigin = await app.request("/api/agents/nope/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.notEqual(noOrigin.status, 403, "a local client sends no Origin and must be allowed");
});

test("a sandboxed iframe's `Origin: null` is refused (#security)", async () => {
  const app = appWith(mkdtempInRootSync("sec3-"));
  const res = await app.request("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "null", host: "127.0.0.1:7789" },
    body: JSON.stringify({ password: "pwned" }),
  });
  assert.equal(res.status, 403);
});

test("GETs stay readable so the UI can load (#security)", async () => {
  const app = appWith(mkdtempInRootSync("sec4-"));
  const res = await app.request("/api/agents", {
    method: "GET",
    headers: { origin: "https://evil.example", host: "127.0.0.1:7789" },
  });
  assert.notEqual(res.status, 403);
});

test("an unconfigured server ADVERTISES that it has no auth (#security)", async () => {
  const app = appWith(mkdtempInRootSync("sec5-"));
  const res = await app.request("/api/agents");
  assert.equal(res.headers.get("x-teapot-auth"), "none");
});

test("a request THROUGH a reverse proxy is allowed (#security)", async () => {
  const app = appWith(mkdtempInRootSync("sec6-"));
  const res = await app.request("/api/agents/nope/prompt", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://myhost:7788", 
      host: "localhost:7789", 
      "sec-fetch-site": "same-origin", 
    },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.notEqual(res.status, 403, "the operator's own page through a proxy must work");
});

test("an ATTACKER page is still refused, proxy or no proxy (#security)", async () => {
  const app = appWith(mkdtempInRootSync("sec7-"));
  const res = await app.request("/api/setup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://evil.example",
      host: "localhost:7789",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({ password: "pwned" }),
  });
  assert.equal(res.status, 403);
});

test("X-Forwarded-Host is honoured for old browsers that send no Sec-Fetch-Site (#security)", async () => {
  const app = appWith(mkdtempInRootSync("sec8-"));
  const res = await app.request("/api/agents/nope/prompt", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://myhost:7788",
      host: "localhost:7789",
      "x-forwarded-host": "myhost:7788",
    },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.notEqual(res.status, 403, "the original host from the proxy must be accepted");
});
