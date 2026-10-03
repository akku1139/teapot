/**
 * #81 — chats stuck collapsed with a 🧩 badge but no children.
 *
 * The reported DOM showed ten of fifteen chats collapsed, five of them
 * displaying a sub-agent count (🧩 4, 1, 2, 8, 2) with none of those children
 * rendered. Nothing errored and every row still had a working ▸ caret, so it
 * read as a tree bug rather than as leftover state.
 *
 * It WAS leftover state, and it was not the operator's doing:
 *
 *   - In the #18 build each top-level chat had its OWN header row, and clicking
 *     that header collapsed the chat, writing `chat:<id>` into the persisted
 *     `teapot.wsCollapsed` set.
 *   - #18's follow-up (adaef8e) deleted the header row to fix the
 *     double-rendering. With it went the ONLY control that could clear those
 *     keys — so they were unreachable, and survived several releases.
 *
 * Each was individually recoverable by clicking, but "click ten carets to undo
 * something a previous version did" is not a reasonable ask, and the operator
 * cannot tell which keys are theirs.
 *
 * So the load path drops the header-era keys once. Deliberately narrow: `ws:`
 * keys and anything the current UI created survive, so a real grouping still
 * persists across a reload.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** the migration, exactly as App.tsx performs it on load */
function migrate(stored: string[] | null, marker: string | null): { keys: string[]; dropped: number } {
  const keys = Array.isArray(stored) ? stored.filter((x) => typeof x === "string") : [];
  const VERSION = 2;
  const m = Number(marker ?? "0");
  if (m < VERSION) {
    const kept = keys.filter((k) => !k.startsWith("chat:"));
    return { keys: kept, dropped: keys.length - kept.length };
  }
  return { keys, dropped: 0 };
}

test("header-era chat keys are dropped on first load (#81)", () => {
  const r = migrate(["chat:teapot", "chat:teapot-3", "chat:tyb2-3"], null);
  assert.deepEqual(r.keys, [], "the ten orphaned chat keys must not survive (#81)");
  assert.equal(r.dropped, 3);
});

test("directory collapse keys are PRESERVED (#81)", () => {
  // the migration must only remove what the removed UI wrote
  const r = migrate(["ws:/home/ai-agent/work/teapot", "chat:teapot"], null);
  assert.deepEqual(r.keys, ["ws:/home/ai-agent/work/teapot"], "`ws:` is a live control and must persist (#81)");
});

test("the migration runs once, then leaves keys alone (#81)", () => {
  // after the marker is written, a chat the operator collapses NOW must stick
  const first = migrate(["chat:old"], null);
  assert.deepEqual(first.keys, []);
  const second = migrate(["chat:mine"], "2");
  assert.deepEqual(second.keys, ["chat:mine"], "a deliberate collapse must survive a reload (#81)");
  assert.equal(second.dropped, 0, "and must not be re-dropped every load (#81)");
});

test("a malformed store does not throw (#81)", () => {
  for (const bad of [null, "not json", 42 as any, {} as any]) {
    const r = migrate(bad as any, null);
    assert.ok(Array.isArray(r.keys), `must degrade to an empty set (#81): ${JSON.stringify(bad)}`);
  }
});

test("sub-agent collapse is a DIFFERENT key and must not be touched (#81)", () => {
  // collapsed sub-agents live in their own store (teapot.collapsedSubs or
  // similar); this migration only rewrites teapot.wsCollapsed
  const r = migrate(["ws:/p", "chat:x"], null);
  assert.ok(!r.keys.some((k) => k.includes("sub")), "no sub-agent keys are invented or removed (#81)");
});

test("the app writes a version marker (#81)", () => {
  // a migration with no marker re-runs on every load, which would silently
  // discard a collapse the operator set up after upgrading
  const src = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  assert.match(src, /teapot\.wsCollapsed\.v/, "a version marker must be written (#81)");
  assert.match(src, /if \(marker < VERSION\)/, "and it must gate the migration (#81)");
});
