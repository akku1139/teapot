import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _here = path.dirname(fileURLToPath(import.meta.url));

import { clearThinkClockIfDone } from "../frontend/lib/live-buffer.ts";

const agent = (status: string) => ({ id: "a1", status, session: "s1" });
const bubble = (text = "", reasoning = "") => ({ text, reasoning });

test("a STATUS change alone must not clear the thinking clock (#131)", () => {
  const startedAt = 1_700_000_000_000;
  assert.equal(
    clearThinkClockIfDone(startedAt, [agent("running")], "a1", bubble("", "thinking…")),
    startedAt,
    "the bubble is still on screen, so the clock is still meaningful",
  );
  assert.equal(
    clearThinkClockIfDone(startedAt, [agent("idle")], "a1", bubble("", "thinking…")),
    startedAt,
    "and a flip to idle must not zero it either — the block is what it measures",
  );
});

test("the clock clears once the bubble is gone and the agent is idle (#131)", () => {
  const startedAt = 1_700_000_000_000;
  assert.equal(
    clearThinkClockIfDone(startedAt, [agent("idle")], "a1", null),
    0,
    "nothing left to time",
  );
});

test("an unarmed clock stays unarmed (#131)", () => {
  assert.equal(clearThinkClockIfDone(0, [agent("running")], "a1", null), 0, "0 is the sentinel");
});

test("a mid-turn agent keeps its clock even with no bubble yet (#131)", () => {
  const startedAt = 1_700_000_000_000;
  assert.equal(
    clearThinkClockIfDone(startedAt, [agent("running")], "a1", null),
    startedAt,
    "reasoning may resume in the same turn",
  );
  assert.equal(
    clearThinkClockIfDone(startedAt, [agent("waiting")], "a1", null),
    startedAt,
    "a parked ask_user is still the same turn",
  );
});

test("no selected agent clears the clock (#131)", () => {
  assert.equal(clearThinkClockIfDone(1_700_000_000_000, [], null, null), 0);
});

test("an agent that disappeared from the snapshot clears it (#131)", () => {
  assert.equal(clearThinkClockIfDone(1_700_000_000_000, [], "gone", null), 0);
});
