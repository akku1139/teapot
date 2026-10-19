/**
 * #143 — "最近メモリ使用量増えてきた": the client held 418 MB for one session
 * (600 MB after a reload), while the server was a healthy 195 MB.
 *
 * ## Why the client, and why not virtual scrolling
 *
 * The timeline loads 2000 events per page (`FEED_PAGE`), and a rendered row is ~11 DOM
 * nodes carrying already-parsed markdown — MEASURED at 11.0 nodes/row in the real
 * bundle, so one page is ~22 000 nodes. Every one of them holds a DOM subtree, a
 * Solid owner, and rendered HTML.
 *
 * Virtual scrolling would cut that, but it is bought by UNMOUNTING rows, and this feed
 * depends on real DOM: scroll anchoring measures `getBoundingClientRect()` on the first
 * visible row, rows are looked up by `data-eid`, and the operator expects cmd-F and
 * text selection to work over loaded history.
 *
 * `content-visibility: auto` instead lets the browser skip LAYOUT AND PAINT for rows
 * outside the viewport while leaving them in the DOM — the same memory win for the
 * expensive part (style/layout/paint of rendered markdown) with none of the
 * unmounting.
 *
 * ## The two declarations that make it safe, and why both are pinned here
 *
 * 1. `contain-intrinsic-size` is NOT optional. Without a placeholder size a skipped row
 *    collapses to 0px, `scrollHeight` shrinks, and every scroll-anchoring path in
 *    App.tsx — which measures the container's height before and after a reflow —
 *    computes a wrong delta, so the view jumps on every append. happy-dom does no
 *    layout, so this is asserted as a CSS CONTRACT (the project's rule) rather than as
 *    pixels.
 *
 * 2. The `auto` keyword in `auto 140px` lets the browser remember a row's real size
 *    once it has been rendered, so scrolling back to a tall row does not jump.
 *
 * The selector is `.feed > .msg`, not `.msg`: rows elsewhere in the app are not
 * scrolled long lists and must keep normal layout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBody } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

test("timeline rows skip layout/paint when off-screen (#143)", () => {
  const body = cssRuleBody(css, 'html[data-feedcv="on"] .feed > .msg');
  assert.ok(body, "the rule must exist — without it the client holds 418 MB of laid-out rows");
  assert.match(
    body!,
    /content-visibility:\s*auto/,
    "rows outside the viewport must be skipped; `auto` (not `hidden`) keeps them in the DOM",
  );
});

test("a skipped row keeps a placeholder height, or scroll anchoring breaks (#143)", () => {
  const body = cssRuleBody(css, 'html[data-feedcv="on"] .feed > .msg');
  assert.ok(body, "precondition: the rule exists");
  // WITHOUT this, a skipped row measures 0px, scrollHeight collapses, and the
  // before/after height deltas App.tsx uses for scroll anchoring are wrong — the
  // reported symptom would change from "memory" to "the view jumps"
  assert.match(
    body!,
    /contain-intrinsic-size:\s*auto\s+\d+px/,
    "contain-intrinsic-size must carry BOTH the `auto` keyword (remember the real size) and a placeholder height",
  );
});

test("the containment applies ONLY to timeline rows (#143)", () => {
  // a blanket `.msg { content-visibility }` would also affect the composer's echo, the
  // right panel and the terminal drawer, which are not long scrolled lists
  const blanket = cssRuleBody(css, ".msg") ?? "";
  assert.doesNotMatch(
    blanket,
    /content-visibility/,
    "the containment must be scoped to `.feed > .msg`, not every `.msg`",
  );
});

test("the feed itself is still the scroll container (#143)", () => {
  // content-visibility on rows is only meaningful because .feed scrolls; if that ever
  // moved to <body> the containment would skip the wrong thing
  const body = cssRuleBody(css, ".feed");
  assert.ok(body, "precondition: .feed exists");
  assert.match(body!, /overflow-y:\s*auto/, ".feed must remain the scroll container");
});

test("the containment is behind a RUNTIME flag, so an A/B needs no rebuild (#143)", () => {
  // The operator asked for a release to A/B, which only means anything if the same
  // build can run both ways. A bare `.feed > .msg` rule would need two releases to
  // compare — and comparing two builds measures the build, not the CSS.
  const body = cssRuleBody(css, 'html[data-feedcv="on"] .feed > .msg');
  assert.ok(body, "the rule must be gated on the data attribute");
  assert.match(body!, /content-visibility:\s*auto/);
  // and the UNGATED selector must not carry it, or turning the flag off would do nothing
  assert.throws(
    () => cssRuleBody(css, ".feed > .msg"),
    /no rule whose selector is exactly/,
    "there must be no ungated `.feed > .msg` rule at all — it would make the flag a no-op",
  );
});
