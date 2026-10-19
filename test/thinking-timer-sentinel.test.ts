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

