import { test } from "node:test";
import assert from "node:assert/strict";
import { oauthStateFrom } from "../frontend/lib/mcp-oauth-key.ts";

/**
 * OAuth state is keyed by SERVER NAME, never by row index.
 *
 * Reported: "何故かCanvaだけ 🔑 authorized って出てる" with three OAuth servers configured. The
 * server returned `authorized: true` for BOTH Notion and Canva (measured against
 * `/api/mcp/oauth/status`), so the difference was client-side: the OAuth poll wrote its result to
 * `{ [i]: st }` — the ROW INDEX — while every reader looks up `mcpOAuth()[server.name]`. Index 0
 * answered for whatever server happened to be first, so only a row whose index coincided with a
 * written key rendered a badge.
 *
 * The map's own docblock already said "keyed by name because that is the identity that cannot
 * drift"; the poll was the one writer that had not been converted.
 */
const state = (authorized: boolean) => ({ required: false, authorized });

test("a state written for a name is found by that name (#mcp)", () => {
  const map = { Canva: state(true), Notion: state(true) };
  assert.equal(oauthStateFrom(map, "Canva")?.authorized, true);
  assert.equal(oauthStateFrom(map, "Notion")?.authorized, true, "every authorized server must show it, not just the first");
});

test("a NUMERIC key must not answer for a server that has no state (#mcp)", () => {
  /**
   * This is the shape of the bug: a numeric key sitting in a name-keyed map. A row looking up
   * "Notion" must not be handed index 0's state, or it reports another server's authorization.
   */
  const map = { "0": state(true), Canva: state(true) };
  assert.equal(oauthStateFrom(map, "Notion"), null, "a numeric key is not a name — it must never match");
  assert.equal(oauthStateFrom(map, "1"), null, "and it must not match a name that LOOKS numeric either");
});

test("no state at all is null, not a crash (#mcp)", () => {
  assert.equal(oauthStateFrom({}, "Canva"), null);
  assert.equal(oauthStateFrom({}, ""), null);
  assert.equal(oauthStateFrom({ Canva: state(false) }, "Canva")?.authorized, false, "false is a real answer");
});
