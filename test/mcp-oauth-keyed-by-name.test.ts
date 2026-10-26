import { test } from "node:test";
import assert from "node:assert/strict";
import { oauthStateFrom } from "../frontend/lib/mcp-oauth-key.ts";

const state = (authorized: boolean) => ({ required: false, authorized });

test("a state written for a name is found by that name (#mcp)", () => {
  const map = { Canva: state(true), Notion: state(true) };
  assert.equal(oauthStateFrom(map, "Canva")?.authorized, true);
  assert.equal(oauthStateFrom(map, "Notion")?.authorized, true, "every authorized server must show it, not just the first");
});

test("a NUMERIC key must not answer for a server that has no state (#mcp)", () => {
  const map = { "0": state(true), Canva: state(true) };
  assert.equal(oauthStateFrom(map, "Notion"), null, "a numeric key is not a name — it must never match");
  assert.equal(oauthStateFrom(map, "1"), null, "and it must not match a name that LOOKS numeric either");
});

test("no state at all is null, not a crash (#mcp)", () => {
  assert.equal(oauthStateFrom({}, "Canva"), null);
  assert.equal(oauthStateFrom({}, ""), null);
  assert.equal(oauthStateFrom({ Canva: state(false) }, "Canva")?.authorized, false, "false is a real answer");
});
