/**
 * `servername,toolname` is an alias the model actually writes (#202).
 *
 * The operator's sessions show cards titled "Ghidra,get_function_xrefs" — server and tool joined by a COMMA, not the flat
 * `mcp__server__tool` form and not `server/tool`. The display parser must read it as a pair (or the row shows a raw string), and
 * the SERVER's resolver must accept the same alias, since that is where the call is dispatched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mcpToolLabel } from "../frontend/lib/mcp-tool-label.ts";

test("a comma pair renders as server/tool, like every other alias", () => {
  assert.equal(mcpToolLabel("Ghidra,get_function_xrefs"), "Ghidra/get_function_xrefs");
});

test("the other aliases still work", () => {
  assert.equal(mcpToolLabel("mcp__Ghidra__get_xrefs_to"), "Ghidra/get_xrefs_to");
  assert.equal(mcpToolLabel("Ghidra/get_xrefs_to"), "Ghidra/get_xrefs_to");
  assert.equal(mcpToolLabel('["Ghidra","get_xrefs_to"]'), "Ghidra/get_xrefs_to");
  assert.equal(mcpToolLabel("bare_tool"), "bare_tool");
});

test("the server resolves the comma alias too", () => {
  const src = readFileSync(new URL("../src/agent/tool-catalog.ts", import.meta.url), "utf8");
  assert.match(src, /for \(const sep of \["__", "\/", "::", ":", ","\]\)/, "the resolver must try the comma separator");
});
