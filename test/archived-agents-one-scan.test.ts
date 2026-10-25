import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource, stripSourceComments } from "./helpers/source.ts";

/**
 * Listing archived agents must scan the session directory ONCE, not once per entry.
 *
 * Reported as "設定の 🗄 archive のロードが遅すぎる(もしかしてconfig.jsonだけじゃなくて全セッションの
 * ディレクトリを回ってる?)" — yes: `sessionsOf(id)` calls `allSessions()`, which reads every session
 * directory, stats each `chat.jsonl` and BACKFILLS a manifest for any that lacks one. Mapping over
 * the archived entries made it O(archived × sessions), with writes on the way through.
 */
test("archivedAgents counts sessions from a single scan (#perf)", () => {
  const src = stripSourceComments(readSource("src/master.ts"));
  const at = src.indexOf("archivedAgents():");
  assert.ok(at > 0, "archivedAgents must exist");
  const body = src.slice(at, src.indexOf('.sort((a, b) => (b.archivedAt', at));

  // comments in this method NAME the old slow call to explain it, so strip them before matching
  const clean = stripSourceComments(body);
  const scans = clean.match(/this\.allSessions\(\)/g) ?? [];
  assert.equal(scans.length, 1, "one scan for the whole list — not one per archived entry (#perf)");
  assert.doesNotMatch(
    clean,
    /this\.sessionsOf\(/,
    "`sessionsOf` runs a full scan per call, which is the reported slowness (#perf)",
  );
  assert.match(clean, /sessionCounts/, "the per-agent counts come from that single scan (#perf)");
});
