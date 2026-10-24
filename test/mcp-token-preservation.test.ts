import { test } from "node:test";
import assert from "node:assert/strict";
import { ServerAuth } from "../src/agent/mcp-oauth-manager.ts";

/**
 * An unverifiable registration must DECLINE the grant, never DELETE it.
 *
 * MEASURED on this machine: both Notion's and Canva's `accessToken`/`refreshToken` were gone from
 * `mcp-oauth.json` minutes after a successful authorization, and the panel said "needs a grant".
 * The authorizations had worked; the store had been emptied by this code.
 *
 * The mechanism was `tokens()` clearing the fields when `registrationIsStale()` said yes, and
 * `authFor()` builds EVERY reconnect's provider with a portless placeholder
 * (`http://127.0.0.1/callback`) — which that check called stale unconditionally. So the first
 * reconnect after an authorization erased it, and persisted the erasure.
 *
 * Declining is reversible (the next verifiable connect reads the tokens again). Erasing costs a full
 * re-authorization for a transient uncertainty. That asymmetry is the rule.
 */
const withTokens = {
  clientId: "cid",
  clientSecret: "sec",
  accessToken: "ACCESS",
  refreshToken: "REFRESH",
  expiresAt: Date.now() + 3_600_000,
  clientInformation: { client_id: "cid", redirect_uris: ["http://127.0.0.1:41234/callback"] },
};

test("a placeholder reconnect KEEPS the stored grant (#mcp)", async () => {
  // the exact provider `authFor()` builds — no port, because none exists until a flow opens one
  const auth = new ServerAuth("srv", "http://127.0.0.1/callback", async () => {});
  await auth.hydrate(structuredClone(withTokens));
  const t = auth.tokens();
  assert.ok(
    t,
    "a portless placeholder cannot refute a registration, so it must not discard the grant — " +
      "doing so erased a working authorization minutes after it was obtained (#mcp)",
  );
  assert.equal(t!.access_token, "ACCESS", "and the value must be the stored one");
});

test("a REAL mismatch still declines the grant (#mcp)", async () => {
  /**
   * The guard that must survive: a redirect for a DIFFERENT HOST is a genuine mismatch, and
   * presenting a token for the wrong client is what produced `Client ID mismatch`. Declining (not
   * deleting) keeps it recoverable.
   *
   * CORRECTED: this used a different loopback PORT and called that a mismatch. That assumption is
   * what destroyed grants — MEASURED: Notion's record held `http://127.0.0.1:33337/callback`, the
   * ephemeral port of the authorizing flow, so every reconnect looked like a mismatch, re-registered,
   * got a new client_id, and (correctly) dropped the tokens. A loopback port is the listener's, not
   * the client's (RFC 8252 §7.3), so only the host distinguishes a real mismatch.
   */
  const auth = new ServerAuth("srv", "https://example.test/callback", async () => {});
  await auth.hydrate(structuredClone(withTokens));
  assert.equal(
    auth.tokens(),
    undefined,
    "a token for a client the server no longer knows must not be presented (#mcp)",
  );
});

test("declining does not DELETE what is stored (#mcp)", async () => {
  // the distinction the bug collapsed: "do not present" ≠ "throw away"
  const writes: unknown[] = [];
  const auth = new ServerAuth("srv", "http://127.0.0.1:59999/callback", async (_n, d) => {
    writes.push(structuredClone(d));
  });
  await auth.hydrate(structuredClone(withTokens));
  auth.tokens(); // declines
  for (const w of writes) {
    const s = w as { accessToken?: string; refreshToken?: string };
    assert.equal(
      s.accessToken,
      "ACCESS",
      "declining a presentation must leave the stored token intact — erasing costs a full " +
        "re-authorization for a transient uncertainty (#mcp)",
    );
    assert.equal(s.refreshToken, "REFRESH");
  }
});

/**
 * A loopback PORT is not part of a client's identity.
 *
 * The callback binds an EPHEMERAL port (`server.listen(0)`), so a registration is always made on a
 * different port from the one the next run listens on. Comparing them literally means "never
 * matches", which re-registers, which issues a NEW client_id, which `saveClientInformation` correctly
 * treats as invalidating the grant.
 *
 * MEASURED from the real store on this machine: Notion held
 * `redirect_uris: ["http://127.0.0.1:33337/callback"]` and Canva
 * `["http://127.0.0.1/callback"]`; Canva's entry had NO `accessToken`/`refreshToken`, i.e. the
 * authorization had worked and the tokens were thrown away by this loop. Reported as "Canvaはなぜか
 * 認証が外れて invalid_token".
 *
 * RFC 8252 §7.3 lets a loopback redirect use any port, so only the host/path distinguish a
 * registration.
 */
test("the same registration is reused across loopback ports (#mcp)", async () => {
  const stored = {
    clientId: "cid",
    clientSecret: "sec",
    accessToken: "ACCESS",
    refreshToken: "REFRESH",
    expiresAt: Date.now() + 3_600_000,
    clientInformation: { client_id: "cid", redirect_uris: ["http://127.0.0.1:33337/callback"] },
  };
  // a LATER run listens on a different ephemeral port
  const auth = new ServerAuth("srv", "http://127.0.0.1:44991/callback", async () => {});
  await auth.hydrate(structuredClone(stored));
  assert.ok(
    auth.clientInformation(),
    "the stored registration must be REUSED — re-registering issues a new client_id and the grant " +
      "is dropped with it (#mcp)",
  );
  assert.ok(auth.tokens(), "and the grant stays usable, because nothing invalidated it (#mcp)");
});

test("a different PATH on loopback is a different registration (#mcp)", async () => {
  // the port is the listener's business; the path is what the authorization server was told
  const stored = {
    clientId: "cid",
    accessToken: "A",
    refreshToken: "R",
    clientInformation: { client_id: "cid", redirect_uris: ["http://127.0.0.1:33337/callback"] },
  };
  const auth = new ServerAuth("srv", "http://127.0.0.1:33337/other", async () => {});
  await auth.hydrate(structuredClone(stored));
  assert.equal(
    auth.clientInformation(),
    undefined,
    "a different redirect PATH is a genuine mismatch — only the PORT is interchangeable (#mcp)",
  );
});
