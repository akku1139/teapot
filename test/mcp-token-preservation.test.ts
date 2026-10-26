import { test } from "node:test";
import assert from "node:assert/strict";
import { ServerAuth } from "../src/agent/mcp-oauth-manager.ts";

const withTokens = {
  clientId: "cid",
  clientSecret: "sec",
  accessToken: "ACCESS",
  refreshToken: "REFRESH",
  expiresAt: Date.now() + 3_600_000,
  clientInformation: { client_id: "cid", redirect_uris: ["http://127.0.0.1:41234/callback"] },
};

test("a placeholder reconnect KEEPS the stored grant (#mcp)", async () => {
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
  const auth = new ServerAuth("srv", "https://example.test/callback", async () => {});
  await auth.hydrate(structuredClone(withTokens));
  assert.equal(
    auth.tokens(),
    undefined,
    "a token for a client the server no longer knows must not be presented (#mcp)",
  );
});

test("declining does not DELETE what is stored (#mcp)", async () => {
  const writes: unknown[] = [];
  const auth = new ServerAuth("srv", "http://127.0.0.1:59999/callback", async (_n, d) => {
    writes.push(structuredClone(d));
  });
  await auth.hydrate(structuredClone(withTokens));
  auth.tokens(); 
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

test("the same registration is reused across loopback ports (#mcp)", async () => {
  const stored = {
    clientId: "cid",
    clientSecret: "sec",
    accessToken: "ACCESS",
    refreshToken: "REFRESH",
    expiresAt: Date.now() + 3_600_000,
    clientInformation: { client_id: "cid", redirect_uris: ["http://127.0.0.1:33337/callback"] },
  };
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
