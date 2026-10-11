/**
 * "Scroll follow sometimes stops on its own."
 *
 * The feed keeps a user-scroll lock so streaming cannot yank a reader who has
 * scrolled up. The old test for "the reader moved up" was a GAP heuristic:
 *
 *     gap = scrollHeight - scrollTop - clientHeight
 *     if (!nearBottom && gap > lastGap + 8 && gap > 24) userScrolledUp = true
 *
 * Content ARRIVING BELOW increases the gap by exactly as much, because
 * `scrollTop` does not move when the browser appends past the viewport. So a new
 * tool result or a burst of stream text larger than the threshold was read as a
 * deliberate scroll: follow switched itself off and the "jump to present" pill
 * appeared while nobody had touched anything. It is intermittent because it
 * needs the growth to exceed the thresholds on a frame that fires a scroll event
 * — which is why it survived as "sometimes".
 *
 * Measured in the built bundle with synthetic feed geometry (happy-dom lays
 * nothing out, so the geometry is supplied and the app's own handlers run):
 *
 *     bottom-pinned reader, NO input:  +10px ok · +20px ok · +30px LOST FOLLOW
 *                                      +100px LOST · +900px LOST
 *   after the fix: every growth case keeps following, and a real drag up still
 *   stops it.
 *
 * There was a SECOND half: the handler ended with a bare `setAtBottom(nb)`, so
 * even with the lock fixed one raw measurement cleared the flag. Both now read
 * the same decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceUrl } from "./helpers/source.ts";
import { isScrollingAway } from "../frontend/scroll-follow.ts";

const app = readSourceUrl(new URL("../frontend/App.tsx", import.meta.url));

test("content growing below a bottom-pinned reader is not a scroll away", () => {
  const bottom = { gap: 0, top: 1000 };
  // the reported case: the browser appends BELOW, so `top` is unchanged and only
  // the gap grows — 900px of new content is not the operator scrolling
  assert.equal(isScrollingAway({ gap: 900, top: 1000 }, bottom), false);
  assert.equal(isScrollingAway({ gap: 30, top: 1000 }, bottom), false, "even past the old 24px floor");
  assert.equal(isScrollingAway({ gap: 30_000, top: 1000 }, bottom), false, "and past it by a lot");
});

test("a real move up still stops following", () => {
  const bottom = { gap: 0, top: 1000 };
  assert.equal(isScrollingAway({ gap: 300, top: 700 }, bottom), true, "the offset went DOWN");
  assert.equal(isScrollingAway({ gap: 120, top: 940 }, bottom), true, "even a small drag");
  // and returning to the tail is not a move away
  assert.equal(isScrollingAway({ gap: 0, top: 4000 }, { gap: 900, top: 900 }), false);
  // the first event has nothing to compare with
  assert.equal(isScrollingAway({ gap: 5000, top: 0 }, undefined), false);
});

test("the feed handler uses the shared rule for BOTH the lock and the flag (#40)", () => {
  const at = app.indexOf('<div class="feed" onscroll=');
  assert.notEqual(at, -1, "the feed scroll handler must exist");
  const body = app.slice(at, app.indexOf("</Show>", at));
  assert.match(body, /isScrollingAway\(/, "the lock must use the extracted rule");
  assert.doesNotMatch(
    body,
    /gap > lastScrollGap \+ 8/,
    "the gap-only heuristic IS the bug — growth fakes it",
  );
  // the sample must be read BEFORE it is overwritten, or the comparison is
  // always false and the lock silently never fires
  const read = body.indexOf("const movingAway = isScrollingAway(");
  const write = body.indexOf("lastScrollSample = { gap, top };");
  assert.ok(read !== -1 && write !== -1, "the sample must be both read and written");
  assert.ok(read < write, "reading after the write compares a value with itself");
  // both call sites must use that ONE decision
  assert.match(body, /else if \(movingAway\) setAtBottom\(false\)/, "the follow flag must agree with the lock");
  assert.match(body, /else if \(movingAway\) userScrolledUp = true;/, "and the lock itself");
});
