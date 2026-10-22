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
