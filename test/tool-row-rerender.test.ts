import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheHighlighted, highlightedHtml, highlightCacheSize } from "../frontend/lib/highlight-cache.ts";

test("a highlight survives the component instance, and the cache is bounded (#render)", () => {
  const key = `shellscript::${Date.now()}::echo hi`;
  assert.equal(highlightedHtml(key), undefined, "nothing cached yet");
  cacheHighlighted(key, "<pre class='shiki'>hi</pre>");
  assert.equal(
    highlightedHtml(key),
    "<pre class='shiki'>hi</pre>",
    "a second reader — a REMOUNTED component — must get the markup without re-highlighting",
  );

  for (let i = 0; i < 500; i++) cacheHighlighted(`k${i}`, "x");
  assert.ok(
    highlightCacheSize() <= 400,
    `the cache must stay bounded, got ${highlightCacheSize()} entries`,
  );
  assert.equal(highlightedHtml(key), undefined, "the oldest entries are the ones evicted");
});
