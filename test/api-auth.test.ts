import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { useTempDir } from "./helpers/tmp.ts";
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
  await useTempDir("auth-root-", async (dataDir) => {
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
      // #79: `?token=` is no longer accepted on ordinary API routes. A browser
      // WebSocket handshake cannot send an Authorization header, so the query
      // form is needed for the two sockets — and only those two. Accepting it
      // everywhere put the secret into proxy access logs, Referer headers and
      // browser history for requests that never needed it.
      assert.equal(
        (await gated.request("/api/agents?token=sekrit")).status,
        401,
        "?token= must NOT authenticate an ordinary API route (#79)",
      );
      // the header still works everywhere, so nothing that functioned breaks
      assert.equal(
        (await gated.request("/api/agents?token=sekrit", { headers: { authorization: "Bearer sekrit" } }))
          .status,
        200,
        "the header remains the way to authenticate a normal route (#79)",
      );
      // and the WebSocket routes still accept the query form
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

/**
 * #79 — `?token=` is accepted only on the two WebSocket routes.
 *
 * The narrowing must not break the UI: a browser handshake cannot send an
 * Authorization header, so `wsTokenQuery()` is the ONLY way the web UI
 * authenticates its two sockets. If these fail, every open tab loses its event
 * stream and its terminal.
 */
test("the WebSocket routes reject a bad ?token= and nothing else (#79)", async () => {
  await useTempDir("auth-ws-", async (dataDir) => {
    const master = mkMaster(dataDir);
    process.env.TEAPOT_API_TOKEN = "sekrit";
    try {
      const gated = buildApp(master);
      // Hono answers the upgrade request itself, so the status tells us whether
      // the gate let the handshake through — no socket is actually opened.
      assert.equal((await gated.request("/api/ws")).status, 401, "no token must fail (#79)");
      assert.equal((await gated.request("/api/ws?token=nope")).status, 401, "a wrong ?token= must fail (#79)");
      assert.equal(
        (await gated.request("/api/agents/some-agent/term?token=nope")).status,
        401,
        "a wrong ?token= must fail on the terminal socket too (#79)",
      );
      // the header works on the sockets as well, so the allowlist is additive
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

test("the query-token allowlist is exactly the two sockets (#79)", () => {
  const src = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
  assert.match(src, /path === "\/api\/ws"/, "/api/ws must be allowed (#79)");
  assert.match(src, /\^\\\/api\\\/agents\\\/\[\^\/\]\+\\\/term\$/, "the terminal socket must be allowed (#79)");
  // and nothing broader: a bare prefix match on /api/ would defeat the point
  assert.doesNotMatch(
    src,
    /tokenInQueryOk[\s\S]{0,200}startsWith\("\/api\/"\)/,
    "the allowlist must not widen to all of /api (#79)",
  );
  assert.doesNotMatch(
    src,
    /tokenInQueryOk[\s\S]{0,200}startsWith\("\/api\/agents\/"\)/,
    "a prefix on /api/agents/ would allow every agent route (#79)",
  );
});
