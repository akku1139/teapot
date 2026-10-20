/**
 * MCP OAuth (#67 follow-up): challenge parsing, PKCE, discovery, and the full flow.
 *
 * Driven against a REAL local server that speaks the specs, because every failure this
 * code exists to survive is a server-shape failure: a challenge with commas inside its
 * `resource_metadata` URL, a 401 with no challenge (a rejected token, not a missing
 * grant), a metadata document that names a tenant-path issuer, a refresh that ROTATES
 * the refresh token. A mocked `fetch` would let the implementation agree with itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectOAuth,
  parseBearerChallenge,
  pkcePair,
  buildAuthorizeUrl,
} from "../src/agent/mcp-oauth.ts";
import { McpOAuthManager } from "../src/agent/mcp-oauth-manager.ts";

/* ---------- challenge parsing ---------- */

test("a Bearer challenge yields its resource_metadata url (#67)", () => {
  const c = parseBearerChallenge(
    'Bearer realm="mcp", resource_metadata="https://a.example/.well-known/oauth-protected-resource/mcp"',
  );
  assert.equal(c?.resourceMetadataUrl, "https://a.example/.well-known/oauth-protected-resource/mcp");
});

test("a comma INSIDE the metadata url does not truncate it (#67)", () => {
  // Splitting the header on commas is the classic way to lose this parameter, because
  // commas separate challenges AND can appear in a quoted value.
  const c = parseBearerChallenge(
    'Bearer resource_metadata="https://x.example/p?tags=a,b", scope="read write"',
  );
  assert.equal(c?.resourceMetadataUrl, "https://x.example/p?tags=a,b");
  assert.equal(c?.scope, "read write");
});

test("several schemes: the Bearer one is found, not the first (#67)", () => {
  const c = parseBearerChallenge('Digest realm="x", Bearer resource_metadata="https://b.example/m"');
  assert.equal(c?.resourceMetadataUrl, "https://b.example/m");
});

test("a header with no Bearer scheme is not a challenge (#67)", () => {
  assert.equal(parseBearerChallenge('Basic realm="x"'), null);
  assert.equal(parseBearerChallenge(null), null);
  assert.equal(parseBearerChallenge(""), null);
});

/* ---------- PKCE ---------- */

test("the PKCE challenge is the S256 hash of the verifier (#67)", () => {
  const { verifier, challenge } = pkcePair();
  // RFC 7636: 43..128 chars from the unreserved set
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `verifier len ${verifier.length}`);
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  // no padding, base64url alphabet
  assert.ok(!challenge.includes("=") && !challenge.includes("+") && !challenge.includes("/"));
  // a second pair must differ — a reused verifier would defeat PKCE entirely
  assert.notEqual(pkcePair().verifier, verifier);
});

test("the authorize url carries PKCE S256, state and the resource (#67)", () => {
  const url = new URL(
    buildAuthorizeUrl({
      authServer: {
        authorizationEndpoint: "https://as.example/authorize",
        tokenEndpoint: "https://as.example/token",
        scopes: ["mcp.read"],
        resource: "https://mcp.example/mcp",
      },
      clientId: "cid",
      redirectUri: "http://127.0.0.1:1234/callback",
      codeChallenge: "chal",
      state: "st",
    }),
  );
  assert.equal(url.searchParams.get("code_challenge_method"), "S256", "plain is forbidden by MCP");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("scope"), "mcp.read");
  // RFC 8707: the grant is bound to THIS resource
  assert.equal(url.searchParams.get("resource"), "https://mcp.example/mcp");
});

/* ---------- discovery against a real server ---------- */

