/**
 * A table whose header row is entirely blank should not render a <thead>.
 *
 * Found by writing a table with an empty header — the shape you get from
 * piping a table out of a tool whose first row is blank. It rendered a bare
 * strip of dark, bordered cells above the real content, which reads as a stray
 * empty row rather than as column headings.
 *
 * This is worth being precise about, because it is NOT a deviation from GFM.
 * `cmark-gfm --extension table` (the reference implementation) renders exactly
 * the same empty <thead> for the same input — verified, not assumed. So the
 * markup was conformant and the problem was purely presentational.
 *
 * Hence the fix drops the element rather than restyling it: CSS cannot tell an
 * empty <th> from a deliberately-blank one, and a header row that labels
 * nothing is not information a reader can use.
 *
 * The threshold matters: only an ENTIRELY blank header is dropped. A table
 * with one real heading keeps its header, blanks included, or the real columns
 * would stop lining up over their data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../frontend/md.js";

/* ---------- the reported case ---------- */

test("an all-blank header renders no thead", () => {
  const out = renderMarkdown("|  |  |\n| --- | --- |\n| a | b |");
  assert.ok(out.includes("<table>"), "it is still a table (#57)");
  assert.doesNotMatch(out, /<thead>/, "an empty header row must not render (#57)");
  assert.doesNotMatch(out, /<th[\s>]/, "and no empty th either (#57)");
  // the data survives intact
  assert.match(out, /<td>a<\/td>/);
  assert.match(out, /<td>b<\/td>/);
});

test("a whitespace-only header counts as blank", () => {
  // splitRow trims, so a header of spaces is the same thing to a reader
  const out = renderMarkdown("|   |   |\n| --- | --- |\n| a | b |");
  assert.doesNotMatch(out, /<thead>/, "padding is not a heading (#57)");
  assert.match(out, /<td>a<\/td>/, "and the row still renders (#57)");
});

test("a single-column table with a blank header renders no thead", () => {
  const out = renderMarkdown("|  |\n| --- |\n| a |");
  assert.doesNotMatch(out, /<thead>/, "one blank cell is still blank (#57)");
  assert.match(out, /<td>a<\/td>/);
});

/* ---------- a REAL header must never be dropped ---------- */

test("a real header is kept", () => {
  const out = renderMarkdown("| H1 | H2 |\n| --- | --- |\n| a | b |");
  assert.match(out, /<thead>/, "a table with headings needs them (#57)");
  assert.match(out, /<th>H1<\/th>/);
  assert.match(out, /<th>H2<\/th>/);
});

test("a PARTIALLY blank header is kept (#57)", () => {
  // dropping the header here would leave the real column unlabelled
  const out = renderMarkdown("|  | H2 |\n| --- | --- |\n| a | b |");
  assert.match(out, /<thead>/, "a partially-blank header must survive (#57)");
  assert.match(out, /<th>H2<\/th>/, "the real heading is intact (#57)");
});

test("a trailing blank header cell is kept as a cell (#57)", () => {
  // splitRow drops only a TRAILING empty cell, so "| H1 |  |" yields one header
  // cell here where cmark-gfm yields two. Pre-existing and unrelated to #57 —
  // pinned so the difference is a decision rather than an accident, and so the
  // fix below is not blamed for it.
  const out = renderMarkdown("| H1 |  |\n| --- | --- |\n| a | b |");
  assert.match(out, /<thead>/, "the header is still a header (#57)");
  assert.match(out, /<th>H1<\/th>/, "with its real label (#57)");
  assert.equal(
    [...out.matchAll(/<th[\s>]/g)].length,
    1,
    "one cell, because a trailing blank is dropped before the thead decision (#57)",
  );
});

/* ---------- nothing else moved ---------- */

test("alignment still applies with no header", () => {
  // `:--` is LEFT in GFM (only `:-:` is centre) — checked against cmark-gfm
  // rather than assumed, which is how the first draft of this assertion got it
  // wrong.
  const out = renderMarkdown("|  |  |\n| :-- | --: |\n| a | b |");
  assert.doesNotMatch(out, /<thead>/);
  assert.match(out, /text-align:right/, "right alignment must survive the dropped header (#57)");
  assert.doesNotMatch(out, /text-align:center/, "`:--` is left, not centre (#57)");

  const centred = renderMarkdown("|  |  |\n| :-: | --- |\n| a | b |");
  assert.match(centred, /text-align:center/, "`:-:` is centre and must survive (#57)");
});

test("a table immediately after a paragraph is unaffected", () => {
  const out = renderMarkdown("Some text\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.match(out, /<p>Some text<\/p>/, "the paragraph is still a paragraph (#57)");
  assert.match(out, /<th>A<\/th>/);
});

test("a lone pipe row is not a table at all", () => {
  // a header with no separator row is just text, and must not lose its pipes
  const out = renderMarkdown("| a | b |");
  assert.doesNotMatch(out, /<table>/, "no separator row means no table (#57)");
  assert.match(out, /\|/, "and the pipes survive as text (#57)");
});
