import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource, stripSourceComments } from "./helpers/source.ts";

/**
 * In-feed content growth must re-pin a follower.
 *
 * Reported: "goal関連のカードがタイムラインに流れたときにスクロール追従が動かない".
 *
 * The mechanism is structural. `.feed` is `flex: 1` inside a fixed-height column, so its BOX does
 * not change when rows arrive — the `ResizeObserver` that watches the feed only sees viewport and
 * composer changes. Anything rendered INSIDE the feed therefore has to re-pin itself, and only two
 * things did: a `<details>` the operator opens (per-row `onResize`) and the compaction banner.
 *
 * Geometry cannot be asserted here (no layout engine), so this asserts the RULE: the re-pin effect
 * must key on the event list, not only on the banner.
 */
test("the tail re-pin keys on content, not just the compaction banner (#scroll)", () => {
  const raw = readSource("frontend/App.tsx");
  // the marker is a COMMENT, so find it in the raw source and take the code that follows it
  const at = raw.indexOf("Re-pin after ANY in-feed content change");
  assert.ok(at > 0, "the content re-pin effect must exist and say why");
  const block = stripSourceComments(raw.slice(at, at + 2000));
  assert.match(
    block,
    /void events\(\)\.length/,
    "the effect must read the EVENT LIST — a goal card, a divider or a todo row all arrive that " +
      "way, and none of them changes the feed's box (#scroll)",
  );
  assert.match(
    block,
    /scrollHeight/,
    "and compare scrollHeight, since the box itself does not move when content grows",
  );
  assert.match(
    block,
    /atBottom\(\)[\s\S]{0,40}pinToTail\(\)/,
    "a reader who scrolled up must not be dragged down — the pin is gated on atBottom()",
  );
});

test("the feed is a flex child, which is WHY its box cannot be watched for content (#scroll)", () => {
  // if this ever stops being true the reasoning above changes, so pin it
  const css = stripSourceComments(readSource("frontend/app.css"));
  const rule = /\.feed\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, ".feed must have its own rule");
  assert.match(rule![1]!, /flex:\s*1/, "a flex child keeps its box while content grows inside it");
  assert.match(rule![1]!, /overflow-y:\s*auto/, "and it is the scroll container");
});