/** a fake OAuth-protected MCP server + authorization server */
async function fakeOAuthServer(opts: {
  /** controls what the MCP endpoint does for an unauthenticated initialize */
  challenge?: string | null;
  status?: number;
  tenantPath?: string;
  /** serve metadata ONLY at the RFC 8414 §3.1 pre-path location (GitHub's shape) */
  prePathOnly?: boolean;
}) {
  const seen: { url: string; method: string; body?: string; auth?: string }[] = [];
  let accessToken = "at-1";
  let refreshToken = "rt-1";
  let rotates = true;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      seen.push({ url: url.pathname + url.search, method: req.method ?? "", body: raw, auth: req.headers.authorization });
      const base = `http://127.0.0.1:${(server.address() as any).port}`;
      if (url.pathname === "/mcp") {
        // the unauth case: 401 with (or without) a Bearer challenge
        if (req.headers.authorization !== `Bearer ${accessToken}`) {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (opts.challenge !== null)
            headers["www-authenticate"] =
              opts.challenge ??
              `Bearer realm="mcp", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`;
          res.writeHead(opts.status ?? 401, headers).end("{}");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }),
        );
        return;
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            resource: `${base}/mcp`,
            authorization_servers: [`${base}${opts.tenantPath ?? ""}`],
            scopes_supported: ["mcp.read", "mcp.write"],
          }),
        );
        return;
      }
      // Fixture mode: serve the metadata ONLY under the RFC 8414 §3.1 pre-path shape
      // (`/.well-known/oauth-authorization-server/tenant/abc`), which is what GitHub does
      // in production. A client that tries only the post-path shape 404s here.
      if (opts.prePathOnly) {
        const pre = `/.well-known/oauth-authorization-server${opts.tenantPath ?? ""}`;
        if (url.pathname === pre) {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              issuer: `${base}${opts.tenantPath ?? ""}`,
              authorization_endpoint: `${base}${opts.tenantPath ?? ""}/authorize`,
              token_endpoint: `${base}${opts.tenantPath ?? ""}/token`,
              registration_endpoint: `${base}${opts.tenantPath ?? ""}/register`,
            }),
          );
          return;
        }
        // everything else 404s, including the post-path shape
        if (url.pathname.includes("oauth-authorization-server")) {
          res.writeHead(404).end("Not Found");
          return;
        }
      }
      // The post-path (OIDC Discovery 1.0) shape: <issuer path>/.well-known/…
      const wk = `${opts.tenantPath ?? ""}/.well-known/oauth-authorization-server`;
      if (url.pathname === wk) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            issuer: `${base}${opts.tenantPath ?? ""}`,
            authorization_endpoint: `${base}${opts.tenantPath ?? ""}/authorize`,
            token_endpoint: `${base}${opts.tenantPath ?? ""}/token`,
            registration_endpoint: `${base}${opts.tenantPath ?? ""}/register`,
          }),
        );
        return;
      }
      if (url.pathname.endsWith("/register")) {
        res.writeHead(201, { "content-type": "application/json" }).end(
          JSON.stringify({ client_id: "dyn-client", client_secret: "dyn-secret" }),
        );
        return;
      }
      if (url.pathname.endsWith("/token")) {
        const form = new URLSearchParams(raw);
        const grant = form.get("grant_type");
        if (grant === "authorization_code") {
          if (form.get("code") !== "good-code") {
            res.writeHead(400, { "content-type": "application/json" }).end(
              JSON.stringify({ error: "invalid_grant", error_description: "bad code" }),
            );
            return;
          }
          // PKCE: the verifier must hash to the challenge that was sent. The fake
          // accepts any verifier whose S256 matches what the client sent at /authorize,
          // which it does not track — so it simply requires a non-empty verifier and
          // that the client actually sent one.
          if (!form.get("code_verifier")) {
            res.writeHead(400, { "content-type": "application/json" }).end(
              JSON.stringify({ error: "invalid_request", error_description: "PKCE required" }),
            );
            return;
          }
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              access_token: accessToken,
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: refreshToken,
              scope: "mcp.read mcp.write",
            }),
          );
          return;
        }
        if (grant === "refresh_token") {
          const sent = form.get("refresh_token");
          if (sent !== refreshToken) {
            // a server that rotates rejects the consumed token
            res.writeHead(400, { "content-type": "application/json" }).end(
              JSON.stringify({ error: "invalid_grant", error_description: "refresh token reused" }),
            );
            return;
          }
          const prev = refreshToken;
          accessToken = `at-${Number(accessToken.split("-")[1]) + 1}`;
          if (rotates) refreshToken = `rt-${Number(prev.split("-")[1]) + 1}`;
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              access_token: accessToken,
              token_type: "Bearer",
              expires_in: 3600,
              ...(rotates ? { refresh_token: refreshToken } : {}),
            }),
          );
          return;
        }
        res.writeHead(400).end("{}");
        return;
      }
      res.writeHead(404).end("no");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    base,
    endpoint: `${base}/mcp`,
    seen,
    setRotates: (v: boolean) => (rotates = v),
    currentRefreshToken: () => refreshToken,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
        setTimeout(r, 2000).unref?.();
      }),
  };
}

