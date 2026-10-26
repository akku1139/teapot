/**
 * #131 — "while thinking, switch to another session and come back, and for a moment
 * it shows `thinking 497531h 23m`."
 *
 * ## The number is the giveaway
 *
 * `497531h` is `Date.now()` interpreted as a duration — i.e. elapsed time since the
 * **epoch**. So `startedAt` was 0 while `now()` was the real clock.
 *
 * `0` is the sentinel for "the timer was never armed", and it is the state
 * immediately after a session switch: the prune effect zeroes `thinkStartedAt`
 * whenever `agents()` changes, and the first reasoning delta of the newly
 * selected session has not arrived yet. The old readout rendered
 * `now() - props.startedAt` unconditionally, so for those few hundred
 * milliseconds it showed the epoch. Self-correcting, which is exactly the
 * report's "数秒で治る" (fixes itself in seconds).
 *
 * Two fixes, because the epoch flash was a symptom of two defects:
 *
 *  1. `ThinkingTimer` renders nothing while `startedAt` is 0. A sentinel is not a
 *     timestamp, so it must not be subtracted from one.
 *  2. the clock reset on a delta carrying NEITHER text nor reasoning — which
 *     providers send between chunks — so the readout also flickered out
 *     mid-thought. It now resets only when real text arrives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _here = path.dirname(fileURLToPath(import.meta.url));

/* ---------- the readout ---------- */

/* ---------- the clock bookkeeping ---------- */


/*
 * #131 (recurrence) — the clock was zeroed by a status sweep, not by the stream.
 *
 * The original #131 was a session switch leaving `startedAt = 0` while the 💭 block was
 * visible, so `now() - 0` rendered as elapsed-since-the-EPOCH ("thinking 497531h").
 * The sentinel guard on the timer stopped that one path, but the CLOCK was still being
 * zeroed from the effect that runs on every `agents()` change — and a status transition
 * is exactly what happens when thinking ENDS:
 *
 *     reasoning arrives         -> startedAt = T
 *     the turn's status flips   -> the sweep zeroes it
 *     the block is still shown  -> now() - 0 -> "thinking 497531h 23m"
 *
 * reported as appearing "reasoning が終わった瞬間" with NO session switch.
 *
 * The clock now may only be cleared when the block it measures is gone.
 */
import { clearThinkClockIfDone } from "../frontend/lib/live-buffer.ts";

const agent = (status: string) => ({ id: "a1", status, session: "s1" });
const bubble = (text = "", reasoning = "") => ({ text, reasoning });

test("a STATUS change alone must not clear the thinking clock (#131)", () => {
  // this is the reported case: reasoning finished, so the status flipped, and the
  // elapsed readout jumped to 497531h while the block was still rendered
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
  // re-arming on the next chunk would restart an elapsed time the operator is reading
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
  // a deleted/renamed agent cannot be mid-thought; leaving the clock armed would
  // strand the timer
  assert.equal(clearThinkClockIfDone(1_700_000_000_000, [], "gone", null), 0);
});
