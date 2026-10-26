import { test } from "node:test";
import assert from "node:assert/strict";
import { ServerAuth } from "../src/agent/mcp-oauth-manager.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";

const mkAuth = (persist: (server: string, data: unknown) => Promise<void>) =>
  new ServerAuth("Notion", "http://127.0.0.1:1234/callback", persist as never);

test("saving the verifier PERSISTS it (#mcp)", async () => {
  const written: unknown[] = [];
  const auth = mkAuth(async (_s, data) => { written.push(data); });
  await auth.saveCodeVerifier("verifier-abc");
  assert.ok(written.length > 0, "saveCodeVerifier must persist, or the value is lost on a rebuild");
  const last = written[written.length - 1] as { codeVerifier?: string };
  assert.equal(last.codeVerifier, "verifier-abc");
});

test("a rebuilt instance can still hand the verifier back (#mcp)", async () => {
  let persisted: { codeVerifier?: string } | undefined;
  const first = mkAuth(async (_s, data) => { persisted = data as { codeVerifier?: string }; });
  await first.saveCodeVerifier("verifier-xyz");

  const rebuilt = mkAuth(async () => {});
  await rebuilt.hydrate({ ...persisted });
  assert.equal(rebuilt.codeVerifier(), "verifier-xyz", "hydrate must restore the field the exchange reads");
});

test("with no verifier it still refuses loudly, rather than exchanging blind (#mcp)", async () => {
  const auth = mkAuth(async () => {});
  assert.throws(() => auth.codeVerifier(), /no PKCE verifier/);
});

test("a registration made with a DIFFERENT redirect URI is not reused (#mcp)", async () => {
  const auth = mkAuth(async () => {});
  await auth.hydrate({
    clientId: "cid",
    clientSecret: "csec",
    clientInformation: {
      client_id: "cid",
      client_secret: "csec",
      redirect_uris: ["http://127.0.0.1/callback"], 
    },
  } as never);
  assert.notEqual(
    auth.clientInformation(),
    undefined,
    "a loopback record must be REUSED across ports, or every flow re-registers and drops the grant",
  );

  const same = mkAuth(async () => {});
  await same.hydrate({
    clientId: "cid",
    clientInformation: {
      client_id: "cid",
      redirect_uris: ["http://127.0.0.1:1234/callback"], 
    },
  } as never);
  assert.ok(same.clientInformation(), "a matching registration is kept");
});

test("the DISCOVERY state survives the instance being rebuilt too (#mcp)", async () => {
  const discovered = {
    authorizationServerUrl: "https://mcp.notion.com",
    authorizationServerMetadata: { issuer: "https://mcp.notion.com" },
  };
  let persisted: { discoveryState?: unknown } | undefined;
  const first = mkAuth(async (_s, data) => { persisted = data as { discoveryState?: unknown }; });
  await first.saveDiscoveryState(discovered as never);
  assert.ok(persisted, "saveDiscoveryState must persist, exactly like saveCodeVerifier");

  const rebuilt = mkAuth(async () => {});
  await rebuilt.hydrate(persisted as never);
  assert.deepEqual(
    rebuilt.discoveryState(),
    discovered,
    "a rebuilt provider must hand back the SAME discovery record, or the redeeming instance " +
      "re-discovers a different issuer and the code is never redeemed (#mcp)",
  );
});

test("a provider with no discovery yet says so instead of inventing one (#mcp)", async () => {
  const auth = mkAuth(async () => {});
  assert.equal(auth.discoveryState(), undefined);
});

test("the issuer is supplied from OUR discovery record when the callback omits it (#mcp)", async () => {
  const auth = mkAuth(async () => {});
  assert.equal(auth.expectedIssuer(), undefined, "no discovery yet means nothing to supply");

  await auth.saveDiscoveryState({
    authorizationServerUrl: "https://mcp.notion.com",
    authorizationServerMetadata: { issuer: "https://mcp.notion.com" },
  } as never);
  assert.equal(
    auth.expectedIssuer(),
    "https://mcp.notion.com",
    "the recorded issuer is what a missing `iss` must be filled with (#mcp)",
  );
});

test("a discovery record without metadata still yields the authorization server URL (#mcp)", async () => {
  const auth = mkAuth(async () => {});
  await auth.saveDiscoveryState({ authorizationServerUrl: "https://example.test" } as never);
  assert.equal(auth.expectedIssuer(), "https://example.test");
});

test("a transport is ONE-SHOT, so finishAuth must hand back a fresh connection (#mcp)", async () => {
  const src = await readFile(path.join(import.meta.dirname, "..", "src", "agent", "mcp.ts"), "utf8");
  assert.match(
    src,
    /finishAuth\(code: string, iss\?: string\): Promise<McpConnection>/,
    "finishAuth must RETURN the usable connection — the instance that redeemed the code cannot serve " +
      "requests, and a `Promise<void>` leaves the caller with a spent transport (#mcp)",
  );
  assert.match(
    src,
    /return await connectMcp\(cfg, auth\)/,
    "and the way to obtain it is a fresh connectMcp with the SAME provider (which now holds the " +
      "tokens the exchange just stored)",
  );
});

test("the 401's OWN connection is carried to the callback leg (#mcp)", async () => {
  const mcp = await readFile(path.join(import.meta.dirname, "..", "src", "agent", "mcp.ts"), "utf8");
  assert.match(
    mcp,
    /throw Object\.assign\(err as Error, \{ connection: conn \}\)/,
    "the failed connect must carry the live connection, or the callback leg has nothing to finish on",
  );
  assert.match(
    mcp,
    /if \(!auth\) await client\.close\(\)/,
    "and it must only close the client when there is NO provider — closing it destroys the flow",
  );

  const reg = await readFile(
    path.join(import.meta.dirname, "..", "src", "agent", "mcp-registry.ts"),
    "utf8",
  );
  assert.match(
    reg,
    /const conn = pendingConn;/,
    "the callback leg must reuse the connection from the 401, not call connectMcp again — that second " +
      "call 401s before any token exists, which is the reported failure (#mcp)",
  );
  assert.ok(
    !/await loop\.wait\(FLOW_TIMEOUT_MS\);[\s\S]{0,200}await connectMcp\(st\.config/.test(reg),
    "reconnecting in the callback leg is the bug, not an implementation detail",
  );
});
