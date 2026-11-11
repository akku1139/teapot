/**
 * A long MCP tool description must not make the settings panel scroll sideways (#242).
 *
 * "MCP serversの show 77 tools で横スクロール" — the description was `white-space: nowrap` with a `10ch` flex basis, so a
 * description with no break opportunity (a Notion tool's is a page long) became one unbreakable line and widened the panel.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBody } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

test("a tool description wraps instead of forcing a horizontal scrollbar", () => {
  const desc = cssRuleBody(css, ".mcptool-desc");
  assert.match(desc, /white-space:\s*normal/, "nowrap turned thousands of characters into one unbreakable line");
  assert.match(desc, /overflow-wrap:\s*anywhere/, "and a long token (a URL, JSON) still has to break");
  assert.match(desc, /min-width:\s*0/, "a flex child must be allowed to shrink below its content");
});

test("the list and its wrapper can shrink", () => {
  // these are single-line rules, so they are matched directly (the shared helper walks multi-line blocks)
  const body = (sel: string) => {
    const m = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
    return m?.[1] ?? "";
  };
  for (const sel of [".mcptools", ".mcptools-wrap"]) {
    assert.match(body(sel), /min-width:\s*0/, `${sel} must not force the panel wider than its column`);
  }
});