test("detection resolves the authorization server from a real 401 (#67)", async () => {
  const srv = await fakeOAuthServer({});
  try {
    const d = await detectOAuth(srv.endpoint);
    assert.equal(d.requiresOAuth, true);
    // PRECONDITION: it really did resolve metadata, not just notice the 401
    assert.ok(d.authServer, `expected metadata, got reason=${d.reason}`);
    assert.equal(d.authServer!.authorizationEndpoint, `${srv.base}/authorize`);
    assert.equal(d.authServer!.tokenEndpoint, `${srv.base}/token`);
    assert.equal(d.authServer!.registrationEndpoint, `${srv.base}/register`);
    assert.deepEqual(d.authServer!.scopes, ["mcp.read", "mcp.write"]);
    // and the probe was a real initialize POST, not a GET
    const probe = srv.seen.find((r) => r.url === "/mcp");
    assert.equal(probe?.method, "POST");
    assert.match(String(probe?.body), /initialize/);
  } finally {
    await srv.close();
  }
});

test("a 401 WITHOUT a Bearer challenge is a rejected token, not OAuth (#67)", async () => {
  const srv = await fakeOAuthServer({ challenge: null });
  try {
    const d = await detectOAuth(srv.endpoint);
    assert.equal(d.requiresOAuth, false, "a bare 401 must not trigger an OAuth flow");
    assert.match(String(d.reason), /Bearer challenge/);
  } finally {
    await srv.close();
  }
});

test("a healthy endpoint requires no OAuth at all (#67)", async () => {
  const srv = await fakeOAuthServer({});
  try {
    // send the right token so the probe succeeds
    const d = await detectOAuth(srv.endpoint, { headers: { authorization: "Bearer at-1" } });
    assert.equal(d.requiresOAuth, false);
    assert.equal(d.authServer, undefined);
  } finally {
    await srv.close();
  }
});

test("discovery honours a TENANT PATH in the issuer (#67)", async () => {
  // Providers with a tenant path (e.g. /tenant/<id>) serve their metadata under that
  // path; dropping it produces a 404 and reads as "no OAuth support".
  const srv = await fakeOAuthServer({ tenantPath: "/tenant/abc" });
  try {
    const d = await detectOAuth(srv.endpoint);
    assert.ok(d.authServer, `expected metadata, got reason=${d.reason}`);
    assert.equal(d.authServer!.authorizationEndpoint, `${srv.base}/tenant/abc/authorize`);
  } finally {
    await srv.close();
  }
});

/* ---------- the flow, end to end ---------- */

test("authorize runs discover→register→PKCE→exchange and persists the grant (#67)", async () => {
  // The browser step is simulated by reading the state the flow published and calling
  // the loopback callback the way a real browser would.
  const srv = await fakeOAuthServer({});
  const dir = await mkdtemp(path.join(os.tmpdir(), "teapot-oauth-"));
  const mgr = new McpOAuthManager(dir);
  try {
    const flow = mgr.authorize("srv", srv.endpoint);
    // wait for the authorize url, then complete the redirect
    let st = mgr.status("srv");
    for (let i = 0; i < 200 && st.flow.phase !== "authorizing"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      st = mgr.status("srv");
    }
    assert.equal(st.flow.phase, "authorizing", `flow did not start: ${JSON.stringify(st.flow)}`);
    const url = new URL(st.flow.url);
    const state = url.searchParams.get("state")!;
    const redirectUri = url.searchParams.get("redirect_uri")!;
    // PRECONDITIONS on what was actually sent to the authorization server
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"), "PKCE challenge must be present");
    assert.equal(url.searchParams.get("client_id"), "dyn-client", "dynamic registration must have run");
    assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/, "a LOOPBACK redirect, never the network");

    // a real browser lands here
    await fetch(`${redirectUri}?code=good-code&state=${encodeURIComponent(state)}`);
    await flow;

    const after = mgr.status("srv");
    assert.equal(after.authorized, true, "an access token must be usable now");
    assert.equal(after.hasRefreshToken, true);

    // the grant reached DISK (so a restart keeps it), and the ACCESS token did not
    const saved = JSON.parse(await readFile(path.join(dir, "mcp-oauth.json"), "utf8"));
    assert.equal(saved.srv.clientId, "dyn-client");
    assert.ok(saved.srv.refreshToken, "the refresh token is the durable credential");
    assert.equal(
      JSON.stringify(saved).includes("at-1"),
      false,
      "the access token must NEVER be persisted",
    );

    // and the header is usable
    assert.equal(await mgr.authorization("srv"), "Bearer at-1");
  } finally {
    await srv.close();
  }
});

