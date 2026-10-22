/**
 * A web page must not be able to drive the local API.
 *
 * From the OpenCode advisories, checked against teapot: CVE-2026-22812 / GHSA-vxw4-wv6m-9hhh was
 * an unauthenticated HTTP server that any local process — or any website, via permissive CORS —
 * could use to run shell commands.
 *
 * teapot has the same unauthenticated default (`apiToken()` is empty on a fresh install, and the
 * middleware returned `next()` immediately). It binds 127.0.0.1 by default and sets no CORS
 * headers, so a page could not READ a response — but a cross-origin WRITE is still delivered, and
 * `POST /api/agents/:id/prompt` makes the agent call the model with tool access.
 *
 * See docs/security-advisories.md for the full analysis and the residual risk that is NOT covered
 * here (a local process, which needs the token instead).
 */
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
        // no password / no token: the fresh-install state that made the advisory apply
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
  /**
   * The fix must not break the real clients: the UI calls from its own origin (Origin matches
   * Host), and curl / the CLI / the desktop shell send no Origin at all.
   */
  const app = appWith(mkdtempInRootSync("sec2-"));

  const sameOrigin = await app.request("/api/agents/nope/prompt", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:7789", host: "127.0.0.1:7789" },
    body: JSON.stringify({ text: "hi" }),
  });
  // 404 is the right answer: the request got PAST the guard and failed on the missing agent.
  assert.notEqual(sameOrigin.status, 403, "the UI's own origin must be allowed");

  const noOrigin = await app.request("/api/agents/nope/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.notEqual(noOrigin.status, 403, "a local client sends no Origin and must be allowed");
});

test("a sandboxed iframe's `Origin: null` is refused (#security)", async () => {
  // `null` is what a sandboxed iframe and a cross-origin redirect produce. It parses as a URL with
  // no host, so a naive `new URL(origin)` comparison would be tempted to accept it.
  const app = appWith(mkdtempInRootSync("sec3-"));
  const res = await app.request("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "null", host: "127.0.0.1:7789" },
    body: JSON.stringify({ password: "pwned" }),
  });
  assert.equal(res.status, 403);
});

test("GETs stay readable so the UI can load (#security)", async () => {
  // the refusal is about side effects; a cross-origin read is already blocked by the browser when
  // no CORS headers are sent, so GET must not be gated here or the same-origin UI breaks
  const app = appWith(mkdtempInRootSync("sec4-"));
  const res = await app.request("/api/agents", {
    method: "GET",
    headers: { origin: "https://evil.example", host: "127.0.0.1:7789" },
  });
  assert.notEqual(res.status, 403);
});

test("an unconfigured server ADVERTISES that it has no auth (#security)", async () => {
  /**
   * The advisory's real lesson: the server was open and nobody noticed. A header makes the state
   * observable from any client instead of silent.
   */
  const app = appWith(mkdtempInRootSync("sec5-"));
  const res = await app.request("/api/agents");
  assert.equal(res.headers.get("x-teapot-auth"), "none");
});
