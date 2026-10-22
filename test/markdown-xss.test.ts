/**
 * An LLM response must never become executable markup.
 *
 * From the OpenCode advisory CVE-2026-22813 / GHSA-c83v-7274-4vgp: their markdown renderer
 * inserted arbitrary HTML into the DOM with no sanitisation and no CSP, so controlling an LLM
 * response yielded JavaScript execution on the local origin — and the `/pty/` endpoints then gave
 * shell access.
 *
 * teapot is not vulnerable, and the reason is structural rather than a sanitiser: `frontend/md.js`
 * escapes ALL HTML first, then applies its own rules to the ESCAPED text, so raw markup cannot
 * survive as markup. Links are only built for `https:` targets, with `rel="noopener noreferrer"`.
 *
 * These cases are pinned because the guarantee is easy to break by accident: any change that
 * starts emitting raw tags (a new block rule, an "allow raw HTML" convenience) would silently
 * reopen the class of bug, and the UI has no CSP to catch it.
 *
 * MEASURED outputs are in docs/security-advisories.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../frontend/md.js";

/** no executable construct survived: no tag, no attribute, no script-capable scheme in an href */
function assertInert(html: string, why: string): void {
  /**
   * Assert on TAG STRUCTURE, not on substrings.
   *
   * The escaped output legitimately CONTAINS the attack text — `<p>&lt;img … onerror=…&gt;</p>` is
   * the safe rendering, and a naive `/onerror/` check fails on it while proving nothing. What must
   * not exist is a real tag or a real attribute, so the assertions look for `NAME=` inside a tag
   * body, and for the tag openers themselves.
   */
  assert.doesNotMatch(html, /<(img|script|iframe|object|embed|svg)\b/i, `raw element survived (${why}): ${html}`);
  // an on* handler is only dangerous as an ATTRIBUTE, i.e. inside `<>` — escaped text has no `<`
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
  /**
   * The one place the renderer emits an `href`, so the one place a scheme check has to hold. These
   * render as literal text, which is the safe outcome — the operator sees what was written and
   * nothing is clickable.
   */
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
  // the guard must not be so strict that links break
  const html = renderMarkdown("[docs](https://example.com/x)");
  assert.match(html, /<a href="https:\/\/example\.com\/x"/);
  assert.match(html, /rel="noopener noreferrer"/, "target=_blank without rel is a tabnabbing hole");
  assert.match(html, /target="_blank"/);
});

test("an attribute-breaking attempt inside a link target cannot escape the href (#security)", () => {
  // the classic: close the attribute and add a handler
  const html = renderMarkdown('[x](https://ok.example/" onmouseover="alert(1))');
  assertInert(html, "attribute break");
  /**
   * MEASURED output: the renderer autolinks only `https://ok.example/&quot` and leaves
   * `onmouseover=&quot;alert(1))` as TEXT, so the handler never becomes an attribute. The escaped
   * quote (`&quot`) is what stops it, which is why asserting the absence of the STRING would be the
   * wrong check — it is present as text. Assert the structure instead.
   */
  assert.doesNotMatch(html, /<[^>]*\sonmouseover/i, "the handler must not end up inside a tag");
});
