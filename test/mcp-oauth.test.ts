import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { mkdtempInRoot } from "./helpers/tmp-root.ts";
import {
  FLOW_TIMEOUT_MS,
  McpAuthStore,
  ServerAuth,
  listenForCallback,
} from "../src/agent/mcp-oauth-manager.ts";

const tmp = () => mkdtempInRoot("oauth-");

test("the provider stores the grant: access in memory, refresh on disk at 0600 (#67)", async () => {
  const dir = await tmp();
  const store = new McpAuthStore(dir);
  const auth = new ServerAuth("srv", "http://127.0.0.1:1/callback", (s, d) => store.set(s, d));

  assert.equal(auth.tokens(), undefined);
  assert.equal(auth.status().authorized, false);

  await auth.saveTokens({
    access_token: "at-1",
    token_type: "Bearer",
    refresh_token: "rt-1",
    expires_in: 3600,
    scope: "mcp.read",
  });

  const st = auth.status();
  assert.equal(st.authorized, true);
  assert.equal(st.hasRefreshToken, true);

  const back = auth.tokens()!;
  assert.equal(back.access_token, "at-1");
  assert.equal(back.refresh_token, "rt-1");

  const raw = await readFile(path.join(dir, "mcp-oauth.json"), "utf8");
  assert.match(raw, /rt-1/);
  if (process.platform !== "win32") {
    const mode = (await stat(path.join(dir, "mcp-oauth.json"))).mode & 0o777;
    assert.equal(mode, 0o600, `a refresh token is a credential; mode was ${mode.toString(8)}`);
  }

  const again = new ServerAuth("srv", "http://127.0.0.1:1/callback", (s, d) => store.set(s, d));
  await again.hydrate(await store.get("srv"));
  assert.equal(again.tokens()?.refresh_token, "rt-1");
});

test("a ROTATED refresh token is persisted on the spot (#67)", async () => {
  const dir = await tmp();
  const store = new McpAuthStore(dir);
  const auth = new ServerAuth("srv", "http://127.0.0.1:1/callback", (s, d) => store.set(s, d));
  await auth.saveTokens({ access_token: "at-1", token_type: "Bearer", refresh_token: "rt-1" });
  await auth.saveTokens({ access_token: "at-2", token_type: "Bearer", refresh_token: "rt-2" });
  const saved = JSON.parse(await readFile(path.join(dir, "mcp-oauth.json"), "utf8"));
  assert.equal(saved.srv.refreshToken, "rt-2", "the rotated token must replace the old one");
  assert.equal(auth.tokens()?.refresh_token, "rt-2");
});

test("client information round-trips, including fields teapot does not know (#67)", async () => {
  const dir = await tmp();
  const store = new McpAuthStore(dir);
  const auth = new ServerAuth("srv", "http://127.0.0.1:1/callback", (s, d) => store.set(s, d));
  assert.equal(auth.clientInformation(), undefined, "no registration yet");
  await auth.saveClientInformation({
    client_id: "cid",
    client_secret: "sec",
    token_endpoint_auth_method: "none",
  } as never);
  const info = auth.clientInformation() as Record<string, unknown>;
  assert.equal(info.client_id, "cid");
  assert.equal(info.token_endpoint_auth_method, "none", "unknown fields must be preserved");
});

test("redirectToAuthorization exposes the url, and the verifier round-trips (#67)", async () => {
  const dir = await tmp();
  const store = new McpAuthStore(dir);
  const auth = new ServerAuth("srv", "http://127.0.0.1:1/callback", (s, d) => store.set(s, d));
  assert.equal(auth.pendingUrl(), undefined);
  auth.redirectToAuthorization(new URL("https://as.example/authorize?x=1"));
  assert.equal(auth.pendingUrl(), "https://as.example/authorize?x=1");
  assert.equal(auth.status().pending, true);

  await auth.saveCodeVerifier("verifier-xyz");
  assert.equal(auth.codeVerifier(), "verifier-xyz");
});

test("codeVerifier throws rather than returning an empty string (#67)", async () => {
  const dir = await tmp();
  const store = new McpAuthStore(dir);
  const auth = new ServerAuth("srv", "http://127.0.0.1:1/callback", (s, d) => store.set(s, d));
  assert.throws(() => auth.codeVerifier(), /no PKCE verifier/);
});

