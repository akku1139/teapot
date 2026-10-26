import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../frontend/md.js";

test("an all-blank header renders no thead", () => {
  const out = renderMarkdown("|  |  |\n| --- | --- |\n| a | b |");
  assert.ok(out.includes("<table>"), "it is still a table (#57)");
  assert.doesNotMatch(out, /<thead>/, "an empty header row must not render (#57)");
  assert.doesNotMatch(out, /<th[\s>]/, "and no empty th either (#57)");
  assert.match(out, /<td>a<\/td>/);
  assert.match(out, /<td>b<\/td>/);
});

test("a whitespace-only header counts as blank", () => {
  const out = renderMarkdown("|   |   |\n| --- | --- |\n| a | b |");
  assert.doesNotMatch(out, /<thead>/, "padding is not a heading (#57)");
  assert.match(out, /<td>a<\/td>/, "and the row still renders (#57)");
});

test("a single-column table with a blank header renders no thead", () => {
  const out = renderMarkdown("|  |\n| --- |\n| a |");
  assert.doesNotMatch(out, /<thead>/, "one blank cell is still blank (#57)");
  assert.match(out, /<td>a<\/td>/);
});

test("a real header is kept", () => {
  const out = renderMarkdown("| H1 | H2 |\n| --- | --- |\n| a | b |");
  assert.match(out, /<thead>/, "a table with headings needs them (#57)");
  assert.match(out, /<th>H1<\/th>/);
  assert.match(out, /<th>H2<\/th>/);
});

test("a PARTIALLY blank header is kept (#57)", () => {
  const out = renderMarkdown("|  | H2 |\n| --- | --- |\n| a | b |");
  assert.match(out, /<thead>/, "a partially-blank header must survive (#57)");
  assert.match(out, /<th>H2<\/th>/, "the real heading is intact (#57)");
});

test("a trailing blank header cell is kept as a cell (#57)", () => {
  const out = renderMarkdown("| H1 |  |\n| --- | --- |\n| a | b |");
  assert.match(out, /<thead>/, "the header is still a header (#57)");
  assert.match(out, /<th>H1<\/th>/, "with its real label (#57)");
  assert.equal(
    [...out.matchAll(/<th[\s>]/g)].length,
    1,
    "one cell, because a trailing blank is dropped before the thead decision (#57)",
  );
});

test("alignment still applies with no header", () => {
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
  const out = renderMarkdown("| a | b |");
  assert.doesNotMatch(out, /<table>/, "no separator row means no table (#57)");
  assert.match(out, /\|/, "and the pipes survive as text (#57)");
});