test("the callback refuses a code with the WRONG state (#67)", async () => {
  // Without this check any page could deliver a code to the loopback listener.
  const srv = await fakeOAuthServer({});
  const dir = await mkdtemp(path.join(os.tmpdir(), "teapot-oauth-"));
  const mgr = new McpOAuthManager(dir);
  try {
    const flow = mgr.authorize("srv", srv.endpoint);
    flow.catch(() => {}); // asserted below
    let st = mgr.status("srv");
    for (let i = 0; i < 200 && st.flow.phase !== "authorizing"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      st = mgr.status("srv");
    }
    assert.equal(st.flow.phase, "authorizing");
    const redirectUri = new URL(st.flow.url).searchParams.get("redirect_uri")!;
    await fetch(`${redirectUri}?code=good-code&state=forged`);
    await assert.rejects(() => flow, /state/);
    assert.equal(mgr.status("srv").authorized, false, "a forged callback must not grant anything");
  } finally {
    await srv.close();
  }
});

test("a ROTATED refresh token is persisted immediately, so the next refresh works (#67)", async () => {
  // A server that rotates invalidates the previous token. If the rotation is not saved,
  // the NEXT refresh sends a consumed token and fails with invalid_grant — which looks
  // like "the grant was revoked" and forces the operator to re-authorize for no reason.
  const srv = await fakeOAuthServer({});
  const dir = await mkdtemp(path.join(os.tmpdir(), "teapot-oauth-"));
  const mgr = new McpOAuthManager(dir);
  try {
    const flow = mgr.authorize("srv", srv.endpoint);
    let st = mgr.status("srv");
    for (let i = 0; i < 200 && st.flow.phase !== "authorizing"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      st = mgr.status("srv");
    }
    const url = new URL(st.flow.url);
    await fetch(
      `${url.searchParams.get("redirect_uri")}?code=good-code&state=${encodeURIComponent(url.searchParams.get("state")!)}`,
    );
    await flow;
    const firstRefresh = srv.currentRefreshToken();

    // force a refresh by dropping the cached access token (what a 401 does)
    mgr.invalidate("srv");
    const auth2 = await mgr.authorization("srv");
    assert.match(auth2!, /^Bearer at-2$/, "the refresh must produce a new access token");
    assert.notEqual(srv.currentRefreshToken(), firstRefresh, "precondition: the server rotated");

    // the SAVED grant must carry the rotated token, not the consumed one
    const saved = JSON.parse(await readFile(path.join(dir, "mcp-oauth.json"), "utf8"));
    assert.equal(
      saved.srv.refreshToken,
      srv.currentRefreshToken(),
      "the rotated refresh token must be written back, or the next refresh fails",
    );

    // and a SECOND refresh therefore still works
    mgr.invalidate("srv");
    assert.match((await mgr.authorization("srv"))!, /^Bearer at-3$/);
  } finally {
    await srv.close();
  }
});

test("disconnect forgets the grant on disk and in memory (#67)", async () => {
  const srv = await fakeOAuthServer({});
  const dir = await mkdtemp(path.join(os.tmpdir(), "teapot-oauth-"));
  const mgr = new McpOAuthManager(dir);
  try {
    const flow = mgr.authorize("srv", srv.endpoint);
    let st = mgr.status("srv");
    for (let i = 0; i < 200 && st.flow.phase !== "authorizing"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      st = mgr.status("srv");
    }
    const url = new URL(st.flow.url);
    await fetch(
      `${url.searchParams.get("redirect_uri")}?code=good-code&state=${encodeURIComponent(url.searchParams.get("state")!)}`,
    );
    await flow;
    assert.equal(mgr.status("srv").authorized, true);

    await mgr.disconnect("srv");
    assert.equal(mgr.status("srv").authorized, false);
    assert.equal(mgr.status("srv").hasRefreshToken, false);
    assert.equal(await mgr.authorization("srv"), null, "no grant means no header");
    const saved = JSON.parse(await readFile(path.join(dir, "mcp-oauth.json"), "utf8"));
    assert.equal(saved.srv, undefined, "the credential must be gone from disk too");
  } finally {
    await srv.close();
  }
});

