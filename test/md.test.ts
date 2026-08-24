import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../frontend/md.js";

test("md: headings h1–h6", () => {
  const out = renderMarkdown("# one\n## two\n### three\n#### four\n##### five\n###### six");
  for (let n = 1; n <= 6; n++) assert.ok(out.includes(`<h${n}>`), `h${n} missing`);
  assert.match(out, /<h6>six<\/h6>/);
});

test("md: GFM table with alignment and escaped pipes", () => {
  const src = [
    "| left | center | right |",
    "| :--- | :---: | ---: |",
    "| a \\| b | **x** | 1 |",
  ].join("\n");
  const out = renderMarkdown(src);
  assert.match(out, /<table>/);
  assert.match(out, /<th>left<\/th>/);
  assert.match(out, /<th style="text-align:center">center<\/th>/);
  assert.match(out, /<td style="text-align:right">1<\/td>/);
  assert.match(out, /a \| b/); // escaped pipe stays literal
  assert.match(out, /<strong>x<\/strong>/); // inline formatting inside cells
});

test("md: bold variants including spaced and triple", () => {
  const out = renderMarkdown("**bold** __also__ ***both*** ** spaced **");
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<strong>also<\/strong>/);
  assert.match(out, /<strong><em>both<\/em><\/strong>/);
  assert.match(out, /<strong> spaced <\/strong>/);
});

test("md: italics with * and _ but not snake_case", () => {
  const out = renderMarkdown("*em* and _under_ but snake_case_name intact");
  assert.match(out, /<em>em<\/em>/);
  assert.match(out, /<em>under<\/em>/);
  assert.match(out, /snake_case_name/); // no accidental emphasis
});

test("md: code spans are protected from inline formatting", () => {
  const out = renderMarkdown("`**not bold** and *not em*`");
  assert.ok(!out.includes("<strong>"), out);
  assert.ok(!out.includes("<em>"), out);
  assert.match(out, /<code>\*\*not bold\*\* and \*not em\*<\/code>/);
});

test("md: strikethrough, images, autolinks", () => {
  const out = renderMarkdown("~~gone~~ ![pic](https://example.com/i.png) see https://example.com/x now");
  assert.match(out, /<del>gone<\/del>/);
  assert.match(out, /<img src="https:\/\/example.com\/i.png"/);
  assert.match(out, /<a href="https:\/\/example.com\/x">https:\/\/example.com\/x<\/a>/);
});

test("md: task lists", () => {
  const out = renderMarkdown("- [ ] todo\n- [x] done");
  assert.match(out, /<input type="checkbox" disabled>/);
  assert.match(out, /<input type="checkbox" disabled checked>/);
  assert.match(out, /todo/);
});

test("md: blockquotes nest recursively", () => {
  const out = renderMarkdown("> quoted\n> > deeper\n> back **bold**");
  assert.match(out, /<blockquote>/);
  assert.match(out, /deeper/);
  assert.match(out, /<strong>bold<\/strong>/);
});

test("md: horizontal rules", () => {
  for (const hr of ["---", "***", "___"]) {
    assert.match(renderMarkdown(`a\n\n${hr}\n\nb`), /<hr>/);
  }
});

test("md: nested lists", () => {
  const out = renderMarkdown("- top\n  - child\n- top2");
  assert.match(out, /<ul><li>top<ul><li>child<\/li><\/ul><\/li><li>top2<\/li><\/ul>/);
});

test("md: XSS safety holds for the new constructs", () => {
  const out = renderMarkdown("# <script>alert(1)</script>\n| <b>x</b> |\n| --- |\n| <img src=x onerror=alert(2)> |");
  // angle brackets must never survive as markup — only as display entities
  assert.ok(!out.includes("<script"), out);
  assert.ok(!out.includes("<b>"), out);
  assert.ok(!out.includes("<img"), out);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&lt;b&gt;x&lt;b?\/?&gt;|&lt;b&gt;x&lt;\/b&gt;/);
});

/* ---------- robustness: malformed / hostile input must never hang or throw ----------
 * These run every case under a watchdog: a regression back to an infinite loop
 * (e.g. the fenced-code bug where ```` ```/path/to/thing ```` wasn't recognized
 * as an opening fence and wedged the parser) fails fast instead of freezing
 * the whole web UI.
 */

const CASES: [string, string][] = [
  // fences with unusual info strings (the original hang)
  ["fence with slash-lang", "```/subject/why-qa/trivia-qa-space\n**Q.** text\n```"],
  ["fence with dash-lang", "```my-lang\nx\n```"],
  ["fence with spaces in info", "```text file.txt\nx\n```"],
  ["fence with only lang dots", "```.json\n{}\n```"],
  ["unclosed fence", "text\n```\nnever closed"],
  ["unclosed fence with lang", "```js\nconst x = 1;"],
  ["empty fence", "```\n```"],
  ["lone fence line", "```"],
  ["four-backtick fence", "````\nx\n```"],
  ["indented fence", "  ```\n  x\n  ```"],
  // broken emphasis / links
  ["unclosed bold", "**never closed"],
  ["unclosed italic", "*never closed _also open"],
  ["unclosed code span", "`never closed"],
  ["unclosed link", "[text](http://x"],
  ["link with no url", "[text]()"],
  ["nested emphasis soup", "***__~~[[[[((("],
  ["stray brackets", "] ][ [[ ]] (] )("],
  // tables gone wrong
  ["table without separator", "| a | b |\n| no separator here |"],
  ["table one cell", "| lone |"],
  ["ragged table", "| a | b |\n|---|---|\n| only |\n| x | y | z | extra |"],
  // lists gone wrong
  ["list marker chaos", "- * - + 1. 2) ] ."],
  ["deep indent jump", "- a\n              - b\n                        - c"],
  ["negative-ish list", "-1. not a list\n-2. also not"],
  // blockquotes & hr chaos
  ["quote flood", "> > > > > deep"],
  ["hr soup", "---\n***\n___\n- - -\n* * *"],
  // unicode / control chars
  ["cjk + emoji mix", "# 日本語 🫖 テスト\n- 箇条書き ✅ **太字**"],
  ["rtl text", "مرحبا שלום hello"],
  ["null-ish escapes", "backslash \\\\ sequences \\\\ everywhere"],
  ["very long single word", "x".repeat(5000)],
  ["long line no spaces", "#".repeat(3000)],
  ["many newlines", "\n".repeat(2000) + "end"],
]

for (const [name, src] of CASES) {
  test(`md survives: ${name}`, () => {
    assert.doesNotThrow(() => renderMarkdown(src));
  });
}

test("md: slash-lang fence actually renders as code (regression for the UI freeze)", () => {
  const out = renderMarkdown("```/subject/why-qa/trivia-qa-space\n**Q.** text\n```");
  assert.match(out, /<pre><code>/);
  assert.match(out, /\*\*Q\.\*\* text/); // inner markdown NOT processed inside code
});

test("md: unclosed fence runs to EOF instead of hanging", () => {
  const out = renderMarkdown("before\n```js\nconst x = 1;");
  assert.match(out, /<pre><code>/);
  assert.match(out, /const x = 1;/);
});
