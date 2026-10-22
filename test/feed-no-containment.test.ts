/**
 * #143 REVERSED — the timeline no longer uses `content-visibility: auto`.
 *
 * It was added to cut memory (418 MB for one session) by letting the browser skip layout and
 * paint for rows outside the viewport, and it was REMOVED for two reasons:
 *
 *   1. The saving was smaller than expected — "思ったより軽量化効果が少なかった".
 *   2. It CAUSED the scroll drift. A skipped row is replaced by a `contain-intrinsic-size` guess
 *      and laying it out for real moves everything below it. MEASURED in headless Firefox: 300
 *      rows estimated 47100px against a real 35100px. No script can cancel that, because a
 *      correction runs after paint and is therefore itself a visible jump.
 *
 * The assertions are inverted from the file this replaces: that one required the containment to
 * be present, which meant it would pass while the drift was happening. A CSS contract is the only
 * available check — happy-dom does no layout, so the declaration IS the behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource, stripSourceComments } from "./helpers/source.ts";
import { cssRuleBody } from "./helpers/css.ts";

test("timeline rows are NOT content-visibility contained (#scroll)", async () => {
  // comments explain WHY it is gone; only a real declaration would bring the drift back
  const css = stripSourceComments(await readSource("frontend/app.css"));
  assert.equal(
    /content-visibility\s*:/.test(css),
    false,
    "content-visibility must be gone: it estimates row heights and the correction is what drifts",
  );
  assert.equal(
    /contain-intrinsic-size\s*:/.test(css),
    false,
    "and nothing should reserve a guessed row height either",
  );
});

test("a row has no containment property of its own (#scroll)", async () => {
  const css = await readSource("frontend/app.css");
  const msg = cssRuleBody(css, ".msg");
  assert.equal(
    /content-visibility|contain-intrinsic-size|contain\s*:/.test(msg),
    false,
    "`.msg` must lay out like any other element",
  );
});
