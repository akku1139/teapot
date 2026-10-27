import { test } from "node:test";
import assert from "node:assert/strict";
import { createCatalog, SEARCH_TOOL, RUN_TOOL, PROVIDER_TOOL_LIMIT } from "../src/agent/tool-catalog.ts";

/**
 * A 321-tool MCP catalog must fit a provider that accepts 128 tools.
 *
 * MEASURED (`mizuki-rakutenai-3`): Notion 65 + Ghidra 208 + Canva 48, so every request failed with
 * `Invalid value for 'tools': maximum number of items is 128` — three retries and a stop, with no tool
 * ever called. The same version worked for agents with no MCP servers, which is why it looked like a
 * model problem rather than a request one.
 *
 * The fix is a DISCOVERY tool pair, not silent truncation: dropping tools would leave the model
 * believing a capability does not exist.
 */
const server = (name: string, n: number, prefix: string) => ({
  id: name,
  name,
  status: "connected",
  tools: Array.from({ length: n }, (_, i) => ({
    name: `${prefix}_${i}`,
    description: `${name} ${prefix} tool number ${i}`,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  })),
});

const big = [server("Notion", 65, "page"), server("Ghidra", 208, "decompile"), server("Canva", 48, "design")];

test("an oversized catalog is deferred to the two meta-tools (#tools)", () => {
  const c = createCatalog(big, { builtInCount: 15 });
  assert.equal(c.deferred, true);
  assert.deepEqual(c.tools.map((t) => t.name), [SEARCH_TOOL, RUN_TOOL]);
  // the point: the REQUEST now fits, whatever the catalog holds
  assert.ok(15 + c.tools.length <= PROVIDER_TOOL_LIMIT, `sends ${15 + c.tools.length} tools`);
  assert.match(c.guidance, /search_tools/, "and the prompt says how to find the rest");
});

test("a catalog that fits is sent whole, with no discovery step (#tools)", () => {
  const c = createCatalog([server("Small", 3, "read")], { builtInCount: 15 });
  assert.equal(c.deferred, false, "no extra indirection when nothing is in the way");
  assert.equal(c.tools.length, 3, "every tool is advertised directly");
  assert.doesNotMatch(c.tools.map((t) => t.name).join(","), new RegExp(SEARCH_TOOL));
  assert.equal(c.guidance, "", "and no prompt section is added");
});

test("the built-ins count against the limit, not just the catalog (#tools)", () => {
  // 60 MCP tools alone look harmless, but with 100 built-ins the request is 160 > 128
  const c = createCatalog([server("Mid", 60, "x")], { builtInCount: 100 });
  assert.equal(c.deferred, true, "deferring must be about the WHOLE request");
});

test("search finds by tool name, server name and description (#tools)", () => {
  const c = createCatalog(big, { builtInCount: 15 });
  assert.equal(c.search("decompile", 0).entries[0]?.server, "Ghidra", "by name");
  assert.equal(c.search("canva", 0).entries[0]?.server, "Canva", "by server");
  const anyNotion = c.search("page", 0).entries.every((e) => e.server === "Notion");
  assert.equal(anyNotion, true, "and it does not mix in unrelated servers");
});

test("a match in the NAME outranks one in the description (#tools)", () => {
  const c = createCatalog(
    [
      { id: "A", name: "A", status: "connected", tools: [{ name: "zebra", description: "nothing here" }] },
      { id: "B", name: "B", status: "connected", tools: [{ name: "plain", description: "mentions zebra once" }] },
    ],
    { builtInCount: 0 },
  );
  assert.equal(c.search("zebra", 0).entries[0]?.name, "zebra");
});

test("an empty query browses the catalog (#tools)", () => {
  const c = createCatalog(big, { builtInCount: 15 });
  const r = c.search("", 0);
  assert.ok(r.entries.length > 0, "browsing must return something");
  assert.equal(r.total, 321);
});

test("paging returns the next slice, and reports when it ended (#tools)", () => {
  const c = createCatalog([server("Only", 12, "item")], { builtInCount: 0 });
  const first = c.search("item", 0);
  assert.equal(first.entries.length, 5);
  assert.equal(first.nextOffset, 5);
  const second = c.search("item", first.nextOffset!);
  assert.notEqual(second.entries[0]!.id, first.entries[0]!.id, "a different slice");
  const last = c.search("item", 10);
  assert.equal(last.nextOffset, null, "the end is reported, so the model stops paging");
});

test("only a tool DISCOVERED this turn can run (#tools)", () => {
  const c = createCatalog(big, { builtInCount: 15 });
  const neverFound = JSON.stringify(["Canva", "design_7"]);
  assert.equal(c.discovered(neverFound), undefined, "a guessed id is not executable");

  const found = c.search("design", 0).entries[0]!;
  c.remember(found.id);
  assert.equal(c.discovered(found.id)?.name, found.name);

  c.reset();
  assert.equal(c.discovered(found.id), undefined, "and a new turn starts empty");
});

test("a tool name that would collide after flattening still has a unique id (#tools)", () => {
  // two servers may expose the same tool name; the id pairs server and name, so neither is ambiguous
  const c = createCatalog(
    [
      { id: "s1", name: "s1", status: "connected", tools: [{ name: "search", description: "one" }] },
      { id: "s2", name: "s2", status: "connected", tools: [{ name: "search", description: "two" }] },
    ],
    { builtInCount: 0 },
  );
  const ids = c.search("search", 0).entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "ids are distinct");
});

test("a disconnected server contributes nothing (#tools)", () => {
  const c = createCatalog(
    [
      { ...server("Down", 10, "x"), status: "error" },
      server("Up", 2, "y"),
    ],
    { builtInCount: 0 },
  );
  assert.equal(c.tools.length, 2, "only the reachable server's tools");
  assert.equal(c.search("", 0).total, 2);
});