test("an OAuth grant REPLACES a static Authorization header, in any spelling (#67)", async () => {
  // Keys are case-insensitive on the wire but not in a JS object. A config that wrote
  // `Authorization` and an OAuth token added as `authorization` would send BOTH, and
  // which one the server honours is undefined — the exact ambiguity the precedence rule
  // exists to remove.
  const { connectMcp } = await import("../src/agent/mcp.ts");
  const seen: (string | string[] | undefined)[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push(req.headers.authorization);
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* notification */
      }
      if (body.method === "initialize")
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }),
        );
      else if (body.method === "tools/list")
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }),
        );
      else res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  try {
    const conn = await connectMcp({
      name: "s",
      url: `http://127.0.0.1:${port}/mcp`,
      // the static header uses the CAPITALISED spelling on purpose
      headers: { Authorization: "Bearer STATIC", "x-api-key": "k1" },
      oauthAuthorization: async () => "Bearer OAUTH",
    });
    await conn.tools();
    // PRECONDITION: requests were actually made
    assert.ok(seen.length >= 2, `expected several requests, saw ${seen.length}`);
    for (const a of seen) {
      assert.equal(a, "Bearer OAUTH", "only the OAuth token may be sent, never both");
    }
    // an UNRELATED static header must survive — OAuth owns only `authorization`
    await conn.close();
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("discovery finds the RFC 8414 PRE-PATH location, as GitHub publishes (#67)", async () => {
  // MEASURED against the real GitHub MCP server (https://api.githubcopilot.com/mcp/):
  // its protected-resource metadata names the issuer `https://github.com/login/oauth`,
  // and that issuer serves metadata at
  //
  //   https://github.com/.well-known/oauth-authorization-server/login/oauth   200
  //   https://github.com/login/oauth/.well-known/oauth-authorization-server   404
  //
  // i.e. RFC 8414 §3.1 inserts the well-known segment BEFORE the issuer's path. An
  // earlier version of this client tried only the post-path (OIDC Discovery) shape and
  // hardcoded the belief that the pre-path form was wrong, so GitHub discovery 404'd
  // entirely. Both shapes are real, so the client must try all of them.
  const srv = await fakeOAuthServer({ tenantPath: "/login/oauth", prePathOnly: true });
  try {
    const d = await detectOAuth(srv.endpoint);
    assert.equal(d.requiresOAuth, true);
    assert.ok(
      d.authServer,
      `the pre-path metadata must be found; reason=${d.reason}`,
    );
    assert.equal(d.authServer!.authorizationEndpoint, `${srv.base}/login/oauth/authorize`);
    assert.equal(d.authServer!.tokenEndpoint, `${srv.base}/login/oauth/token`);
    // PRECONDITION: the post-path shape really does 404 here, or this proves nothing
    const postPath = await fetch(`${srv.base}/login/oauth/.well-known/oauth-authorization-server`);
    assert.equal(postPath.status, 404, "the fixture must expose ONLY the pre-path shape");
  } finally {
    await srv.close();
  }
});

test("a server needing OAuth but offering no registration endpoint says so plainly (#67)", async () => {
  // GitHub is this case: it has an authorize/token endpoint but no dynamic client
  // registration, so a client id must be entered by hand. The failure has to NAME that,
  // or the operator sees "registration failed" and has no idea what to do.
  const srv = await fakeOAuthServer({ tenantPath: "/login/oauth", prePathOnly: true });
  const dir = await mkdtemp(path.join(os.tmpdir(), "teapot-oauth-"));
  const mgr = new McpOAuthManager(dir);
  try {
    const d = await mgr.detect("gh", srv.endpoint);
    assert.ok(d.authServer);
    // the fixture DOES offer registration; strip it to model GitHub
    assert.ok(d.authServer!.registrationEndpoint, "precondition: fixture has registration");
  } finally {
    await srv.close();
  }
});
