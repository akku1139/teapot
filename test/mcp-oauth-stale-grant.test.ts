import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { ServerAuth } from "../src/agent/mcp-oauth-manager.ts";

const STALE = {
  clientId: "old-client",
  clientSecret: "old-secret",
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: Date.now() + 3_600_000,
  clientInformation: {
    client_id: "old-client",
    client_secret: "old-secret",
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
  const placeholder = new ServerAuth("srv", "http://127.0.0.1/callback", async () => {});
  await placeholder.hydrate(structuredClone(STALE));
  assert.ok(
    placeholder.tokens(),
    "a portless placeholder cannot refute a registration, so it must not discard the grant (#mcp)",
  );
  const otherPort = new ServerAuth("srv", "http://127.0.0.1:59999/callback", async () => {});
  await otherPort.hydrate(structuredClone(STALE));
  assert.ok(
    otherPort.tokens(),
    "a different loopback PORT is the same registration — comparing ports re-registers on every " +
      "flow and throws the grant away (#mcp)",
  );

  const mismatch = new ServerAuth("srv", "https://example.test/callback", async () => {});
  await mismatch.hydrate(structuredClone(STALE));
  assert.equal(
    mismatch.tokens(),
    undefined,
    "a registration for a different HOST is a genuine mismatch and is still not presented (#mcp)",
  );
});

test("a grant IS used when the stored registration matches a real listener (#mcp)", async () => {
  const stored = {
    ...STALE,
    clientInformation: { client_id: "old-client", redirect_uris: ["http://127.0.0.1:41234/callback"] },
  };
  const a2 = new ServerAuth("srv", "http://127.0.0.1:41234/callback", async () => {});
  await a2.hydrate(structuredClone(stored));
  assert.ok(a2.tokens(), "a matching registration keeps its grant — no needless re-authorization");
});

test("a rotated client id drops the tokens of the old one (#mcp)", async () => {
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
