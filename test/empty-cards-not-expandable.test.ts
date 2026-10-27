import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * A card with nothing inside must not be a `<details>`.
 *
 * Reported twice, for two different cards, which is why it is pinned as a rule rather than as two
 * special cases: "中身が空なのに展開してちょっと縦に伸びる". A disclosure triangle PROMISES content; when
 * there is none it only grows the row by a few pixels and does nothing when clicked.
 *
 * MEASURED in real Firefox after the fix: `audit_step` rows with `step: "started"` / `"verdict"` render
 * as `DIV.auditstep`, and the one carrying `args` stays a `DETAILS`.
 *
 * This is a source check because the property is "no `<details>` wrapper exists unless a body exists" —
 * a DOM fixture with a short row passes vacuously, since it never had anything to expand either.
 */
const ROWS = path.join(import.meta.dirname, "..", "frontend", "components", "rows.tsx");

test("the audit card is a plain embed when it has no body (#audit)", () => {
  const src = readFileSync(ROWS, "utf8");
  const at = src.indexOf("if (!expandable)");
  assert.ok(at > 0, "there must be a no-body branch");
  // the branch body is what matters: a <div>, and it must return before the <details> path
  // the `if (!expandable)` block ends at its own closing brace, well before the <details> path
  const block = src.slice(at, src.indexOf("return (", src.indexOf("return (", at) + 1));
  assert.match(block, /<div class="embed auditstep">/, "it must render a plain embed");
  assert.doesNotMatch(block, /<details/, "and must not open a <details>");
});

test("the compaction card keeps the same rule (#compact)", () => {
  // the card that originally exposed the problem; a regression here would re-open the same report
  const src = readFileSync(ROWS, "utf8");
  const at = src.indexOf("if (!e.data.summary)");
  assert.ok(at > 0, "the no-summary branch must exist");
  const branch = src.slice(at, at + 260);
  assert.match(branch, /<div class="embed compaction">/, "a summary-less compaction is a plain row");
});

test("an MCP tool renders as a normal tool row, not the JSON fallback (#mcp)", () => {
  const src = readFileSync(ROWS, "utf8");
  assert.match(
    src,
    /\^mcp__\(\[\^_\]\+/,
    "the flat mcp__server__tool name must be recognised in the renderer",
  );
  /**
   * The header shows the CALL, not the tool's name again.
   *
   * The row already says `Ghidra/get_xrefs_to` in the author column, so repeating it (or `[MCP: Ghidra]`)
   * in the summary wastes the widest part of the header. Both routes — `run_tool` and a direct
   * `mcp__server__tool` — go through ONE `mcpCard`, which is what stops them drifting apart.
   */
  assert.match(src, /const mcpCard = \(/, "one shared MCP card");
  assert.match(src, /mcpCard\(mcp\[1\]!, mcp\[2\]!, d\.args\)/, "the direct route uses it");
  assert.match(src, /mcpCard\(parts\.slice\(0, slash\)/, "…and so does run_tool");
  assert.match(src, /label = keys\.length \? oneLine\(JSON\.stringify\(bare\), 120\)/, "the header is the arguments");
});
