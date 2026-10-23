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
import { readSource } from "./helpers/source.ts";

/** the source from `anchor` up to the next top-level `function` declaration */
function fnBlock(app: string, anchor: string): string {
  const at = app.indexOf(anchor);
  assert.ok(at !== -1, `anchor not found: ${anchor}`);
  const rest = app.slice(at + anchor.length);
  const next = rest.search(/\n(?:export )?function /);
  return rest.slice(0, next === -1 ? rest.length : next);
}

test("ToolRow narrows its result dependency instead of reading the pair map raw (#render)", async () => {
  const block = fnBlock(readSource("frontend/App.tsx"), "function ToolRow(");
  assert.match(
    block,
    /equals:\s*\(a,\s*b\)\s*=>\s*a\?\.id\s*===\s*b\?\.id/,
    "the row must memoize its RESULT by identity — without the `equals`, every append " +
      "invalidates every row and the whole subtree (including HighlightedCode) is rebuilt (#render)",
  );
  assert.match(
    block,
    /const\s+res\s*=\s*\(\)\s*=>\s*resEv\(\)/,
    "every read must go through the narrowed memo, or the raw prop re-introduces the wide " +
      "dependency the memo exists to cut (#render)",
  );
});

test("HighlightedCode caches by CONTENT, so a remount cannot lose the markup (#render)", async () => {
  const app = readSource("frontend/App.tsx");
  assert.match(
    app,
    /const HIGHLIGHT_CACHE = new Map/,
    "the highlight result must outlive the component instance — an instance-local signal is " +
      "discarded whenever the row's subtree is rebuilt (#render)",
  );
  assert.match(
    app,
    /const HIGHLIGHT_MAX = \d+/,
    "the cache must be bounded — a long session shows thousands of distinct commands (#render)",
  );
  const block = fnBlock(app, "function HighlightedCode(");
  assert.match(
    block,
    /createSignal\(cached\(\)\s*\?\?\s*""\)/,
    "the signal must be SEEDED from the cache, or the first render is always the plain fallback " +
      "and the block has to race the grammar load again (#render)",
  );
  assert.ok(
    !/if \(run !== mine\) return;/.test(block),
    "an 'abandon my run' guard discards the only result that will arrive — the content cache " +
      "makes it unnecessary and it is what lost the highlighting before (#render)",
  );
});
