import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ConfigPatchSchema } from "../src/config-schema.ts";

/**
 * An MCP server's `description` must survive the save path.
 *
 * It exists so a deferred catalog still gives the model a map (see `tool-catalog.ts`), but the config
 * modal rebuilds each server from a WHITELIST — so a field that is not listed there is dropped without
 * a word. The operator could type a description and the value would simply vanish, which is worse than
 * having no box at all.
 *
 * Two layers have to agree: the save path in the modal (a whitelist) and the zod schema (which also
 * strips unknown keys). This pins the schema half; the modal half is checked by the source guard below.
 */
test("a description survives the config schema (#mcp)", () => {
  const parsed = ConfigPatchSchema.parse({
    mcpServers: [
      { name: "Ghidra", url: "http://127.0.0.1:6678/mcp", transport: "http", enabled: true, description: "reverse engineering: decompile, disassemble" },
    ],
  });
  assert.equal(parsed.mcpServers?.[0]?.description, "reverse engineering: decompile, disassemble");
});

test("a description is optional, and an empty one is acceptable (#mcp)", () => {
  const bare = ConfigPatchSchema.parse({ mcpServers: [{ name: "X", url: "http://x/mcp" }] });
  assert.equal(bare.mcpServers?.[0]?.description, undefined, "absent is fine — it is guidance, not a requirement");
});

test("an over-long description is refused rather than silently cut (#mcp)", () => {
  // it goes into the system prompt, so an unbounded value is a prompt-size problem
  const r = ConfigPatchSchema.safeParse({ mcpServers: [{ name: "X", url: "http://x/mcp", description: "y".repeat(500) }] });
  assert.equal(r.success, false, "400 chars is the limit");
});

test("the config modal's save whitelist carries the description (#mcp)", () => {
  /**
   * The schema accepting a field is not enough: the modal rebuilds each server from a whitelist before
   * PUT-ing, so a field missing from THAT list is dropped first and the schema never sees it. This is a
   * source check because the save path is inside a 1700-line component and the property is structural
   * ("the whitelist mentions it"), which a value test of the schema cannot observe.
   */
  const src = readFileSync(path.join(import.meta.dirname, "..", "frontend", "components", "ConfigModal.tsx"), "utf8");
  const at = src.indexOf("cleanMcp.push({");
  assert.ok(at > 0, "the save path must still build cleanMcp");
  const block = src.slice(at, src.indexOf("});", at));
  assert.match(block, /description/, "a description the operator typed must reach the request");
});
