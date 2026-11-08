/**
 * A link in a timeline row opens in a NEW TAB.
 *
 * The timeline is the operator's workspace: a click that navigates the harness away in the same tab loses the session view
 * (and, mid-stream, the live buffer). Markdown links already carried `target="_blank" rel="noopener noreferrer"`; bare
 * pasted URLs did not, so the common case — a URL in model output — was the one that navigated away.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../frontend/md.js";

const anchors = (html: string) => html.match(/<a [^>]*>/g) ?? [];

test("a bare URL opens in a new tab", () => {
  const html = renderMarkdown("see https://example.com/path?q=1 for details");
  const [a] = anchors(html);
  assert.ok(a, `expected an anchor, got ${html}`);
  assert.match(a!, /target="_blank"/);
  assert.match(a!, /rel="noopener noreferrer"/);
});

test("a markdown link opens in a new tab", () => {
  const [a] = anchors(renderMarkdown("[docs](https://example.com/docs)"));
  assert.ok(a);
  assert.match(a!, /target="_blank"/);
  assert.match(a!, /rel="noopener noreferrer"/);
});

test("a link whose text is the same URL is not nested", () => {
  // the pre-existing trap: the autolink pass re-matched inside the anchor it had just built
  const html = renderMarkdown("[https://example.com](https://example.com)");
  assert.equal(anchors(html).length, 1, `one anchor only, got ${html}`);
  assert.doesNotMatch(html, /<a [^>]*><a /);
});

test("an image is still an image, not a link", () => {
  const html = renderMarkdown("![alt](https://example.com/x.png)");
  assert.match(html, /<img /);
  assert.equal(anchors(html).length, 0);
});
