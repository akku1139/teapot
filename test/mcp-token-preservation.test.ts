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
   * The guard that must survive: a listener-backed URL the record does not list is a genuine
   * mismatch, and presenting a token for the wrong client is what produced `Client ID mismatch`.
   * Declining (not deleting) keeps it recoverable.
   */
  const auth = new ServerAuth("srv", "http://127.0.0.1:59999/callback", async () => {});
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
