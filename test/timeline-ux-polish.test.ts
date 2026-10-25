import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

/**
 * Three reports, one screen.
 *
 * 1. "タイムラインの最新アイテムをロードしている間に loading timeline... が出てなくて UX も悪い" — the
 *    full-screen spinner is gated on an EMPTY feed, so a switch that hydrates from cache and then
 *    refreshes showed a complete-looking (but stale) timeline with no sign anything was happening.
 * 2. "live では thinking って出てるのに、過去メッセージでは reasoning って出てて用語が統一されてない".
 * 3. "⏳ 0 of yours queued って出てる" — the badge was gated on one count and LABELLED with another.
 */
test("a refresh in flight is visible even when rows are already on screen (#ux)", () => {
  const app = readSource("frontend/App.tsx");
  const at = app.indexOf('class="feedloading"');
  assert.ok(at > 0, "there must be a tail loading row (#ux)");
  const before = app.slice(Math.max(0, at - 400), at);
  assert.match(
    before,
    /<Show when=\{loadingFeed\(\)\}>/,
    "the tail row is gated on loadingFeed alone — requiring rows as well made it dead, because a " +
      "switch clears the feed and hydrates within the same task (#ux)",
  );
});

test("reasoning has ONE name in both places (#ux)", () => {
  const rows = readSource("frontend/components/rows.tsx");
  const app = readSource("frontend/App.tsx");
  assert.match(rows, /💭 thinking/, "a settled message says thinking (#ux)");
  assert.doesNotMatch(rows, /💭 reasoning/, "not 'reasoning' — the live bubble already says thinking (#ux)");
  assert.match(app, /💭 thinking <ThinkingTimer/, "and the live bubble keeps the same word (#ux)");
});

test("the queued badge's number is the count it was gated on (#ux)", () => {
  /**
   * The `<Show>` used `queuedCount()` (snapshot OR echoes) while the text read the snapshot alone,
   * so an echo-only queue rendered "⏳ 0 of yours queued": a badge that announces itself and then
   * says there is nothing.
   */
  const app = readSource("frontend/App.tsx");
  const at = app.indexOf('class="badge queued"');
  assert.ok(at > 0, "the queued badge must exist");
  const body = app.slice(at, at + 2600);
  assert.doesNotMatch(
    body,
    /pendingPromptIds\?\.length \?\? sel\(\)!\.pendingPrompts\} of yours queued/,
    "the label must not read the snapshot while the gate reads both sources (#ux)",
  );
  assert.match(body, /\{queuedCount\(\)\}/, "the number shown must BE the count (#ux)");
});
