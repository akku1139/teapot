import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../frontend/md.js";

function cells(src: string): string[] {
  const out = renderMarkdown(src);
  const body = out.slice(out.indexOf("<tbody>"));
  return [...body.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]!);
}

const table = (header: string, row: string) =>
  `| ${header} |\n| --- |\n| ${row} |`;

test("a pipe inside a code span does not split the cell", () => {
  assert.deepEqual(
    cells(table("h1 | h2 | h3", "`#7` | `98b322b` | `N| `gutter jumped...")),
    ["<code>#7</code>", "<code>98b322b</code>", "<code>N| </code>gutter jumped..."],
    "a pipe inside a code span is content, not a column break",
  );
});

test("a code span with a pipe keeps its code formatting", () => {
  assert.deepEqual(
    cells(table("a | b", "`x|y` | z")),
    ["<code>x|y</code>", "z"],
    "the span must survive intact, not just the column count",
  );
});

test("a pipe BETWEEN two spans is still a column boundary", () => {
  assert.deepEqual(cells(table("a | b", "`a` | `b`")), ["<code>a</code>", "<code>b</code>"]);
});

test("an unclosed backtick is literal text, so its pipes are boundaries", () => {
  assert.deepEqual(
    cells(table("a | b", "`oops | c")),
    ["`oops", "c"],
    "an unclosed backtick must not open a span that swallows the row (#7)",
  );
});

test("an escaped pipe still works, and is redundant inside a span", () => {
  assert.deepEqual(cells(table("a | b", "e \\| f | g")), ["e | f", "g"], "\\| outside a span");
  assert.deepEqual(
    cells(table("a | b", "`x\|y` | z")),
    ["<code>x|y</code>", "z"],
    "\\| inside a span is a literal pipe, not markup",
  );
});

test("a table with no leading pipe still parses", () => {
  assert.deepEqual(cells("a | b | c |\n--- | --- | ---\n1 | 2 | 3"), ["1", "2", "3"]);
});

test("inline formatting inside a code-free cell is untouched", () => {
  assert.deepEqual(cells(table("a | b", "**x** | *y*")), ["<strong>x</strong>", "<em>y</em>"]);
});

test("a table documenting a pipe-delimited format survives", () => {
  const src = [
    "| Issue | Commit | Note |",
    "| --- | --- | --- |",
    "| #7 | `98b322b` | `N| `gutter jumped... |",
    "| #57 | `c4f6e9b` | `imgx` circle |",
  ].join("\n");
  const out = renderMarkdown(src);
  const body = out.slice(out.indexOf("<tbody>"));
  const rows = [...body.matchAll(/<tr>(.*?)<\/tr>/g)];
  assert.equal(rows.length, 2, `both rows must survive: ${out}`);
  for (const [, row] of rows) {
    assert.equal(
      [...row.matchAll(/<td[^>]*>/g)].length,
      3,
      `every row must have 3 cells, not one per pipe: ${row}`,
    );
  }
  assert.match(out, /<code>N\| <\/code>gutter jumped\.\.\./, `the span must survive: ${out}`);
});
