/**
 * The PKCE verifier must survive the instance being rebuilt.
 *
 * Reported: "現在登録済みのNotion MCPのOAuthを済ませたのに error になってる".
 *
 * The verifier is the secret half of PKCE — the authorization request carries its SHA-256
 * challenge, and the token request must present the verifier itself. Two defects made it
 * unavailable:
 *
 *   1. `saveCodeVerifier` set the in-memory field and the store copy but never called `persist()`,
 *      so it was the one mutation that never reached disk. MEASURED against the real store:
 *      `clientId`/`clientSecret`/`clientInformation` were written and `codeVerifier` was ABSENT.
 *   2. `hydrate` copied the store but did not restore the field `codeVerifier()` reads, so even a
 *      persisted value was unusable after a rebuild.
 *
 * Either one turns the exchange into `invalid_grant` — MEASURED against Notion's live `/token`:
 * a request with a bogus code and a valid client secret reaches `invalid_grant` (i.e. the code is
 * rejected), while the same request without a verifier fails earlier and differently. The redirect
 * URI was ruled out the same way: Notion accepts a mismatched loopback PORT.
 */
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
  /**
   * This is the case that breaks a real authorization: the grant is complete in the browser, a
   * fresh provider is constructed for `finishAuth`, and it must present the SAME verifier whose
   * challenge was sent at the start.
   */
  let persisted: { codeVerifier?: string } | undefined;
  const first = mkAuth(async (_s, data) => { persisted = data as { codeVerifier?: string }; });
  await first.saveCodeVerifier("verifier-xyz");

  const rebuilt = mkAuth(async () => {});
  await rebuilt.hydrate({ ...persisted });
  assert.equal(rebuilt.codeVerifier(), "verifier-xyz", "hydrate must restore the field the exchange reads");
});

test("with no verifier it still refuses loudly, rather than exchanging blind (#mcp)", async () => {
  // a silent exchange without a verifier is a guaranteed server-side rejection; a throw names the cause
  const auth = mkAuth(async () => {});
  assert.throws(() => auth.codeVerifier(), /no PKCE verifier/);
});

test("a registration made with a DIFFERENT redirect URI is not reused (#mcp)", async () => {
  /**
   * The authorization completes in the browser, `codeVerifier` is persisted, and no access token is
   * ever written — reported as "NotionのOAuthが完走してるのに Unauthorized".
   *
   * MEASURED from this machine's real store: `clientInformation.redirect_uris` was
   * `["http://127.0.0.1/callback"]` — NO PORT — because it was registered from the placeholder
   * provider in `authFor()`. Every real flow runs on `http://127.0.0.1:<port>/callback`, so the
   * authorize request names a URI the server never registered against that client.
   *
   * The provider must therefore REFUSE a stale registration and let the SDK register afresh against
   * the current URI — keeping the same client id/secret, since those are what the server bound.
   */
  const auth = mkAuth(async () => {});
  await auth.hydrate({
    clientId: "cid",
    clientSecret: "csec",
    clientInformation: {
      client_id: "cid",
      client_secret: "csec",
      redirect_uris: ["http://127.0.0.1/callback"], // portless: cannot match this run
    },
  } as never);
  assert.equal(
    auth.clientInformation(),
    undefined,
    "a registration for another redirect URI must not be reused, or the exchange is rejected",
  );

  // one that DOES match this instance's redirect is reused, so a repeat flow needs no re-register
  const same = mkAuth(async () => {});
  await same.hydrate({
    clientId: "cid",
    clientInformation: {
      client_id: "cid",
      redirect_uris: ["http://127.0.0.1:1234/callback"], // matches mkAuth's redirectUrl
    },
  } as never);
  assert.ok(same.clientInformation(), "a matching registration is kept");
});

test("the DISCOVERY state survives the instance being rebuilt too (#mcp)", async () => {
  /**
   * The third defect, and the one that outlived the other two.
   *
   * The flow spans two transport instances: the one that hits the 401 and redirects the browser,
   * and the one built after the callback arrives. The SDK records the authorization server URL and
   * its metadata during discovery and validates the authorization response's `iss` against that
   * record when the code is redeemed (RFC 9207). Its contract says this "MUST persist with the same
   * durability as `codeVerifier` (survives the redirect round-trip)".
   *
   * MEASURED against this machine's real store after a BROWSER-COMPLETED Notion authorization:
   * `codeVerifier` was present, `clientInformation.redirect_uris` was a real ephemeral port, and
   * `accessToken` was absent — so both earlier fixes were doing their job and the exchange still
   * never produced tokens.
   */
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
  // `undefined` makes the SDK DISCOVER rather than trust a half-record; an empty object would be
  // treated as a cache hit and skip the discovery it actually needs
  const auth = mkAuth(async () => {});
  assert.equal(auth.discoveryState(), undefined);
});

test("the issuer is supplied from OUR discovery record when the callback omits it (#mcp)", async () => {
  /**
   * Notion declares `authorization_response_iss_parameter_supported: true` and then does NOT send
   * `iss`. RFC 9207 §2 makes that parameter a MUST for a server advertising support, and §2.4 makes
   * client-side rejection a MUST — so a strict client throws away every browser-completed
   * authorization. That is "Notionがコールバック踏んだのに Unauthorized".
   *
   * MEASURED against the real SDK with this machine's stored grant:
   *   no iss      -> IssuerMismatchError: expected "https://mcp.notion.com", received undefined
   *   correct iss -> the token endpoint is reached (invalid_grant for a deliberately dummy code)
   *   wrong iss   -> IssuerMismatchError: received "https://evil.example"
   *
   * §2.4 permits the tolerant reading: clients "MAY accept authorization responses that do not
   * contain the iss parameter ... Local policy or configuration can determine whether to accept".
   * So the issuer comes from the discovery document we fetched BEFORE sending the browser out, and
   * the SDK still rejects a genuinely mismatched value.
   */
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
  // some records carry only the URL; falling back to it is better than sending no issuer and having
  // the SDK reject an otherwise-valid authorization
  const auth = mkAuth(async () => {});
  await auth.saveDiscoveryState({ authorizationServerUrl: "https://example.test" } as never);
  assert.equal(auth.expectedIssuer(), "https://example.test");
});

test("a transport is ONE-SHOT, so finishAuth must hand back a fresh connection (#mcp)", async () => {
  /**
   * "Notion MCPで認証完走したのに UnauthorizedError: Unauthorized" — for the third time, and this
   * was the real reason.
   *
   * `finishAuth()` used to end with `client.connect(session)` to "complete the handshake". But the
   * transport that got the 401 is SPENT: MEASURED against `mcp.notion.com`, connecting the same
   * transport a second time throws `StreamableHTTPClientTransport already started!` whether or not
   * `close()` ran. So the connection could never serve, and the failure surfaced as the SDK's
   * `UnauthorizedError`, whose message defaults to the bare word "Unauthorized".
   *
   * The exchange itself had succeeded — the tokens were stored — which is why the report read as
   * "認証完走したのに". The interface now returns a NEW `McpConnection`, and this pins the shape:
   * a `Promise<void>` would compile while leaving the caller holding a dead handle.
   */
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
