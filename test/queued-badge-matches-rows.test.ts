import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimelineWithCount } from "../frontend/lib/timeline.ts";

/**
 * The ⏳ badge must count the rows the feed is DRAWING.
 *
 * Reported twice: "⏳ 1 message queued" with nothing queued in the feed, and it only cleared after
 * visiting another session and coming back. The count came from client memory (`pendingMsgs()`)
 * while the rows came from the LOG (`remainingEchoes` consults `prompt-delivered` notes). Any state
 * where those disagreed showed a badge over a feed with no queued row in it.
 *
 * The fix is not "also check the log" in a second place — that is how they drifted. Both come out
 * of ONE pipeline run, so the disagreement is unrepresentable. These tests drive the real pipeline.
 */
const echo = (p: { id: string; text: string; at: number; promptId?: string }) => ({
  type: "message",
  seq: 1e9 + p.at,
  id: `echo-${p.id}`,
  ts: new Date(p.at).toISOString(),
  agent: "a1",
  session: "s1",
  branch: "br0",
  data: { role: "user", content: p.text, echo: true },
});

const input = (events: any[], pending: any[]) => ({
  events,
  consumed: new Set<string>(),
  pending: pending.map((p) => ({ sent: false, ...p })),
  echo,
  feedTypes: new Set(["user", "message", "prompt", "system_note"]),
  renderedTypes: new Set(["user", "message", "prompt"]),
  renderedNoteEvents: new Set<string>(),
});

const deliveredNote = (pid: string) => ({
  type: "system_note",
  seq: 10,
  id: `n-${pid}`,
  ts: "2026-01-01T00:00:00Z",
  agent: "a1",
  session: "s1",
  branch: "br0",
  data: { event: "prompt-delivered", promptId: pid, preview: "x" },
});

const loggedPrompt = (pid: string, text: string) => ({
  type: "prompt",
  seq: 9,
  id: `p-${pid}`,
  ts: "2026-01-01T00:00:00Z",
  agent: "a1",
  session: "s1",
  branch: "br0",
  data: { source: "user", text, promptId: pid },
});

test("a stale echo with no queued row is NOT counted (#echo)", () => {
  // the exact reported state: memory still holds an echo, the log says it was delivered
  const pid = "p-delivered";
  const { rows, pendingCount } = buildTimelineWithCount(
    input([loggedPrompt(pid, "hello"), deliveredNote(pid)], [{ id: "e1", text: "hello", at: 1, promptId: pid }]),
  );
  const echoRows = rows.filter((r) => (r.data as any)?.echo);
  assert.equal(echoRows.length, 0, "the feed draws no queued row for a delivered prompt");
  assert.equal(pendingCount, 0, "so the badge must say 0 — this WAS 1, and stayed 1");
});

test("an echo the log has NOT seen is counted, and drawn (#echo)", () => {
  const { rows, pendingCount } = buildTimelineWithCount(
    input([], [{ id: "e1", text: "still waiting", at: 1, promptId: "p-queued" }]),
  );
  assert.equal(rows.filter((r) => (r.data as any)?.echo).length, 1, "the queued row is drawn");
  assert.equal(pendingCount, 1, "and the badge agrees with it");
});

test("the count equals the number of echo rows, for every combination (#echo)", () => {
  // the invariant, driven rather than asserted case by case
  const states = [0, 1, 2].flatMap((n) =>
    [0, 1, 2].map((delivered) => {
      const pending = Array.from({ length: n }, (_, i) => ({
        id: `e${i}`,
        text: `m${i}`,
        at: i + 1,
        promptId: `p${i}`,
      }));
      const events = pending
        .slice(0, delivered)
        .flatMap((p) => [loggedPrompt(p.promptId!, p.text), deliveredNote(p.promptId!)]);
      return { pending, events, label: `${n} pending / ${delivered} delivered` };
    }),
  );
  for (const s of states) {
    const { rows, pendingCount } = buildTimelineWithCount(input(s.events, s.pending));
    const drawn = rows.filter((r) => (r.data as any)?.echo).length;
    assert.equal(pendingCount, drawn, `badge and rows disagree for ${s.label}`);
  }
});
