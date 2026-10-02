/**
 * A pipe inside a CODE SPAN is content, not a column boundary.
 *
 * Found by writing a table ABOUT a `N| ` gutter: the cell
 *
 *     | #7 | `98b322b` | `N| `gutter jumped... |
 *
 * came out as four columns, because `splitRow` broke on every unescaped `|`
 * without consulting the code spans that `inline()` recognises. A table whose
 * subject matter is a pipe-delimited format is exactly the table most likely
 * to contain one.
 *
 * The fix is that `splitRow` now mirrors `inline()`'s code-span rule, so the
 * two agree on where a span starts and ends. GFM agrees: within a code span a
 * pipe needs no escape, and `\|` is the documented way to write one when you
 * need to be explicit.
 *
 * The subtle half is that the two must not merely both "handle backticks" —
 * they must agree on the *boundaries*. A cell that splits where the inline
 * renderer would treat the text as code is how `` `x|y` `` lost its code
 * formatting as well as its column.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../frontend/md.js";

/** the <td> contents of a one-row table, for readable assertions */
function cells(src: string): string[] {
  const out = renderMarkdown(src);
  const body = out.slice(out.indexOf("<tbody>"));
  return [...body.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]!);
}

const table = (header: string, row: string) =>
  `| ${header} |\n| --- |\n| ${row} |`;

/* ---------- the reported case ---------- */

test("a pipe inside a code span does not split the cell", () => {
  // the exact row that exposed this
  assert.deepEqual(
    cells(table("h1 | h2 | h3", "`#7` | `98b322b` | `N| `gutter jumped...")),
    ["<code>#7</code>", "<code>98b322b</code>", "<code>N| </code>gutter jumped..."],
    "a pipe inside a code span is content, not a column break",
  );
});

test("a code span with a pipe keeps its code formatting", () => {
  // the other half: the cell used to be split, which also destroyed the span
  assert.deepEqual(
    cells(table("a | b", "`x|y` | z")),
    ["<code>x|y</code>", "z"],
    "the span must survive intact, not just the column count",
  );
});

/* ---------- the boundary rule must match inline() exactly ---------- */

test("a pipe BETWEEN two spans is still a column boundary", () => {
  // GFM: `a` | `b` is two cells. Only a pipe INSIDE a span is content, so this
  // must NOT be treated as one cell — over-correcting here would merge columns
  // and silently drop data instead.
  assert.deepEqual(cells(table("a | b", "`a` | `b`")), ["<code>a</code>", "<code>b</code>"]);
});

test("an unclosed backtick is literal text, so its pipes are boundaries", () => {
  // inline() uses /`([^`]+)`/g, so an unclosed backtick is NOT a code span
  // there. splitRow must agree: a half-open span that swallowed every pipe to
  // the end of the row would merge columns the inline renderer treats as
  // separate — the same disagreement, just pointing the other way.
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

/* ---------- nothing else moved ---------- */



test("a table with no leading pipe still parses", () => {
  assert.deepEqual(cells("a | b | c |\n--- | --- | ---\n1 | 2 | 3"), ["1", "2", "3"]);
});

test("inline formatting inside a code-free cell is untouched", () => {
  assert.deepEqual(cells(table("a | b", "**x** | *y*")), ["<strong>x</strong>", "<em>y</em>"]);
});

/* ---------- the real-world shape: a table about pipes ---------- */


test("a table documenting a pipe-delimited format survives", () => {
  // The class of content most likely to trigger this: a table ABOUT a pipe
  // format. The report's own row, with the outer pipes escaped the way a cell
  // containing them must be written.
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
  // and the cell that caused the report is intact, code span and all
  assert.match(out, /<code>N\| <\/code>gutter jumped\.\.\./, `the span must survive: ${out}`);
});
