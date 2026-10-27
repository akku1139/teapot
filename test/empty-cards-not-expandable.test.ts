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
  assert.match(src, /\[MCP: \$\{server\}\]/, "and the server named in the hint");
});
