import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The markdown cache is keyed by the WHOLE message, so it must be byte-bounded (#186).
 *
 * An entry is the source string plus its rendered HTML — MEASURED, HTML runs ~1.6x the source — and the
 * cap was 500 ENTRIES. A feed of 8,000-char tool results therefore retained over 20MB of strings (UTF-16,
 * so double that in bytes) for text that may never be looked at again.
 */

test("the cache is bounded in BYTES, not only in entries (#186)", () => {
  /**
   * `frontend/md.js` is plain JS without an extension the node test runner resolves, so the module
   * cannot be imported here. The property worth pinning is structural and reads fine as a source check:
   * a count-only cap is exactly the defect.
   */
  const src = readFileSync(path.join(import.meta.dirname, "..", "frontend", "lib", "markdown.ts"), "utf8");
  assert.match(src, /MD_CACHE_MAX_BYTES/, "a byte budget must exist");
  assert.match(
    src,
    /mdCacheBytes\s*[+-]=/,
    "and it must be maintained as entries are added and removed, or it is decoration",
  );
  assert.match(src, /mdCacheBytes > MD_CACHE_MAX_BYTES/, "and actually consulted when evicting");
});

test("the bounded cache exists in exactly ONE place (#186)", () => {
  /**
   * `App.tsx` had its own copy of `renderMarkdownCached` with its own unbounded cap, so fixing the lib
   * one left half the rendering on the old rule. Two implementations of a cache is how a bound silently
   * stops being a bound.
   */
  const app = readFileSync(path.join(import.meta.dirname, "..", "frontend", "App.tsx"), "utf8");
  assert.equal(
    /function\s+renderMarkdownCached/.test(app),
    false,
    "App.tsx must import the shared cache, not define a second one",
  );
  assert.match(app, /import \{ renderMarkdownCached \} from "\.\/lib\/markdown"/, "and it must use the shared one");
});
