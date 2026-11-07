import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { mkdtempInRoot } from "./helpers/tmp-root.ts";
import { branchCounts, filterByBranch, readEvents, readEventsWindow } from "../src/log/events.ts";

/**
 * The pages the timeline asks for must come from a STREAM, not from a parsed copy of the whole session.
 *
 * MEASURED before this: the events endpoint cached every parsed event of every session the UI opened, which retained
 * 221MB of heap for two sessions of ~100k events ("master rss 812MB · heap 352.2MB"). These tests pin the behaviour the
 * cache used to provide, so the cache cannot come back for convenience.
 */
async function fixture() {
  const dir = await mkdtempInRoot("events-window-");
  const file = path.join(dir, "chat.jsonl");
  const lines: string[] = [];
  const push = (id: string, seq: number, type: string, data: unknown, branch = "br0") =>
    lines.push(JSON.stringify({ v: 1, id, seq, ts: "2026-01-01T00:00:00Z", agent: "a", session: "s", branch, parent: null, type, data }));
  for (let i = 1; i <= 40; i++) push(`e${i}`, i, "message", { role: "assistant", content: `m${i}` });
  push("f1", 41, "fork", { newBranch: "br2" });
  for (let i = 42; i <= 50; i++) push(`e${i}`, i, "message", { role: "assistant", content: `m${i}` }, i > 45 ? "br2" : "br0");
  await fs.writeFile(file, lines.join("\n") + "\n");
  return { dir, file };
}

test("the page before an id is served with its position as total", async () => {
  const { file } = await fixture();
  const win = await readEventsWindow(file, { before: "e30", limit: 5 });
  assert.equal(win.found, true);
  assert.deepEqual(win.events.map((e) => e.id), ["e25", "e26", "e27", "e28", "e29"]);
  assert.equal(win.total, 29, "total is how many events come before the anchor, which is what the client pages on");
});

test("a catch-up after an id returns what follows it and still counts the rest", async () => {
  const { file } = await fixture();
  const win = await readEventsWindow(file, { after: "e5", limit: 3 });
  assert.equal(win.found, true);
  assert.deepEqual(win.events.map((e) => e.id), ["e6", "e7", "e8"]);
  const all = await readEvents(file);
  assert.equal(win.total, all.length, "the total is the whole log, or the client would think history ended early");
});

test("an unknown anchor reports found=false instead of an empty page", async () => {
  const { file } = await fixture();
  const win = await readEventsWindow(file, { after: "nope", limit: 3 });
  assert.equal(win.found, false, "the caller answers this with the tail plus `gap`, not with a silent empty page");
});

test("the branch filter applies while streaming", async () => {
  const { file } = await fixture();
  const win = await readEventsWindow(file, { branch: "br2", limit: 10 });
  const all = await readEvents(file);
  assert.deepEqual(win.events.map((e) => e.id), filterByBranch(all, "br2", false).map((e) => e.id));
  assert.ok(win.events.length > 0, "the fixture must contain br2 events or this test proves nothing");
});

test("branch counts treat the fork as the new branch's metadata, not as its parent's content", async () => {
  const { file } = await fixture();
  const counts = await branchCounts(file);
  const all = await readEvents(file);
  const br0 = filterByBranch(all, "br0", false);
  const forksInBr0 = br0.filter((e) => e.type === "fork").length;
  assert.equal(forksInBr0, 1, "the fixture must contain the fork or this comparison is vacuous");
  assert.equal(counts.get("br0")?.events, br0.length - forksInBr0, "a fork is not counted as its parent's content");
  assert.equal(counts.get("br2")?.events, filterByBranch(all, "br2", false).length);
  assert.equal(counts.get("br2")?.forkedFrom !== undefined, true, "the fork that created br2 is reported");
});
