import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../frontend/md.js";

function assertInert(html: string, why: string): void {
  assert.doesNotMatch(html, /<(img|script|iframe|object|embed|svg)\b/i, `raw element survived (${why}): ${html}`);
  assert.doesNotMatch(html, /<[^>]*\son[a-z]+\s*=/i, `an inline handler became an attribute (${why}): ${html}`);
  assert.doesNotMatch(html, /href\s*=\s*"\s*(javascript|data|vbscript):/i, `a dangerous href survived (${why}): ${html}`);
}

test("raw HTML in a model response is escaped, not inserted (#security)", () => {
  const attacks = [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '<iframe src=//evil.example></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<svg onload=alert(1)>',
  ];
  for (const a of attacks) assertInert(renderMarkdown(a), a);
});

test("a javascript:/data: LINK is not turned into an anchor (#security)", () => {
  for (const a of [
    "[click](javascript:alert(1))",
    "[click](JAVASCRIPT:alert(1))",
    "[click](vbscript:x)",
    "[click](data:text/html,<script>alert(1)</script>)",
    "![x](javascript:alert(1))",
  ]) {
    const html = renderMarkdown(a);
    assert.doesNotMatch(html, /<a\s/i, `no anchor may be built for ${a}`);
    assertInert(html, a);
  }
});

test("a legitimate https link still works, and is safely attributed (#security)", () => {
  const html = renderMarkdown("[docs](https://example.com/x)");
  assert.match(html, /<a href="https:\/\/example\.com\/x"/);
  assert.match(html, /rel="noopener noreferrer"/, "target=_blank without rel is a tabnabbing hole");
  assert.match(html, /target="_blank"/);
});

test("an attribute-breaking attempt inside a link target cannot escape the href (#security)", () => {
  const html = renderMarkdown('[x](https://ok.example/" onmouseover="alert(1))');
  assertInert(html, "attribute break");
  assert.doesNotMatch(html, /<[^>]*\sonmouseover/i, "the handler must not end up inside a tag");
});
