import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimelineWithCount } from "../frontend/lib/timeline.ts";
import { queuedBadgeCount, serverQueuedCount } from "../frontend/lib/queued-count.ts";

const take = (server: { queue?: string[]; ids?: string[]; count?: number }): number =>
  serverQueuedCount({ pendingPromptQueue: server.queue, pendingPromptIds: server.ids, pendingPrompts: server.count });

test("an empty queue array does NOT hide a non-zero count (#queue)", () => {
  assert.equal(take({ queue: [], ids: [], count: 3 }), 3, "`?? 0` on an empty array must not win");
  assert.equal(take({ count: 2 }), 2, "a server that only reports the count still counts");
  assert.equal(take({ ids: ["a"], count: 0 }), 1, "and one that only reports ids");
  assert.equal(take({ queue: ["a", "b"] }), 2, "the richest field is the most accurate");
});

test("all-empty is genuinely zero (#queue)", () => {
  assert.equal(take({ queue: [], ids: [], count: 0 }), 0);
});

const echo = (pid: string, text = "hi") => ({ id: `e-${pid}`, promptId: pid, text, at: 1, sent: false });
const input = (events: any[], pending: any[]) => ({
  events,
  consumed: new Set<string>(),
  pending: pending.map((p) => ({ sent: false, ...p })),
  echo: (p: any) => ({ type: "message", id: p.id, seq: 1e9, ts: "", agent: "a", session: "s1", branch: "b", data: { echo: true, content: p.text } }),
  feedTypes: new Set(["prompt", "system_note", "message"]),
  renderedTypes: new Set(["prompt", "message"]),
  renderedNoteEvents: new Set<string>(),
});
const loggedPrompt = (pid: string) => ({ type: "prompt", seq: 1, id: `p-${pid}`, ts: "", agent: "a", session: "s1", branch: "b", data: { source: "user", text: "hi", promptId: pid } });
const note = (pid: string) => ({ type: "system_note", seq: 2, id: `n-${pid}`, ts: "", agent: "a", session: "s1", branch: "b", data: { event: "prompt-delivered", promptId: pid } });

