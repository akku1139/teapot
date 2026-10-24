import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { ServerAuth } from "../src/agent/mcp-oauth-manager.ts";

/**
 * A grant obtained under a client that can no longer be reused must NOT be presented.
 *
 * Reported as an MCP regression on a running server: Notion and Canva both answered
 * `invalid_grant: Client ID mismatch` on every reconnect, while the store still held a token that
 * looked valid. MEASURED on the token request: `grant_type=refresh_token` authenticated as the
 * STORED client id, and the authorization server rejected it.
 *
 * The cause is the interaction of two things that are individually right:
 *
 *   - `clientInformation()` returns undefined when the stored registration cannot match this run's
 *     redirect URI, so the SDK re-registers — correct;
 *   - `authFor()` builds that provider with a PLACEHOLDER redirect (`http://127.0.0.1/callback`, no
 *     port, because none exists until a flow opens a listener) — also correct, since the SDK only
 *     reads it during authorize.
 *
 * Together, a record registered from the same placeholder MATCHES, the staleness check says "fine",
 * and the old refresh token is used against a client the server no longer knows.
 *
 * The fix refuses to trust a registration it cannot confirm: without a port there is no evidence the
 * grant still applies, so the flow becomes an honest "needs a grant" and the panel offers 🔑.
 */
const STALE = {
  clientId: "old-client",
  clientSecret: "old-secret",
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: Date.now() + 3_600_000,
  clientInformation: {
    client_id: "old-client",
    client_secret: "old-secret",
    // the shape teapot itself writes from the placeholder provider: no port
    redirect_uris: ["http://127.0.0.1/callback"],
  },
};

const mk = async (redirectUrl: string) => {
  const saved: unknown[] = [];
  const auth = new ServerAuth("srv", redirectUrl, async (_n, d) => void saved.push(d));
  await auth.hydrate(structuredClone(STALE));
  return { auth, saved };
};

test("a placeholder reconnect KEEPS the grant; a real mismatch declines it (#mcp)", async () => {
  /**
   * CORRECTED. This test used to assert that a portless placeholder DROPPED the grant, and that
   * "fix" is what broke MCP authentication: `authFor()` builds every reconnect's provider with
   * `http://127.0.0.1/callback`, so the check fired on EVERY reconnect and `tokens()` erased the
   * stored tokens. MEASURED: both Notion's and Canva's grants were gone from `mcp-oauth.json`
   * minutes after a successful authorization.
   *
   * The distinction that matters: DECLINE a presentation, never DELETE the stored value. Declining
   * is reversible; erasing costs a full re-authorization.
   */
  const placeholder = new ServerAuth("srv", "http://127.0.0.1/callback", async () => {});
  await placeholder.hydrate(structuredClone(STALE));
  assert.ok(
    placeholder.tokens(),
    "a portless placeholder cannot refute a registration, so it must not discard the grant (#mcp)",
  );
  // a listener-backed URL the record does not list IS a genuine mismatch, and is still declined
  const mismatch = new ServerAuth("srv", "http://127.0.0.1:59999/callback", async () => {});
  await mismatch.hydrate(structuredClone(STALE));
  assert.equal(mismatch.tokens(), undefined, "a genuinely mismatched client is still not presented");
});

test("a grant IS used when the stored registration matches a real listener (#mcp)", async () => {
  // the healthy case must keep working: a reused port means the registration is genuinely current
  const stored = {
    ...STALE,
    clientInformation: { client_id: "old-client", redirect_uris: ["http://127.0.0.1:41234/callback"] },
  };
  const a2 = new ServerAuth("srv", "http://127.0.0.1:41234/callback", async () => {});
  await a2.hydrate(structuredClone(stored));
  assert.ok(a2.tokens(), "a matching registration keeps its grant — no needless re-authorization");
});

test("a rotated client id drops the tokens of the old one (#mcp)", async () => {
  // registering afresh must not leave a refresh token bound to the previous client
  const auth = new ServerAuth("srv", "http://127.0.0.1:41234/callback", async () => {});
  await auth.hydrate(structuredClone(STALE));
  await auth.saveClientInformation({
    client_id: "brand-new-client",
    redirect_uris: ["http://127.0.0.1:41234/callback"],
  } as never);
  assert.equal(
    auth.tokens(),
    undefined,
    "a token issued to the previous client cannot be refreshed by the new one",
  );
});
