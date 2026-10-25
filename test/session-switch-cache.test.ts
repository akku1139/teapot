import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

/**
 * Switching BACK to a loaded session must not re-stabilize the whole cache twice, and must say it
 * is refreshing.
 *
 * Reported: "1回でもロードしたことがあるセッションに再度移動すると絶望的にラグい上に、フロントエンドの
 * メモリ使用もバーストする". The first load was fine (`loading timeline…` animates); only the cached
 * path was pathological.
 *
 * MEASURED on a 2,000-event session before the fix: 1,942ms to settle with a 553ms FROZEN frame.
 * `stabilize()` ran twice on the same array — once for effect and once for the value — and the first
 * call wrote every key into `evCache` that the second then re-read, so the whole pass was wasted work
 * proportional to the session size.
 *
 * MEASURED after: 379ms, 0ms maximum frame gap.
 */
test("a cached switch stabilizes the events ONCE (#switch)", () => {
  const app = readSource("frontend/App.tsx");
  const at = app.indexOf("const cached = timelineCache.get(tid)");
  assert.ok(at > 0, "the cache hydrate must exist");
  const body = app.slice(at, at + 1600).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const calls = [...body.matchAll(/stabilize\(/g)].length;
  assert.equal(
    calls,
    1,
    `stabilize() must be called exactly once on the cached array — it WRITES evCache, so a second ` +
      `pass is a full re-scan for nothing, proportional to the session size (#switch)`,
  );
});

test("a cached switch still reports that a refresh is in flight (#switch)", () => {
  const app = readSource("frontend/App.tsx");
  const at = app.indexOf("const cached = timelineCache.get(tid)");
  const body = app.slice(at, at + 1600);
  assert.match(
    body,
    /setLoadingFeed\(true\)/,
    "the spinner was gated on `!events().length`, so a cached session refreshed with no visible " +
      "sign — which reads as a frozen UI (#switch)",
  );
});

test("the timeline cache is bounded by BYTES, not only by count (#switch)", () => {
  /**
   * A snapshot holds every event object of a session. Real logs here reach 72,923 events / 52.8MB of
   * JSON in ONE session, so six of them is hundreds of MB of live JS objects — the reported
   * "ずっと開いてると900MBとかいく". Six small conversations are cheap and six huge ones are not, and
   * a count says 6 either way.
   */
  const app = readSource("frontend/App.tsx");
  assert.match(app, /TIMELINE_CACHE_MAX_BYTES/, "there must be a byte budget (#switch)");
  const at = app.indexOf("while (timelineCache.size > TIMELINE_CACHE_MAX");
  assert.ok(at > 0, "the eviction loop must exist");
  const body = app.slice(at, at + 400);
  assert.match(
    body,
    /TIMELINE_CACHE_MAX_BYTES/,
    "eviction must consider the byte budget, or one huge session pins hundreds of MB (#switch)",
  );
});