test("disconnect clears the grant in memory AND on disk (#67)", async () => {
  const dir = await tmp();
  const store = new McpAuthStore(dir);
  const auth = new ServerAuth("srv", "http://127.0.0.1:1/callback", (s, d) => store.set(s, d));
  await auth.saveTokens({ access_token: "at", token_type: "Bearer", refresh_token: "rt" });
  await auth.clear();
  assert.equal(auth.tokens(), undefined);
  assert.equal(auth.status().hasRefreshToken, false);
  const saved = JSON.parse(await readFile(path.join(dir, "mcp-oauth.json"), "utf8"));
  assert.deepEqual(saved.srv, {}, "the credential must be gone from disk too");
});

test("a clientMetadata is a PUBLIC client with the loopback redirect (#67)", async () => {
  const dir = await tmp();
  const store = new McpAuthStore(dir);
  const redirect = "http://127.0.0.1:4321/callback";
  const auth = new ServerAuth("srv", redirect, (s, d) => store.set(s, d));
  const meta = auth.clientMetadata;
  assert.deepEqual(meta.redirect_uris, [redirect]);
  assert.deepEqual(meta.grant_types, ["authorization_code", "refresh_token"]);
  assert.deepEqual(meta.response_types, ["code"]);
  assert.equal(
    (meta as Record<string, unknown>).client_secret,
    undefined,
    "a public client declares no secret",
  );
});

test("the callback listener delivers code and iss, then closes (#67)", async () => {
  const loop = await listenForCallback();
  try {
    assert.match(loop.redirectUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const waiting = loop.wait(5_000);
    const res = await fetch(`${loop.redirectUrl}?code=abc&iss=https%3A%2F%2Fas.example`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.doesNotMatch(body, /window\.close/, "the callback page must not close its own tab");
    assert.match(body, /close this tab/i, "…it should tell the operator to close it instead");

    const got = await waiting;
    assert.equal(got.code, "abc");
    assert.equal(got.iss, "https://as.example");
  } finally {
    await loop.close();
  }
});

test("a SECOND code is refused, so a stray request cannot overwrite the flow (#67)", async () => {
  const loop = await listenForCallback();
  try {
    const waiting = loop.wait(5_000);
    await fetch(`${loop.redirectUrl}?code=first`);
    assert.equal((await waiting).code, "first");
    const again = await fetch(`${loop.redirectUrl}?code=second`);
    assert.equal(again.status, 409, "the listener is one-shot; a second code must be refused");
  } finally {
    await loop.close();
  }
});

test("an error from the authorization server fails the flow with its text (#67)", async () => {
  const loop = await listenForCallback();
  try {
    const waiting = loop.wait(5_000);
    const caught = waiting.catch((e: Error) => e);
    const res = await fetch(`${loop.redirectUrl}?error=access_denied&error_description=nope`);
    assert.equal(res.status, 400);
    const err = await caught;
    assert.match((err as Error).message, /access_denied|nope/);
  } finally {
    await loop.close();
  }
});

test("a non-callback request does not end the flow (#67)", async () => {
  const loop = await listenForCallback();
  try {
    const waiting = loop.wait(5_000);
    const stray = await fetch(loop.redirectUrl.replace("/callback", "/favicon.ico"));
    assert.equal(stray.status, 404);
    await fetch(`${loop.redirectUrl}?code=real`);
    assert.equal((await waiting).code, "real", "the real callback must still be accepted");
  } finally {
    await loop.close();
  }
});

test("the flow gives up rather than hanging forever (#67)", async () => {
  const loop = await listenForCallback();
  try {
    await assert.rejects(() => loop.wait(150), /not completed in time/);
    assert.ok(FLOW_TIMEOUT_MS >= 60_000, "the real timeout must be minutes, not seconds");
  } finally {
    await loop.close();
  }
});

test("a 401 endpoint is reported as needing OAuth, not as broken (#67)", async () => {
  const { McpRegistry } = await import("../src/agent/mcp-registry.ts");
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="OAuth", resource_metadata="http://127.0.0.1:1/meta"',
      });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
  try {
    const reg = new McpRegistry();
    reg.apply([{ name: "guarded", url }]);
    await reg.connectAll();
    const st = reg.states().find((s) => s.config.name === "guarded")!;
    assert.equal(st.status, "error", "it did not connect");
    assert.ok(st.lastError, "an error must be recorded");
    assert.equal(st.oauthRequired, true, "and it must be flagged as needing a grant");
    assert.match(
      String(st.lastError),
      /requires OAuth|authorize/i,
      `the message must point at the fix, got ${JSON.stringify(st.lastError)}`,
    );
    await reg.closeAll();
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
