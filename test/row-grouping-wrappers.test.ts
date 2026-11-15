/**
 * Cards from a WRAPPER tool must not merge across different inner tools (#202).
 *
 * `run_tool` and `search_tools` carry the SAME `data.name` on every call, so `groupedWith` merged a run of cards that invoked
 * different MCP tools into one visual block — reported as "search_tool, run_tool 由来のツールカードがツール名によらず連続している".
 * A reader groups by what the card NAMES, so the grouping key has to be that too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { groupedWith } from "../frontend/lib/row-grouping.ts";

const call = (name: string, args: Record<string, unknown>) => ({
  type: "tool_call",
  session: "s",
  branch: "b",
  data: { name, args },
});

test("two run_tool cards with different inner tools are NOT grouped", () => {
  const a = call("run_tool", { tool_id: "Ghidra/get_function_xrefs", arguments: {} });
  const b = call("run_tool", { tool_id: "Ghidra/search_byte_patterns", arguments: {} });
  assert.equal(groupedWith(a, b), false, "different inner tools are different rows");
});

test("the same inner tool still groups (a run of the same call stays a run)", () => {
  const a = call("run_tool", { tool_id: "Ghidra/get_function_xrefs", arguments: {} });
  const b = call("run_tool", { tool_id: "Ghidra/get_function_xrefs", arguments: {} });
  assert.equal(groupedWith(a, b), true);
});

test("search_tools groups by its query, not by its own name", () => {
  const a = call("search_tools", { query: "dumpstart" });
  const b = call("search_tools", { query: "memupload" });
  assert.equal(groupedWith(a, b), false, "two different searches are two subjects");
  assert.equal(groupedWith(a, call("search_tools", { query: "dumpstart" })), true);
});

test("ordinary tools keep their existing behaviour", () => {
  assert.equal(groupedWith(call("bash", {}), call("bash", {})), true);
  assert.equal(groupedWith(call("bash", {}), call("read_file", {})), false);
});
