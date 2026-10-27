import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpToolLabel } from "../frontend/lib/mcp-tool-label.ts";
import { authorOf } from "../frontend/lib/timeline-row.ts";

/**
 * A tool row names the MCP tool, not the dispatcher — and both routes say it the SAME way.
 *
 * "run_tool をactor名に表示するんじゃなくて、MCPサーバーのツール名を表示する". `run_tool` says nothing
 * about what happened; `Ghidra/get_xrefs_to` says everything.
 *
 * MEASURED on `tyb2-8-0161a4af`: the model wrote the same id four different ways, so the label cannot
 * assume one spelling. Display only — the server has its own authoritative resolver.
 */
const HASH = () => {};

test("every spelling of a tool id produces the same label (#tools)", () => {
  for (const raw of [
    '["Ghidra","get_xrefs_to"]',
    '["Ghidra", "get_xrefs_to"]',
    "['Ghidra', 'get_xrefs_to']",
    "Ghidra/get_xrefs_to",
    "Ghidra__get_xrefs_to",
    "mcp__Ghidra__get_xrefs_to",
  ]) {
    assert.equal(mcpToolLabel(raw), "Ghidra/get_xrefs_to", `wrong label for ${raw}`);
  }
});

test("a bare name is passed through, and nothing is invented (#tools)", () => {
  assert.equal(mcpToolLabel("get_xrefs_to"), "get_xrefs_to");
  assert.equal(mcpToolLabel(""), null);
  assert.equal(mcpToolLabel(undefined), null);
});

test("a run_tool row is credited to the MCP tool (#tools)", () => {
  const ev = {
    id: "e", seq: 1, ts: "t", session: "s", branch: "b", type: "tool_call", parent: null,
    data: { name: "run_tool", args: { tool_id: '["Ghidra","get_xrefs_to"]' } },
  };
  assert.equal(authorOf(ev as never).name, "Ghidra/get_xrefs_to");
});

test("a DIRECT mcp call reads identically (#tools)", () => {
  // two spellings for one thing is the drift this exists to stop
  const ev = {
    id: "e", seq: 1, ts: "t", session: "s", branch: "b", type: "tool_call", parent: null,
    data: { name: "mcp__Ghidra__disassemble_function", args: {} },
  };
  assert.equal(authorOf(ev as never).name, "Ghidra/disassemble_function");
});

test("a server whose own name has an underscore still splits correctly (#tools)", () => {
  // the same pattern the card renderer uses, so both halves agree
  const ev = {
    id: "e", seq: 1, ts: "t", session: "s", branch: "b", type: "tool_call", parent: null,
    data: { name: "mcp__my_server__read_page", args: {} },
  };
  assert.equal(authorOf(ev as never).name, "my_server/read_page");
});

test("a plain tool keeps its own name (#tools)", () => {
  const ev = {
    id: "e", seq: 1, ts: "t", session: "s", branch: "b", type: "tool_call", parent: null,
    data: { name: "bash", args: {} },
  };
  assert.equal(authorOf(ev as never).name, "bash");
  void HASH;
});
