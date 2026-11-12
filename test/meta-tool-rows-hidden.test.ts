/**
 * A meta tool whose result is already a row of its own must not also render its call.
 *
 * `set_goal` writes a goal event that renders as the goal card, but when the call goes through `answerMeta` (a progress
 * request, a refused turn) it is also logged as a `tool_call`, so the timeline showed the goal card AND a tool row repeating
 * the same arguments — reported as "set_goal はgoal cardsによって表示されるのでツールログは出さなくていい".
 *
 * The neighbouring cases pin the boundary: a REAL tool call must still render, or the filter would hide work.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { feedCandidates } from "../frontend/lib/timeline.ts";

const FEED = new Set(["tool_call", "tool_result", "message", "goal", "prompt"]);
const RENDERED = new Set(["tool_call", "tool_result", "message", "goal", "prompt"]);

function run(names: string[]) {
  const events = names.map((name, i) => ({
    id: `e${i}`,
    seq: i + 1,
    type: "tool_call",
    agent: "a",
    session: "s",
    branch: "main",
    ts: "2026-01-01T00:00:00.000Z",
    data: { name, args: {} },
  }));
  return feedCandidates({
    events: events as never,
    pending: [],
    consumed: new Set<string>(),
    feedTypes: FEED,
    renderedTypes: RENDERED,
    renderedNoteEvents: new Set<string>(),
    echo: (p) => p as never,
  }).map((e) => String((e.data as { name?: string }).name));
}

test("a goal/todo write is not also a tool row", () => {
  assert.deepEqual(run(["set_goal", "set_goal_verify", "set_todo"]), []);
});

test("real tools still render", () => {
  assert.deepEqual(run(["bash", "read_file", "write_file"]), ["bash", "read_file", "write_file"]);
});

test("the rest of the meta tools stay hidden too", () => {
  assert.deepEqual(run(["report_progress", "ask_operator", "record_decision", "ask_user"]), []);
});
