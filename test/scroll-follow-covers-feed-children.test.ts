import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

/**
 * EVERY child of the feed must be able to move a following reader to the tail.
 *
 * The feed is `flex: 1` inside a fixed-height column, so its BOX does not change when content grows
 * and the ResizeObserver cannot see it. Anything that appears INSIDE the feed therefore has to
 * re-pin itself, and that produced this report once already: "goal関連のカードがタイムラインに流れた
 * ときにスクロール追従が動かない" — a goal card is a feed child and nothing re-pinned.
 *
 * The fix for that (below) keyed the effect on `events().length` + `compacting()`, which covers LOG
 * rows and the compaction banner — and nothing else. MEASURED gaps found by auditing the JSX:
 *
 *   - `chatEvents()` is `events()` PLUS the pending echoes, so a message the operator just sent
 *     (an echo appears) or a delivered prompt (an echo disappears) changed the FEED while
 *     `events().length` stayed put;
 *   - the "beginning of log" divider and the tail loading row render outside `<For>` and touched
 *     nothing the effect watched.
 *
 * This test is the audit, mechanised: it finds every `Show`/`For` child of the feed in the JSX and
 * requires the effect's dependency list to mention the signal each one is gated on. A new feed child
 * without a line there fails here instead of waiting for an operator to notice the view drifting.
 */
const FEED_DEPS = new Set([
  "chatEvents",   // the rows themselves
  "compacting",   // the compaction banner
  "olderDone",    // the "beginning of log" divider
  "loadingFeed",  // the tail loading row
  "loadingOlder", // the "loading older events…" row
]);

test("the re-pin effect watches every signal an in-feed row is gated on (#scroll)", () => {
  const app = readSource("frontend/App.tsx");
  const effectAt = app.indexOf("void chatEvents().length;");
  assert.ok(effectAt > 0, "the in-feed re-pin effect must exist (#scroll)");
  const effect = app.slice(effectAt, app.indexOf("const f = feedEl();", effectAt));

  /**
   * The feed's own JSX: from the compaction banner to the live bubble.
   *
   * Bounded deliberately — the whole file contains many `<Show when={…}>` that are not feed
   * children, and requiring those here would make the test wrong rather than strict.
   */
  const feedStart = app.indexOf('<Show when={compacting()}>');
  const feedEnd = app.indexOf('isTimelineLive() && live()', feedStart);
  assert.ok(feedStart > 0 && feedEnd > feedStart, "the feed's render range must be findable");
  const feedJsx = app.slice(feedStart, feedEnd);

  /**
   * Top-level signals a feed child is conditioned on. `chatEvents()` covers `<For>`; the rest are
   * `<Show>` gates. Matching `<Show when={x()` keeps this to the granularity the effect uses.
   */
  const gates = new Set<string>();
  for (const m of feedJsx.matchAll(/<Show when=\{([A-Za-z_$][\w$]*)\(/g)) gates.add(m[1]!);
  for (const m of feedJsx.matchAll(/<For each=\{([A-Za-z_$][\w$]*)\(/g)) gates.add(m[1]!);

  const uncovered = [...gates].filter((g) => !FEED_DEPS.has(g) && !effect.includes(`void ${g}()`));
  assert.deepEqual(
    uncovered,
    [],
    `these feed children can appear without moving a following reader to the tail: ${uncovered.join(", ")} ` +
      `— add them to the re-pin effect's dependencies (#scroll)`,
  );
});

test("the rows themselves are watched through chatEvents, not the raw log (#scroll)", () => {
  const app = readSource("frontend/App.tsx");
  const at = app.indexOf("void chatEvents().length;");
  assert.ok(at > 0, "the effect must watch chatEvents (#scroll)");
  const body = app.slice(at - 900, at);
  assert.match(
    body,
    /pending echoes|ECHO/,
    "and say WHY it is chatEvents and not events: echoes change the feed without touching the log (#scroll)",
  );
});
