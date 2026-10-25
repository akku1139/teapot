import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Master } from "../src/master.ts";

/**
 * Listing archived agents counts each entry's sessions correctly.
 *
 * The reported slowness ("🗄 archive のロードが遅すぎる") was `sessionsOf()` per entry, which ran a
 * full session scan each time. The fix scans once — so what has to be true is that the COUNTS are
 * still right, which is what this drives. It replaces a test that compared the method's source text
 * and therefore passed while the count was wrong.
 */
test("archivedAgents reports each entry's session count and parent link (#perf)", () => {
  const dir = mkdtempInRootSync("archived-agents-");
  const sessions = path.join(dir, "sessions");
  // three sessions for `keep`, two for `shelved`; the abandoned one has no session dir at all
  for (const [session, agent] of [
    ["keep-a", "keep"],
    ["keep-b", "keep"],
    ["keep-c", "keep"],
    ["shelved-a", "shelved"],
    ["shelved-b", "shelved"],
  ]) {
    mkdirSync(path.join(sessions, session), { recursive: true });
    writeFileSync(path.join(sessions, session, "chat.jsonl"), JSON.stringify({ type: "user", seq: 1, agent, session, branch: "br0", data: { content: "hi" } }) + "\n");
  }
  const master = new Master(
    {
      port: 0,
      dataDir: dir,
      llm: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
      providers: { p: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" } },
      defaultProvider: "p",
      agents: [
        { id: "keep", workspace: dir, provider: "p", session: "keep-a" },
        { id: "shelved", workspace: dir, provider: "p", session: "shelved-a", archived: true, archivedAt: 1000 },
        // an archived sub-agent of `shelved`: listed as a child, not as an equal entry
        { id: "shelved-sub", workspace: dir, provider: "p", session: "gone", archived: true, parent: "shelved", archivedAt: 2000 },
        { id: "no-sessions", workspace: dir, provider: "p", archived: true, archivedAt: 3000 },
      ],
    } as never,
    path.join(dir, "config.json"),
  );
  const listed = master.archivedAgents();

  const byId = new Map(listed.map((a) => [a.id, a]));
  assert.deepEqual([...byId.keys()].sort(), ["no-sessions", "shelved", "shelved-sub"], "only archived entries");
  assert.equal(byId.get("shelved")?.sessions, 2, "two sessions belong to `shelved`");
  assert.equal(byId.get("no-sessions")?.sessions, 0, "an entry with no session dir counts zero, not an error");
  assert.equal(byId.get("shelved-sub")?.parent, "shelved", "a sub-agent names its archived parent");
  assert.equal(byId.get("shelved")?.parent, undefined, "a top-level entry has no parent");
  assert.equal(byId.get("shelved")?.subs, 1, "and the parent counts the archived child under it");
  // newest first, which is what the panel shows
  assert.deepEqual(listed.map((a) => a.id), ["no-sessions", "shelved-sub", "shelved"], "sorted by archivedAt desc");
});
