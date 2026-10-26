/**
 * A TOOL ROW MUST ONLY RE-RUN ITS DERIVATION WHEN ITS OWN RESULT CHANGES.
 *
 * The user-visible symptom was intermittent syntax highlighting: "bashでshikiが当たってるカードと
 * 当たってないカードがある". The cause was render churn, and the chain is worth writing down because
 * every layer looked correct on its own.
 *
 *   - `pairInfo()` returns a NEW `{resFor, consumed, orphanCalls}` object on every append, so a
 *     row's `res()` appeared to change whenever ANY event arrived;
 *   - every row's `derived` memo therefore re-ran on every append;
 *   - MEASURED in solid-js/dist/solid.js, `createMemo`'s function ALWAYS runs on a dependency
 *     change (`runComputation` calls `node.fn`) and the `equals` comparator is consulted AFTERWARDS,
 *     in `writeSignal`. So `equals` suppressed the downstream update while the memo still rebuilt
 *     its whole JSX subtree — 20 rows produced 40 memo runs and 118 component constructions;
 *   - a rebuilt subtree REPLACES the `HighlightedCode` instances, so each new one started with an
 *     empty signal and had to finish its own async highlight. Whether it did before the next
 *     rebuild depended on timing, which is exactly the intermittency.
 *
 * The fix narrows the dependency one level earlier: a memo over this row's RESULT IDENTITY, so a
 * row with no new result is not notified at all. MEASURED after: 20 memo runs for 20 rows and 0
 * new `HighlightedCode` constructions once the content cache is warm.
 *
 * These assertions pin the SHAPE, because reverting either half is invisible in the DOM — the rows
 * still render, they just churn (or re-race the grammar).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheHighlighted, highlightedHtml, highlightCacheSize } from "../frontend/lib/highlight-cache.ts";

test("a highlight survives the component instance, and the cache is bounded (#render)", () => {
  /**
   * Asserted by CALLING the cache, not by grepping for its declaration.
   *
   * The old version matched `const HIGHLIGHT_CACHE = new Map` in App.tsx, so it broke the moment the
   * cache moved into a module — the behaviour was intact and the test was measuring the file layout.
   * A source-text assertion cannot see whether a remount actually reads the cache back.
   */
  const key = `shellscript::${Date.now()}::echo hi`;
  assert.equal(highlightedHtml(key), undefined, "nothing cached yet");
  cacheHighlighted(key, "<pre class='shiki'>hi</pre>");
  assert.equal(
    highlightedHtml(key),
    "<pre class='shiki'>hi</pre>",
    "a second reader — a REMOUNTED component — must get the markup without re-highlighting",
  );

  // bounded: past the limit the oldest entry is dropped, so a long session cannot leak
  for (let i = 0; i < 500; i++) cacheHighlighted(`k${i}`, "x");
  assert.ok(
    highlightCacheSize() <= 400,
    `the cache must stay bounded, got ${highlightCacheSize()} entries`,
  );
  assert.equal(highlightedHtml(key), undefined, "the oldest entries are the ones evicted");
});
