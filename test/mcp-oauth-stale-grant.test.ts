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

test("a placeholder redirect cannot vouch for a stored grant (#mcp)", async () => {
  /**
   * The reported path: a plain reconnect, which uses the placeholder provider. Trusting the grant
   * here is what produced `Client ID mismatch` with no way for the operator to understand it.
   */
  const { auth } = await mk("http://127.0.0.1/callback");
  assert.equal(
    auth.tokens(),
    undefined,
    "without a listener-backed redirect there is no evidence the grant still applies, so it must " +
      "not be presented — the failure it causes names the CLIENT, not the actual problem",
  );
});

test("a grant IS used when the stored registration matches a real listener (#mcp)", async () => {
  // the healthy case must keep working: a reused port means the registration is genuinely current
  const { auth } = await mk("http://127.0.0.1:41234/callback");
  const stored = {
    ...STALE,
    clientInformation: { client_id: "old-client", redirect_uris: ["http://127.0.0.1:41234/callback"] },
  };
  const a2 = new ServerAuth("srv", "http://127.0.0.1:41234/callback", async () => {});
  await a2.hydrate(structuredClone(stored));
  assert.ok(a2.tokens(), "a matching registration keeps its grant — no needless re-authorization");
  // and the placeholder instance above is NOT the same situation
  assert.equal(auth.tokens(), undefined);
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
