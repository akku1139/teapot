import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import { cssRuleBody } from "./helpers/css.ts";

/**
 * A card's body never scrolls sideways, and a reloaded file tree is still sorted.
 *
 * Two reports that turned out to share a cause — a value recomputed from the WRONG source:
 *
 *   1. "🔍️ completion audit started のカードの内容が横スクロールされる" while "🎯 goal set" beside it
 *      wrapped. Same card component, two renderings: markdown in one case, a FENCED CODE BLOCK in
 *      the other. A fenced block becomes `<pre>`, and `<pre>` re-declares `white-space: pre`, which
 *      stops the wrapping its parent was given. `.toolbody` had already been hand-fixed for exactly
 *      this, which is how the third copy got forgotten.
 *
 *   2. "ファイルツリーのリロードを重ねた結果、ディレクトリ先、アルファベット順になってない". The server
 *      sorted correctly; the frontend's merge walked the OLD array and looked each row up in the
 *      fresh one, so the cached ORDER survived and a refresh never re-sorted.
 */
test("every card body wraps, including fenced code (#ui)", () => {
  const css = readSource("frontend/app.css");
  for (const sel of [".card .cardbody", ".card pre", ".card code"]) {
    const body = cssRuleBody(css, sel);
    assert.match(body, /white-space:\s*pre-wrap/, `${sel} must wrap — <pre> re-declares pre (#ui)`);
    assert.match(
      body,
      /overflow-wrap:\s*anywhere/,
      `${sel} must break long tokens, or one long command scrolls the card (#ui)`,
    );
    assert.match(body, /min-width:\s*0/, `${sel} must be allowed to shrink below its content (#ui)`);
  }
});

test("the file tree takes its ORDER from the fresh response (#ui)", () => {
  const src = readSource("frontend/components/FilesPanel.tsx");
  const at = src.indexOf("const mergeKids");
  assert.ok(at > 0, "mergeKids must exist");
  // the whole helper: brace-match from its opening brace so the assertion sees all of it
  let depth = 0;
  let end = at;
  for (let i = src.indexOf("{", at); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (!depth) { end = i + 1; break; }
    }
  }
  const body = src.slice(at, end);
  assert.match(
    body,
    /rows\.map\(/,
    "the merge must walk the FRESH rows so a refresh re-sorts — walking the old array preserved " +
      "the stale order and the server's sort never took effect (#ui)",
  );
  // `old` may still be read for LOOKUPS (`new Map(old.map(...))`) — what must not happen is the
  // RESULT being built by walking the cached array, which is what preserved the stale order
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    code,
    /const\s+\w+\s*=\s*old\.map\(/,
    "building the merged list by walking the cached array preserves its order, so a refresh " +
      "never re-sorts (#ui)",
  );

});
