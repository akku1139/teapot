/**
 * `search_tools` must see MCP tools that appeared AFTER its catalogue was built (#243).
 *
 * "MCP再認証してもsearch_toolsで出てこない、叩けない" — the deferred catalogue is cached per ToolContext, and a cache keyed only
 * by that context cannot notice the registry changing underneath it: re-authorising populates the server's tools, but the
 * catalogue keeps serving what it saw before the grant. The registry now carries a version, and the cache compares it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mcp } from "../src/agent/mcp-registry.ts";

test("the tool-set version changes when a server's tools change", () => {
  mcp.apply([{ name: "ver-test", url: "https://example.invalid/mcp", transport: "http" } as never]);
  const v0 = mcp.stateVersion();
  mcp.recordSuccess("ver-test", [{ name: "a", description: "a tool" }] as never);
  const v1 = mcp.stateVersion();
  assert.notEqual(v1, v0, "a populated tool list must invalidate the cached catalogue");
  mcp.recordSuccess("ver-test", [{ name: "a" }, { name: "b" }] as never);
  assert.notEqual(mcp.stateVersion(), v1, "and so must a later change");
});

test("re-applying the config also bumps it", () => {
  const before = mcp.stateVersion();
  mcp.apply([{ name: "ver-test", url: "https://example.invalid/mcp2", transport: "http" } as never]);
  assert.notEqual(mcp.stateVersion(), before, "a changed server entry can change the tool set");
});
