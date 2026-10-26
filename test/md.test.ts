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
  assert.match(out, /a \| b/); 
  assert.match(out, /<strong>x<\/strong>/); 
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
  assert.match(out, /snake_case_name/); 
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
  assert.ok(!out.includes("<script"), out);
  assert.ok(!out.includes("<b>"), out);
  assert.ok(!out.includes("<img"), out);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&lt;b&gt;x&lt;b?\/?&gt;|&lt;b&gt;x&lt;\/b&gt;/);
});

const CASES: [string, string][] = [
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
  ["unclosed bold", "**never closed"],
  ["unclosed italic", "*never closed _also open"],
  ["unclosed code span", "`never closed"],
  ["unclosed link", "[text](http://x"],
  ["link with no url", "[text]()"],
  ["nested emphasis soup", "***__~~[[[[((("],
  ["stray brackets", "] ][ [[ ]] (] )("],
  ["table without separator", "| a | b |\n| no separator here |"],
  ["table one cell", "| lone |"],
  ["ragged table", "| a | b |\n|---|---|\n| only |\n| x | y | z | extra |"],
  ["list marker chaos", "- * - + 1. 2) ] ."],
  ["deep indent jump", "- a\n              - b\n                        - c"],
  ["negative-ish list", "-1. not a list\n-2. also not"],
  ["quote flood", "> > > > > deep"],
  ["hr soup", "---\n***\n___\n- - -\n* * *"],
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
  assert.match(out, /<pre><code[^>]*>/);
  assert.match(out, /\*\*Q\.\*\* text/); 
});

test("md: a fence keeps its info string as a language class", () => {
  assert.match(renderMarkdown("```js\nx\n```"), /<pre><code class="language-js">/);
  assert.match(renderMarkdown("```a\"b><script>\nx\n```"), /<pre><code[^>]*>/);
  assert.doesNotMatch(renderMarkdown("```a\"b><script>\nx\n```"), /<script>/);
});

test("md: unclosed fence runs to EOF instead of hanging", () => {
  const out = renderMarkdown("before\n```js\nconst x = 1;");
  assert.match(out, /<pre><code/);
  assert.match(out, /const x = 1;/);
});

test("md: a link whose TEXT is a url does not nest <a>", () => {
  const out = renderMarkdown("[https://example.com](https://example.com)");
  assert.equal((out.match(/<a /g) || []).length, 1, `exactly one link, got: ${out}`);
  assert.match(out, /<a href="https:\/\/example\.com"[^>]*>https:\/\/example\.com<\/a>/);
});

test("md: a real link and a bare url in one line both work", () => {
  const out = renderMarkdown("[text](https://a.com) and https://b.com");
  assert.equal((out.match(/<a /g) || []).length, 2, out);
  assert.match(out, /href="https:\/\/a\.com"/);
  assert.match(out, /href="https:\/\/b\.com"/);
});

test("md: a list item does not swallow a following hr or table", () => {
  const hr = renderMarkdown("- item\n---\n");
  assert.match(hr, /<hr>/, `the thematic break must survive, got: ${hr}`);
  assert.match(hr, /<li>item<\/li>/);

  const table = renderMarkdown("- item\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  assert.match(table, /<table>/, `the table must survive, got: ${table}`);
  assert.match(table, /<li>item<\/li>/);
  assert.match(renderMarkdown("- item\nwrapped\n"), /<li>item wrapped<\/li>/);
});

test("md: a fence closes with AT LEAST as many backticks as opened it", () => {
  const nested = renderMarkdown("````md\n```js\nconst a = 1;\n```\n````");
  assert.match(nested, /<pre><code class="language-md">/, nested);
  assert.match(nested, /```js/, "the inner fence is CONTENT, not a nested block");
  assert.match(renderMarkdown("````\nx\n`````"), /<pre><code[^>]*>x<\/code><\/pre>/);
});

test("md: \\| inside a code span in a table cell loses the backslash", () => {
  const out = renderMarkdown("| a |\n| - |\n| `x\\|y` |");
  assert.match(out, /<code>x\|y<\/code>/, out);
  assert.equal((out.match(/<td>/g) || []).length, 1, `still one column: ${out}`);
});

test("md: a loose list is ONE list and keeps every item", () => {
  const out = renderMarkdown("- a\n\n- b");
  assert.equal((out.match(/<ul>/g) || []).length, 1, out);
  assert.match(out, /<li>a<\/li>/);
  assert.match(out, /<li>b<\/li>/);
  const after = renderMarkdown("- a\n\nafter");
  assert.match(after, /<\/ul>/);
  assert.match(after, /<p>after<\/p>/);
});

test("md: an ordered list keeps its start number", () => {
  assert.match(renderMarkdown("3. a\n4. b"), /<ol start="3">/);
  assert.match(renderMarkdown("1. a\n2. b"), /<ol>/);
  assert.doesNotMatch(renderMarkdown("1. a\n2. b"), /start=/);
});

test("md: a `=====` fence after a list does not join the last item", () => {
  const html = renderMarkdown("Current goal:\n=====\n- first\n- last item\n=====");
  assert.doesNotMatch(html, /last item =====/, "the fence must not be glued onto the bullet");
  assert.match(html, /<li>last item<\/li>/, "the item renders on its own");
  assert.match(html, /<p>=====<\/p>/, "and the fence is its own block");
  assert.doesNotMatch(html, /<h1/, "no setext heading is invented");
});

test("md: an indented `=====` also ends the item", () => {
  const html = renderMarkdown("- a\n   =====\n");
  assert.doesNotMatch(html, /<li>a =====<\/li>/);
});

